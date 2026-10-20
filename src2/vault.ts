/** AES-256-GCM encrypted credential vault. Key lives in data/.vault-key (mode 600). */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { secureFile } from "./secure-file.js";

const DATA_DIR = process.env.AGENT_DATA_DIR || join(process.cwd(), "data");
const KEY_PATH = join(DATA_DIR, ".vault-key");

function loadKey(): Buffer {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(KEY_PATH)) return Buffer.from(readFileSync(KEY_PATH, "utf8"), "hex");
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString("hex"), { mode: 0o600 });
  secureFile(KEY_PATH); // chmod 600 is a no-op for access control on NTFS; secureFile adds real Windows ACLs
  return key;
}
const KEY = loadKey();

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(packed: string): string {
  const [ivB, tagB, encB] = packed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64")), decipher.final()]).toString("utf8");
}

export function generatePassword(len = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?";
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function saveCredential(service: string, username: string, secret: string) {
  db.prepare(`INSERT INTO vault (service, username, secret_enc, created_ts) VALUES (?, ?, ?, ?)
              ON CONFLICT(service, username) DO UPDATE SET secret_enc = excluded.secret_enc`)
    .run(service.toLowerCase(), username, encryptSecret(secret), Date.now());
}

export function getCredential(service: string, username?: string): { username: string; secret: string } | null {
  const row = (username
    ? db.prepare("SELECT username, secret_enc FROM vault WHERE service = ? AND username = ?").get(service.toLowerCase(), username)
    : db.prepare("SELECT username, secret_enc FROM vault WHERE service = ? ORDER BY created_ts DESC LIMIT 1").get(service.toLowerCase())) as any;
  return row ? { username: row.username, secret: decryptSecret(row.secret_enc) } : null;
}

export function listCredentials(): { service: string; username: string; created_ts: number }[] {
  return db.prepare("SELECT service, username, created_ts FROM vault ORDER BY created_ts DESC").all() as any;
}
