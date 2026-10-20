import { DATA_DIR } from "./db.js";

const CLOUD_SYNC_MARKERS = [/onedrive/i, /icloud ?drive/i, /\bdropbox\b/i, /google ?drive/i];

/** Warn (does not block startup) if ./data lives inside a folder a cloud-sync client
 * actively watches. WAL-mode SQLite + a background syncer racing on db-wal/db-shm is a
 * known corruption vector - this is the single most common way a Windows laptop install
 * of this app silently loses its vault/tracker/memory data. */
export function warnIfCloudSynced(): string | null {
  const normalized = DATA_DIR.replace(/\\/g, "/").toLowerCase();
  if (CLOUD_SYNC_MARKERS.some((re) => re.test(normalized))) {
    const msg = [
      `WARNING: your data folder (${DATA_DIR}) appears to be inside a cloud-synced directory`,
      "(OneDrive/Dropbox/iCloud/Google Drive). SQLite's WAL mode plus a background file syncer",
      "is a known way to silently corrupt the database.",
      "",
      "Fix: set AGENT_DATA_DIR to a non-synced path, e.g. in a .env file:",
      "  AGENT_DATA_DIR=C:\\PersonalAgentData",
      "then restart. Your existing ./data folder can be copied there once while the app is stopped.",
    ].join("\n");
    console.warn(msg);
    return msg;
  }
  return null;
}
