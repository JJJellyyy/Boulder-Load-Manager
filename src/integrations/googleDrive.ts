import type { DriveBackupPayload } from "../types";

const DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
  "profile",
].join(" ");
const BACKUP_BASE_NAME = "boulder-load-manager-backup";
const MAX_BACKUP_COPIES = 5;
const CODE_VERIFIER_KEY = "google_oauth_code_verifier";

export interface GoogleAuthSession {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

/** Redirect the browser to Google's OAuth consent page using an implicit-token flow for the browser app. */
export async function initiateGoogleOAuthRedirect(clientId: string): Promise<void> {
  const redirectUri = window.location.origin + "/";

  console.log("OAuth Debug Info:", {
    clientId: clientId.split(".")[0] + "...",
    redirectUri,
    flow: "implicit token flow",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: DRIVE_SCOPE,
    prompt: "consent",
    include_granted_scopes: "true",
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Check if Google redirected back to us with an auth code in the URL query.
 * Exchanges the code for an access token via a backend endpoint.
 * Returns session on success, throws an error string if Google returned an error,
 * or returns null if no OAuth response is present.
 */
export async function extractOAuthTokenFromUrl(clientId: string): Promise<GoogleAuthSession | null> {
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  const error = searchParams.get("error") ?? hashParams.get("error");
  if (error) {
    window.history.replaceState(null, "", window.location.pathname);

    const errorDescription = searchParams.get("error_description") ?? hashParams.get("error_description") ?? "";
    let helpText = "";

    if (error === "invalid_client") {
      helpText = "\n\nTo fix this:\n1. Go to Google Cloud Console → APIs & Services → Credentials\n2. Edit your OAuth 2.0 Client ID (Web application)\n3. Ensure the Redirect URI is set to: " + window.location.origin + "/\n4. Check that JavaScript Origins includes: " + window.location.origin;
    }

    throw new Error(`Google OAuth error: ${error} — ${errorDescription}${helpText}`);
  }

  const accessToken = hashParams.get("access_token");
  if (accessToken) {
    const expiresIn = Number(hashParams.get("expires_in") ?? "3600");
    window.history.replaceState(null, "", window.location.pathname);
    return {
      accessToken,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    };
  }

  const code = searchParams.get("code");
  if (!code) return null;

  const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
  if (!codeVerifier) {
    throw new Error("OAuth session lost. Please try again.");
  }

  window.history.replaceState(null, "", window.location.pathname);
  sessionStorage.removeItem(CODE_VERIFIER_KEY);

  const redirectUri = window.location.origin + "/";
  const response = await fetch("/api/oauth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange auth code for token: ${errorText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Failed to fetch Google profile.");
  return (await response.json()) as GoogleProfile;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  createdTime?: string;
}
async function findBackupFiles(accessToken: string): Promise<DriveFile[]> {
  const query = encodeURIComponent(
    `name contains '${BACKUP_BASE_NAME}' and trashed=false and 'root' in parents`,
  );
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime,createdTime)&orderBy=createdTime desc&pageSize=10`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error("Failed to query Google Drive backup files.");
  const payload = (await response.json()) as { files?: DriveFile[] };
  return payload.files ?? [];
}

async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Failed to delete old backup file from Google Drive.");
}

export async function uploadBackupToGoogleDrive(
  accessToken: string,
  payload: DriveBackupPayload,
): Promise<void> {
  // Create a timestamped backup copy instead of overwriting a single file.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${BACKUP_BASE_NAME}-${ts}.json`;
  const boundary = `boundary_${Date.now()}`;
  const metadata = { name: filename, mimeType: "application/json", parents: ["root"] };
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(payload),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) throw new Error("Failed to upload backup to Google Drive.");

  // Cleanup old backups beyond the configured limit
  try {
    const files = await findBackupFiles(accessToken);
    if (files.length > MAX_BACKUP_COPIES) {
      const toDelete = files.slice(MAX_BACKUP_COPIES);
      for (const f of toDelete) {
        if (f.id) await deleteDriveFile(accessToken, f.id);
      }
    }
  } catch (err) {
    // Non-fatal: log in caller; do not fail upload because cleanup failed.
  }
}

export async function downloadBackupFromGoogleDrive(accessToken: string): Promise<DriveBackupPayload> {
  const files = await findBackupFiles(accessToken);
  if (files.length === 0) throw new Error("No backup file found in Google Drive.");
  const fileId = files[0].id;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Failed to download backup from Google Drive.");
  const payload = (await response.json()) as DriveBackupPayload;
  if (!payload.version || !payload.settings || !Array.isArray(payload.sessions)) {
    throw new Error("Backup payload is invalid.");
  }
  return payload;
}
