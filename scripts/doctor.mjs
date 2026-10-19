#!/usr/bin/env node
// Sanity-checks the local install and reports plain-language results.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
let failed = 0;
for (const c of checks) {
  console.log(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  if (!c.pass) failed++;
}
process.exit(failed ? 1 : 0);
