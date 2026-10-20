/**
 * `npm run check:gemini` - standalone Gemini connection diagnostic.
 *
 * Reads the key saved by `connect gemini` (settings + encrypted vault) and
 * runs the same two-step validation the app runs, printing each step with
 * timings so a failing connect can be diagnosed from the pasted output.
 * The API key is always redacted. Worst case run time is ~4 minutes
 * (2 attempts x 30s model check + 2 attempts x 90s generate ping).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import Database from 'better-sqlite3';
import { validateGeminiConnection, type GeminiStepEvent } from '../src/providers/gemini.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DATA_DIR = process.env.AGENT_DATA_DIR || join(process.cwd(), 'data');
// testing / advanced: point at a mock or proxy endpoint
const BASE_URL = process.env.GEMINI_BASE_URL || undefined;

function redact(key: string): string {
  if (!key) return '(none)';
  const head = key.slice(0, 4);
  return `"${head}..." (${key.length} chars${/\s/.test(key) ? ', CONTAINS WHITESPACE - re-paste it carefully' : ''})`;
}

function decryptSecret(packed: string, key: Buffer): string {
  const [ivB, tagB, encB] = packed.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

console.log('Personal Agent - Gemini connection check');
console.log(`node ${process.version} | ${process.platform} ${process.arch}`);
console.log(`data dir: ${DATA_DIR}`);
if (BASE_URL) console.log(`base url override: ${BASE_URL}`);

const dbPath = join(DATA_DIR, 'agent-v2.db');
if (!existsSync(dbPath)) {
  console.log(`\nNo saved settings found (${dbPath} does not exist).`);
  console.log('Start the app and say `connect gemini` first, then re-run this check.');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const setting = (k: string): string =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as any)?.value ?? '';

const provider = setting('model_provider') || '(unset)';
const model = setting('model') || DEFAULT_MODEL;
let apiKey = setting('model_api_key');
console.log(`settings: model_provider=${provider}, model=${model}`);
console.log(`api key in settings: ${apiKey ? redact(apiKey) : 'NOT SAVED'}`);

// cross-check the encrypted vault copy written by `connect gemini`
const vaultRow = db
  .prepare("SELECT username, secret_enc FROM vault WHERE service = 'gemini' ORDER BY created_ts DESC LIMIT 1")
  .get() as any;
if (vaultRow) {
  const keyPath = join(DATA_DIR, '.vault-key');
  try {
    const vaultKey = decryptSecret(vaultRow.secret_enc, Buffer.from(readFileSync(keyPath, 'utf8'), 'hex'));
    console.log(`api key in vault: ${redact(vaultKey)} (entry "${vaultRow.username}") - ${apiKey ? (vaultKey === apiKey ? 'matches settings' : 'DIFFERENT from settings; using settings') : 'using vault copy'}`);
    if (!apiKey) apiKey = vaultKey;
  } catch (err: any) {
    console.log(`api key in vault: could not decrypt (${err?.message || err})`);
  }
} else {
  console.log('api key in vault: no gemini entry');
}
db.close();

if (!apiKey) {
  console.log('\nNo Gemini API key saved. Say `connect gemini` in the app chat and paste your key into the card.');
  process.exit(1);
}

let stepStarted = 0;
let currentStep = '';
const onStep = (e: GeminiStepEvent) => {
  const label = e.step === 'model-check' ? 'step 1/2 model check (GET model metadata)' : 'step 2/2 generate ping (tiny test completion)';
  if (e.state === 'start') {
    currentStep = label;
    stepStarted = Date.now();
    console.log(`\n${label}${e.attempt > 1 ? ` (retry ${e.attempt})` : ''} ...`);
  } else {
    console.log(`  ${e.state} after ${e.elapsedMs}ms${e.detail ? ` - ${e.detail}` : ''}`);
  }
};

const t0 = Date.now();
try {
  await validateGeminiConnection(model, apiKey, BASE_URL, { onStep });
  console.log(`\nRESULT: OK - ${model} accepted the key and answered the ping (total ${Date.now() - t0}ms).`);
  console.log('If `connect gemini` still fails in the app, restart the app so it runs this same code.');
} catch (err: any) {
  console.log(`\nRESULT: FAILED during ${currentStep || 'validation'} after ${Date.now() - t0}ms`);
  console.log(`  code: ${err?.code || 'unknown'}`);
  console.log(`  ${err?.message || err}`);
  if (err?.code === 'timeout') {
    console.log('\nThe request reached no answer in time. Compare with:');
    console.log('  curl.exe "https://generativelanguage.googleapis.com/v1beta/models/' + model + '?key=YOUR_KEY"');
    console.log('If curl works but this check times out on the same step, paste this output when asking for help.');
  }
  process.exit(1);
}
