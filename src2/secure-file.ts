/** Lock a secret file down as tightly as the OS allows. POSIX chmod 600 restricts nothing
 * useful on NTFS - on Windows the ACL is the only real control, so we set it explicitly. */
import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

/** Absolute-path-first candidates: a bare "icacls" lookup can fail with spawn ENOENT on
 * a technically-healthy Windows 11 laptop with a broken/unusual PATH (the same class of
 * machine winops.ts hardens PowerShell against). */
function icaclsCandidates(): string[] {
  const root = process.env.SystemRoot || "C:\\Windows";
  return [`${root}\\System32\\icacls.exe`, "icacls.exe", "icacls"];
}

function runIcacls(args: string[]): void {
  let lastErr: unknown;
  for (const exe of icaclsCandidates()) {
    try { execFileSync(exe, args, { stdio: "ignore", windowsHide: true }); return; }
    catch (e) { lastErr = e; if (!/ENOENT/i.test(String((e as any)?.message || e))) throw e; }
  }
  throw lastErr;
}

export function secureFile(path: string): void {
  try { chmodSync(path, 0o600); } catch { /* best effort - still correct on POSIX */ }
  if (process.platform !== "win32") return;
  try {
    const user = process.env.USERNAME || os.userInfo().username;
    // Strip inherited permissions, then grant full control only to the current user
    // and the built-in Administrators group (S-1-5-32-544). Nobody else on the machine
    // (other local accounts, "Users" group defaults) can read this file afterward.
    // Caveat: this hardens the FILE; the parent folder's default ACL still lets another
    // local admin delete-and-regenerate it - acceptable on a single-user laptop.
    runIcacls([path, "/inheritance:r"]);
    runIcacls([path, "/grant:r", `${user}:F`]);
    runIcacls([path, "/grant:r", "*S-1-5-32-544:F"]);
  } catch {
    console.warn(`[vault] could not apply Windows ACLs to ${path} - it is protected only by default NTFS permissions on this folder. Consider moving ./data outside any shared/OneDrive-synced location.`);
  }
}
