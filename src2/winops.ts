/** Windows-first local machine tools: system info, clipboard, allow-listed app launcher.
 *  No new dependencies - everything goes through node:os / node:fs / child_process.
 *  Read-only or non-destructive by design; destructive file tools live behind approval cards. */
import os from "node:os";
import { statfsSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

/** PowerShell executables to try, most robust first. The absolute System32 path is
 *  immune to a broken PATH in the daemon's environment - the class of bug behind a
 *  6ms "spawn ENOENT" clipboard failure on a healthy Windows 11 laptop. */
export function powershellCandidatesFor(platform: string, systemRoot: string): string[] {
  if (platform !== "win32") return ["powershell"];
  return [
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    "powershell.exe",
    "powershell",
    "pwsh",
  ];
}
export function powershellCandidates(): string[] {
  return powershellCandidatesFor(process.platform, process.env.SystemRoot || "C:\\Windows");
}

/** True only for "the exe never launched" - a nonzero script exit must NOT retry other shells. */
function isSpawnFailure(err: unknown): boolean {
  return /ENOENT|spawn .* (not found|ENOENT)/i.test(String((err as any)?.message || err));
}

/** Run a PowerShell -Command script against the first candidate that launches.
 *  The thrown error names EVERY attempt so chat can show the real reason. */
export async function runPs(script: string, input?: string, timeoutMs = 8000,
  _run: typeof run = run, _candidates: string[] = powershellCandidates()): Promise<string> {
  const errs: string[] = [];
  for (const exe of _candidates) {
    try {
      return await _run(exe, ["-NoProfile", "-Command", script], input, timeoutMs);
    } catch (e) {
      errs.push(`${exe}: ${(e as any)?.message || e}`);
      if (!isSpawnFailure(e)) break;
    }
  }
  throw new Error(errs.join(" | ") || "no PowerShell executable found");
}

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
    const out = await runPs(
      "(Get-CimInstance Win32_Battery | Measure-Object -Property EstimatedChargeRemaining -Average).Average");
    const pct = Math.round(Number(out.trim()));
    if (!Number.isFinite(pct)) return null;
    const status = await runPs("(Get-CimInstance Win32_Battery).BatteryStatus");
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
    // Round-trip through a UTF-8 temp file: setting [Console]::InputEncoding/OutputEncoding
    // throws "the handle is invalid" when stdio is piped (always, via execFile), and the
    // console codepage mangles non-ASCII text either way.
    const out = join(os.tmpdir(), `pa-clip-read-${Date.now()}.txt`);
    try {
      await runPs(`Get-Clipboard -Raw | Out-File -FilePath '${out.replace(/'/g, "''")}' -Encoding utf8 -NoNewline`);
      return existsSync(out) ? readFileSync(out, "utf8") : "";
    } finally {
      try { unlinkSync(out); } catch { /* temp file */ }
    }
  }
  if (process.platform === "darwin") return run("pbpaste", []);
  return run("xclip", ["-selection", "clipboard", "-o"]);
}

/** Copy text to the clipboard. Non-destructive; the write is traced like any tool call. */
export async function clipboardWrite(text: string): Promise<void> {
  if (process.platform === "win32") {
    // "$input | Set-Clipboard" is unreliable in -Command mode (stdin enumeration) and mangles
    // non-ASCII through the console codepage - read the console stream explicitly as UTF-8.
    const tmp = join(os.tmpdir(), `pa-clip-write-${Date.now()}.txt`);
    writeFileSync(tmp, text, "utf8");
    try {
      await runPs(`Set-Clipboard -Value (Get-Content -Raw -Encoding utf8 -LiteralPath '${tmp.replace(/'/g, "''")}')`);
      return;
    } catch (psErr) {
      // last resort: clip.exe reads stdin too (System32 absolute first; ASCII-safe only)
      const root = process.env.SystemRoot || "C:\\Windows";
      const clipErrs: string[] = [`PowerShell: ${(psErr as any)?.message || psErr}`];
      for (const exe of [`${root}\\System32\\clip.exe`, "clip.exe", "clip"]) {
        try { await run(exe, [], text); return; } catch (e) { clipErrs.push(`${exe}: ${(e as any)?.message || e}`); }
      }
      throw new Error(clipErrs.join(" | "));
    } finally {
      try { unlinkSync(tmp); } catch { /* temp file */ }
    }
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
    const root = process.env.SystemRoot || "C:\\Windows";
    const errs: string[] = [];
    for (const exe of [process.env.ComSpec || "", `${root}\\System32\\cmd.exe`, "cmd.exe", "cmd"].filter(Boolean)) {
      try { await run(exe, args, undefined, 5000); return spec.label; }
      catch (e) { errs.push(`${exe}: ${(e as any)?.message || e}`); if (!isSpawnFailure(e)) break; }
    }
    throw new Error(errs.join(" | ") || "no cmd.exe found");
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
