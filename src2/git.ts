/** Git/GitHub engine: init, commit, push, and repo creation from chat. Token from the vault ("github"). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCredential } from "./vault.js";

const run = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: 30_000 });
  return stdout.trim();
}

export async function isRepo(path: string): Promise<boolean> {
  try { await git(["rev-parse", "--is-inside-work-tree"], path); return true; } catch { return false; }
}

export async function initRepo(path: string, name: string): Promise<{ path: string; created: boolean }> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path, { recursive: true });
  const created = !(await isRepo(path));
  if (created) {
    await git(["init", "-b", "main"], path);
    await git(["add", "-A"], path);
    await git(["-c", "user.name=personal-agent", "-c", "user.email=agent@localhost", "commit", "--allow-empty", "-m", `init ${name}`], path);
  }
  return { path, created };
}

export async function statusSummary(path: string): Promise<string> {
  const branch = await git(["branch", "--show-current"], path);
  const changes = await git(["status", "--porcelain"], path);
  const n = changes ? changes.split("\n").length : 0;
  const last = await git(["log", "-1", "--pretty=%h %s"], path).catch(() => "no commits");
  return `branch ${branch} - ${n} uncommitted change(s) - last: ${last}`;
}

/** Stage everything and commit; returns null when there's nothing to commit. */
export async function commitAll(path: string, message: string): Promise<string | null> {
  await git(["add", "-A"], path);
  const changes = await git(["status", "--porcelain"], path);
  if (!changes) return null;
  await git(["-c", "user.name=personal-agent", "-c", "user.email=agent@localhost", "commit", "-m", message], path);
  return git(["log", "-1", "--pretty=%h %s"], path);
}

export async function push(path: string, remote: string, branch: string): Promise<string> {
  const gh = getCredential("github");
  if (gh?.secret && remote.includes("github.com") && !remote.includes("x-access-token")) {
    remote = remote.replace("https://", `https://x-access-token:${gh.secret}@`);
  }
  return git(["push", remote, branch], path);
}

/** Create a GitHub repo via API using the vault token. Returns the clone URL. */
export async function createGithubRepo(name: string, isPrivate = true): Promise<string> {
  const gh = getCredential("github");
  if (!gh?.secret) throw new Error("No GitHub token - say `connect github` first.");
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { authorization: `Bearer ${gh.secret}`, "content-type": "application/json", "user-agent": "personal-agent/2.0" },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data.message || `GitHub API ${res.status}`);
  return data.clone_url as string;
}

/** Parse "https://github.com/owner/repo(.git)" -> { owner, repo } */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
