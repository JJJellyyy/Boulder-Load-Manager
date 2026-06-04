import type { DriveBackupPayload } from "../types";

const DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
  "profile",
].join(" ");
const BACKUP_FILE_NAME = "boulder-load-manager-backup.json";

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

/** Redirect the browser to Google's OAuth consent page. Returns after redirect — caller never resumes. */
export function initiateGoogleOAuthRedirect(clientId: string): void {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: window.location.origin,
    response_type: "token",
    scope: DRIVE_SCOPE,
    prompt: "consent",
    include_granted_scopes: "true",
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Check if Google redirected back to us with a token in the URL hash.
 * Returns session on success, throws an error string if Google returned an error,
 * or returns null if no OAuth response is present.
 */
export function extractOAuthTokenFromUrl(): GoogleAuthSession | null {
  const hash = window.location.hash.substring(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);

  const error = params.get("error");
  if (error) {
    // Clean up the URL
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    throw new Error(`Google OAuth error: ${error} — ${params.get("error_description") ?? ""}`);
  }

  const accessToken = params.get("access_token");
  const expiresIn = params.get("expires_in");
  if (!accessToken) return null;
  // Clean token out of the URL bar
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return {
    accessToken,
    expiresAt: Date.now() + parseInt(expiresIn ?? "3600") * 1000,
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
  modifiedTime: string;
}

async function findBackupFileId(accessToken: string): Promise<string | undefined> {
  const query = encodeURIComponent(
    `name='${BACKUP_FILE_NAME}' and trashed=false and 'root' in parents`,
  );
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error("Failed to query Google Drive backup files.");
  const payload = (await response.json()) as { files?: DriveFile[] };
  return payload.files?.[0]?.id;
}

function createMultipartBody(payload: DriveBackupPayload): { body: string; boundary: string } {
  const boundary = `boundary_${Date.now()}`;
  const metadata = { name: BACKUP_FILE_NAME, mimeType: "application/json", parents: ["root"] };
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
  return { body, boundary };
}

export async function uploadBackupToGoogleDrive(
  accessToken: string,
  payload: DriveBackupPayload,
): Promise<void> {
  const fileId = await findBackupFileId(accessToken);
  const { body, boundary } = createMultipartBody(payload);
  const endpoint = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const method = fileId ? "PATCH" : "POST";
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) throw new Error("Failed to upload backup to Google Drive.");
}

export async function downloadBackupFromGoogleDrive(accessToken: string): Promise<DriveBackupPayload> {
  const fileId = await findBackupFileId(accessToken);
  if (!fileId) throw new Error("No backup file found in Google Drive.");
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
