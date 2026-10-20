/** Build identity, resolved once at startup. The UI and the `version` command both
 *  read this so "which build is he running?" is never a guessing game again. */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
  } catch {
    return "";
  }
}

export type AppVersion = { version: string; commit: string; commitDate: string; startedAt: string };

export function appVersion(): AppVersion {
  let version = "2.0";
  try {
    version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version || version;
  } catch { /* keep default */ }
  return {
    version,
    commit: git("rev-parse --short HEAD") || "unknown",
    commitDate: git("log -1 --format=%cs") || "",
    startedAt: new Date().toISOString(),
  };
}

export const APP_VERSION: AppVersion = appVersion();
