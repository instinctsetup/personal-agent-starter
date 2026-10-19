/** Google Drive/Docs sync via OAuth refresh token (stored through `connect drive`).
 *  Plain REST, no SDK: token exchange, file list, upload, create-doc-from-text, folder sync. */
import { getSetting } from "./db.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";

export type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };

function driveCreds(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  const clientId = getSetting("drive_client_id"), clientSecret = getSetting("drive_client_secret"), refreshToken = getSetting("drive_refresh_token");
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}
export function driveConfigured(): boolean { return driveCreds() !== null; }

async function accessToken(): Promise<string> {
  const c = driveCreds();
  if (!c) throw new Error("Drive not connected - say `connect drive` (needs OAuth client id/secret + refresh token).");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  const d = await res.json() as any;
  if (!d.access_token) throw new Error("Drive token exchange failed");
  return d.access_token;
}

export async function listDriveFiles(limit = 20): Promise<DriveFile[]> {
  const tok = await accessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?pageSize=${limit}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime desc`,
    { headers: { authorization: `Bearer ${tok}` } });
  const d = await res.json() as any;
  return d.files || [];
}

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".mp4": "video/mp4", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".png": "image/png", ".jpg": "image/jpeg" };
export function mimeFor(path: string): string { return MIME[extname(path).toLowerCase()] || "application/octet-stream"; }

/** Upload a local file; when `asGoogleDoc` is set, convert text/markdown into a Google Doc. */
export async function uploadToDrive(path: string, opts: { name?: string; asGoogleDoc?: boolean } = {}): Promise<DriveFile> {
  const tok = await accessToken();
  const bytes = readFileSync(path);
  const name = opts.name || basename(path);
  const metadata: Record<string, unknown> = { name };
  if (opts.asGoogleDoc) metadata.mimeType = "application/vnd.google-apps.document";
  const boundary = "agent-drive-" + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${mimeFor(path)}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink",
    { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` }, body });
  const d = await res.json() as any;
  if (!res.ok) throw new Error(d.error?.message || `Drive upload ${res.status}`);
  return d as DriveFile;
}

/** Decide which local files need uploading: new names or newer mtime than the Drive copy. Pure + testable. */
export function planSync(localDir: string, remote: DriveFile[]): { upload: string[]; skip: string[] } {
  const remoteByName = new Map(remote.map((f) => [f.name, f]));
  const upload: string[] = [], skip: string[] = [];
  for (const name of readdirSync(localDir)) {
    const p = join(localDir, name);
    if (!statSync(p).isFile()) continue;
    const r = remoteByName.get(name);
    if (!r) { upload.push(p); continue; }
    const localMtime = statSync(p).mtimeMs;
    const remoteMtime = r.modifiedTime ? new Date(r.modifiedTime).getTime() : 0;
    if (localMtime > remoteMtime + 1000) upload.push(p); else skip.push(p);
  }
  return { upload, skip };
}

export async function syncFolder(localDir: string): Promise<{ uploaded: string[]; skipped: string[]; links: string[] }> {
  const remote = await listDriveFiles(100);
  const plan = planSync(localDir, remote);
  const links: string[] = [];
  for (const p of plan.upload) {
    const f = await uploadToDrive(p);
    if (f.webViewLink) links.push(f.webViewLink);
  }
  return { uploaded: plan.upload.map((p) => basename(p)), skipped: plan.skip, links };
}
