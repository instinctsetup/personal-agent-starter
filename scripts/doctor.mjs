#!/usr/bin/env node
// Sanity-checks the local install and reports plain-language results.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installAutostart, removeAutostart, isAutostartInstalled, isWindows } from './autostart.mjs';

// --install-autostart / --remove-autostart: manage the Windows per-user
// logon task, print a plain-language result, and exit.
if (process.argv.includes('--install-autostart')) {
  const r = installAutostart(process.cwd());
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} autostart - ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv.includes('--remove-autostart')) {
  const r = removeAutostart();
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} autostart - ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}

const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

ok('Node.js >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.version);
ok('dependencies installed', existsSync('node_modules'));
ok('built (dist/ exists)', existsSync('dist/server.js'));
ok('web UI present', existsSync('web/index.html'));
if (existsSync('data/secrets.json')) {
  const mode = statSync('data/secrets.json').mode & 0o777;
  ok('secrets file is mode 600', mode === 0o600, `mode ${mode.toString(8)}`);
} else {
  ok('secrets file', true, 'not created yet (first run)');
}
if (existsSync('data/settings.json')) {
  try {
    const s = JSON.parse(readFileSync('data/settings.json', 'utf8'));
    ok('settings parse', true, `setup ${s.setupComplete ? 'complete' : 'pending'}`);
  } catch {
    ok('settings parse', false, 'settings.json is not valid JSON');
  }
}
if (isWindows()) {
  ok('autostart at sign-in', isAutostartInstalled(), 'npm run doctor --install-autostart enables it');
  // Google blocks sign-in on the bundled automation Chromium; a real installed browser fixes it.
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const local = process.env['LocalAppData'] || join(process.env['USERPROFILE'] || 'C:\\Users\\Default', 'AppData', 'Local');
  const edge = [pf86, pf, local].some((b) => existsSync(join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  const chrome = [pf, pf86, local].some((b) => existsSync(join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')));
  ok('real browser for Google sign-in', edge || chrome,
     edge || chrome ? `found: ${[edge && 'Edge', chrome && 'Chrome'].filter(Boolean).join(', ')} - say "use my real browser" in chat` : 'install Edge or Chrome, then say "use my real browser" in chat');
}
let failed = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  if (!c.pass) failed++;
}
process.exit(failed ? 1 : 0);
