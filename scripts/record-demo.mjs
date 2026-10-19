#!/usr/bin/env node
// Records a scripted demo of the app with the offline mock provider and a
// local fixture job form, then compresses it under 16 MB for sharing.
// Run: npm run build && node scripts/record-demo.mjs
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = mkdtempSync(join(tmpdir(), 'pa-demo-data-'));
writeFileSync(join(dataDir, 'resume.pdf'), '%PDF-1.4 demo resume');
mkdirSync('assets/demo-raw', { recursive: true });

const { startServer } = await import('../dist/server.js');
const { server } = startServer(0, '127.0.0.1', dataDir);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const fixtureHtml = readFileSync(join(process.cwd(), 'test/fixtures/job-form.html'), 'utf8');
const fixtureServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fixtureHtml); });
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/job`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: 'assets/demo-raw', size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();
const type = async (text, ms = 55) => { await page.locator('#composer-input').pressSequentially(text, { delay: ms }); };
const send = async () => { await page.locator('#send-btn').click(); };
const waitForText = async (t, ms = 30000) => page.locator(`text=${t}`).first().waitFor({ timeout: ms });

await page.goto(base);
await page.waitForTimeout(1200);
// Wizard: quick tour, then skip
await page.waitForSelector('#wizard:not(.hidden)');
await page.waitForTimeout(1500);
await page.locator('#wizard-skip').click();
await page.waitForTimeout(600);

// 1. help
await type('help'); await send();
await waitForText('check mail'); await page.waitForTimeout(1400);

// 2. apply from a link (local fixture stands in for a real posting)
await type(`apply ${fixtureUrl}`, 35); await send();
await waitForText('I need these facts', 60000); await page.waitForTimeout(800);
await type(`First name: Mahesh
Last name: Thakur
Email: mahesh.thakur.mnc@gmail.com
Phone: +91 8460540171
Resume PDF path on this computer: ${join(dataDir, 'resume.pdf')}`, 25);
await send();
await waitForText('Why do you want to work here?', 60000); await page.waitForTimeout(800);
await type('Why do you want to work here?: I love building reliable backend systems.', 25);
await send();
await waitForText('Needs your confirmation', 60000); await page.waitForTimeout(1500);
await page.locator('.card button.primary').first().click();
await waitForText('submitted', 60000); await page.waitForTimeout(1500);

// 3. applications log
await page.locator('[data-view="applications"]').click();
await page.waitForTimeout(1800);

// 4. settings
await page.locator('[data-view="settings"]').click();
await page.waitForTimeout(1800);

await ctx.close();
await browser.close();
server.close();
fixtureServer.close();

const raw = readdirSync('assets/demo-raw').find((f) => f.endsWith('.webm'));
if (!raw) throw new Error('no video recorded');
const src = join('assets/demo-raw', raw);
execFileSync('ffmpeg', ['-y', '-i', src, '-vf', 'scale=1024:-2', '-b:v', '900k', '-an', '-movflags', '+faststart', 'assets/demo.mp4'], { stdio: 'inherit' });
const size = statSync('assets/demo.mp4').size;
console.log(`demo video: assets/demo.mp4 (${(size / 1e6).toFixed(1)} MB)`);
if (size > 16e6) {
  execFileSync('ffmpeg', ['-y', '-i', src, '-vf', 'scale=800:-2', '-b:v', '500k', '-an', '-movflags', '+faststart', 'assets/demo.mp4'], { stdio: 'inherit' });
  console.log(`re-encoded smaller: ${(statSync('assets/demo.mp4').size / 1e6).toFixed(1)} MB`);
}
