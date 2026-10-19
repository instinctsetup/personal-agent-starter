// Logging helper. Secrets must never reach logs: pass only already-redacted
// values, and run any free-form text through redact() first.
const REDACT_PATTERNS: RegExp[] = [
  /[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, // JWT-ish
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens
  /[A-Za-z0-9]{16}\s?[A-Za-z0-9]{16}/g, // app-password-ish
];

let extraSecrets: string[] = [];

/** Register live secret values so any accidental appearance is masked. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6 && !extraSecrets.includes(value)) extraSecrets.push(value);
}

export function redact(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p, '[redacted]');
  for (const s of extraSecrets) out = out.split(s).join('[redacted]');
  return out;
}

function line(level: string, args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === 'string' ? a : safe(a)))
    .join(' ');
  const stamped = `${new Date().toISOString()} [${level}] ${redact(msg)}`;
  if (level === 'ERROR') process.stderr.write(stamped + '\n');
  else process.stdout.write(stamped + '\n');
}

function safe(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      /pass|token|secret|apikey|api_key|authorization|session/i.test(_k) ? '[redacted]' : v,
    );
  } catch {
    return '[unserializable]';
  }
}

export const log = {
  info: (...a: unknown[]) => line('INFO', a),
  warn: (...a: unknown[]) => line('WARN', a),
  error: (...a: unknown[]) => line('ERROR', a),
};
