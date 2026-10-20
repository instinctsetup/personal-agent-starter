/** Lock a secret file down as tightly as the OS allows. POSIX chmod 600 restricts nothing
 * useful on NTFS - on Windows the ACL is the only real control, so we set it explicitly. */
import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";

export function secureFile(path: string): void {
  try { chmodSync(path, 0o600); } catch { /* best effort - still correct on POSIX */ }
  if (process.platform !== "win32") return;
  try {
    const user = process.env.USERNAME || os.userInfo().username;
    // Strip inherited permissions, then grant full control only to the current user
    // and the built-in Administrators group (S-1-5-32-544). Nobody else on the machine
    // (other local accounts, "Users" group defaults) can read this file afterward.
    execFileSync("icacls", [path, "/inheritance:r"], { stdio: "ignore", windowsHide: true });
    execFileSync("icacls", [path, "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    execFileSync("icacls", [path, "/grant:r", "*S-1-5-32-544:F"], { stdio: "ignore", windowsHide: true });
  } catch {
    console.warn(`[vault] could not apply Windows ACLs to ${path} - it is protected only by default NTFS permissions on this folder. Consider moving ./data outside any shared/OneDrive-synced location.`);
  }
}
