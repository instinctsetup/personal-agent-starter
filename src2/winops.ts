/** Windows-first local machine tools: system info, clipboard, allow-listed app launcher.
 *  No new dependencies - everything goes through node:os / node:fs / child_process.
 *  Read-only or non-destructive by design; destructive file tools live behind approval cards. */
import os from "node:os";
import { statfsSync } from "node:fs";
import { execFile } from "node:child_process";

function run(cmd: string, args: string[], input?: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(String(stdout ?? ""));
    });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function fmtBytes(n: number): string {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`;
}

async function batteryLine(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const out = await run("powershell", ["-NoProfile", "-Command",
      "(Get-CimInstance Win32_Battery | Measure-Object -Property EstimatedChargeRemaining -Average).Average"]);
    const pct = Math.round(Number(out.trim()));
    if (!Number.isFinite(pct)) return null;
    const status = await run("powershell", ["-NoProfile", "-Command",
      "(Get-CimInstance Win32_Battery).BatteryStatus"]);
    const charging = status.trim() === "2";
    return `Battery: ${pct}%${charging ? " (charging)" : ""}`;
  } catch {
    return null; // desktops have no battery - fine
  }
}

/** One human-readable snapshot: CPU, RAM, disk, uptime, battery (when present). */
export async function systemInfo(): Promise<string> {
  const lines: string[] = [];
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = Math.round(((total - free) / total) * 100);
  lines.push(`RAM: ${fmtBytes(total - free)} used of ${fmtBytes(total)} (${usedPct}%)`);
  const cpus = os.cpus();
  lines.push(`CPU: ${cpus[0]?.model?.trim() || "unknown"} (${cpus.length} threads), load ${os.loadavg().map((n) => n.toFixed(1)).join(" / ")}`);
  try {
    const s = statfsSync(process.cwd());
    lines.push(`Disk (${process.cwd().slice(0, 2) === "\\\\" ? "share" : process.cwd().split(/[\\/]/)[0] || "C:"}): ${fmtBytes(s.bavail * s.bsize)} free of ${fmtBytes(s.blocks * s.bsize)}`);
  } catch { /* statfs unsupported - skip disk line */ }
  const up = os.uptime();
  lines.push(`Uptime: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`);
  const battery = await batteryLine();
  if (battery) lines.push(battery);
  return lines.join("\n");
}

/** Read the text clipboard. Empty string when the clipboard holds no text. */
export async function clipboardRead(): Promise<string> {
  if (process.platform === "win32") {
    const out = await run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"]);
    return out.replace(/\r?\n$/, "");
  }
  if (process.platform === "darwin") return run("pbpaste", []);
  return run("xclip", ["-selection", "clipboard", "-o"]);
}

/** Copy text to the clipboard. Non-destructive; the write is traced like any tool call. */
export async function clipboardWrite(text: string): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell", ["-NoProfile", "-Command", "$input | Set-Clipboard"], text);
    return;
  }
  if (process.platform === "darwin") {
    await run("pbcopy", [], text);
    return;
  }
  await run("xclip", ["-selection", "clipboard", "-i"], text);
}

/** Pre-registered apps only - never an arbitrary exe path from chat text. */
const APP_ALLOWLIST: Record<string, { win32: string; linux?: string; darwin?: string; label: string }> = {
  chrome:    { win32: "chrome",    linux: "google-chrome", darwin: "Google Chrome", label: "Chrome" },
  edge:      { win32: "msedge",    label: "Edge" },
  firefox:   { win32: "firefox",   linux: "firefox",       darwin: "Firefox",       label: "Firefox" },
  notepad:   { win32: "notepad",   linux: "gedit",         label: "Notepad" },
  calculator:{ win32: "calc",      linux: "gnome-calculator", label: "Calculator" },
  calc:      { win32: "calc",      linux: "gnome-calculator", label: "Calculator" },
  vscode:    { win32: "code",      linux: "code",          darwin: "Visual Studio Code", label: "VS Code" },
  code:      { win32: "code",      linux: "code",          darwin: "Visual Studio Code", label: "VS Code" },
  explorer:  { win32: "explorer",  label: "File Explorer" },
  spotify:   { win32: "spotify",   darwin: "Spotify",      label: "Spotify" },
};

export function knownApps(): string[] {
  return [...new Set(Object.values(APP_ALLOWLIST).map((a) => a.label))];
}

export function isKnownApp(name: string): boolean {
  return name.toLowerCase() in APP_ALLOWLIST;
}

/** Launch an allow-listed app (optionally with a file argument). Returns the label launched. */
export async function launchApp(name: string, fileArg?: string): Promise<string> {
  const spec = APP_ALLOWLIST[name.toLowerCase()];
  if (!spec) {
    throw new Error(`"${name}" is not on the app list. I can open: ${knownApps().join(", ")}. I never run arbitrary programs from chat.`);
  }
  const plat = process.platform;
  if (plat === "win32") {
    // `start` returns immediately and resolves apps from PATH/App Paths registry keys.
    const args = ["/c", "start", "", spec.win32];
    if (fileArg) args.push(fileArg);
    await run("cmd", args, undefined, 5000);
  } else if (plat === "darwin" && spec.darwin) {
    await run("open", ["-a", spec.darwin, ...(fileArg ? [fileArg] : [])], undefined, 5000);
  } else if (spec.linux) {
    // Fire and forget: detached so the daemon never waits on the app's lifetime.
    const { spawn } = await import("node:child_process");
    const child = spawn(spec.linux, fileArg ? [fileArg] : [], { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    throw new Error(`${spec.label} is not available on this platform.`);
  }
  return spec.label;
}
