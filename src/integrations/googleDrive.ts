import type { DriveBackupPayload } from "../types";

const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
  "profile",
].join(" ");
const BACKUP_FILE_NAME = "boulder-load-manager-backup.json";

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken: (options?: { prompt?: string }) => void;
}

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

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let scriptPromise: Promise<void> | undefined;

function loadGoogleIdentityScript(): Promise<void> {
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src=\"${GOOGLE_IDENTITY_SCRIPT}\"]`,
    );

    if (existing) {
      if (window.google?.accounts?.oauth2) {
        resolve();
        return;
      }

      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity script.")));
      return;
    }

    const script = document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity script."));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export async function authorizeGoogleDrive(
  clientId: string,
  prompt: "consent" | "" = "consent",
): Promise<GoogleAuthSession> {
  if (!clientId) {
    throw new Error("Missing VITE_GOOGLE_CLIENT_ID. Add it in Vercel environment variables.");
  }

  await loadGoogleIdentityScript();

  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error("Google OAuth client could not be initialized."));
      return;
    }

    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response: TokenResponse) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || "Google authorization failed."));
          return;
        }

        resolve({
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        });
      },
    });

    tokenClient.requestAccessToken({ prompt });
  });
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Google profile.");
  }

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
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error("Failed to query Google Drive backup files.");
  }

  const payload = (await response.json()) as { files?: DriveFile[] };
  return payload.files?.[0]?.id;
}

function createMultipartBody(payload: DriveBackupPayload): { body: string; boundary: string } {
  const boundary = `boundary_${Date.now()}`;
  const metadata = {
    name: BACKUP_FILE_NAME,
    mimeType: "application/json",
    parents: ["root"],
  };

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

  if (!response.ok) {
    throw new Error("Failed to upload backup to Google Drive.");
  }
}

export async function downloadBackupFromGoogleDrive(accessToken: string): Promise<DriveBackupPayload> {
  const fileId = await findBackupFileId(accessToken);

  if (!fileId) {
    throw new Error("No backup file found in Google Drive.");
  }

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to download backup from Google Drive.");
  }

  const payload = (await response.json()) as DriveBackupPayload;

  if (!payload.version || !payload.settings || !Array.isArray(payload.sessions)) {
    throw new Error("Backup payload is invalid.");
  }

  return payload;
}
