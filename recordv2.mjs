// Walkthrough recorder: screenshot loop + scripted demo, then ffmpeg.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const DIR = '/tmp/v2frames';
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const b = await chromium.launch({ args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });

let n = 0, recording = true;
const frames = [];
const loop = (async () => {
  while (recording) {
    const f = `${DIR}/f${String(n++).padStart(5, '0')}.jpg`;
    await p.screenshot({ path: f, type: 'jpeg', quality: 80 }).catch(() => {});
    frames.push(f);
    await new Promise(r => setTimeout(r, 150));
  }
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const type = async (sel, text, delay = 45) => { await p.click(sel); await p.type(sel, text, { delay }); };

await p.goto('http://127.0.0.1:3092/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('input[placeholder*="Tell your agent"]');
await sleep(2500);

const inp = 'input[placeholder*="Tell your agent"]';
// 1. help
await type(inp, 'help');
await p.press(inp, 'Enter');
await sleep(2500);
// 2. track a job
await p.fill(inp, '');
await type(inp, 'track Razorpay - SDE intern');
await p.press(inp, 'Enter');
await sleep(2000);
// 3. tracker tab
await p.click('button:has-text("Jobs & Tracker")');
await sleep(2500);
// 4. browser tab live demo
await p.click('button:has-text("Browser")');
await p.click('input[placeholder="https://…"]');
await p.type('input[placeholder="https://…"]', 'example.com', { delay: 50 });
await p.click('button:has-text("Go")');
await sleep(4500);
// 5. inbox tab
await p.click('button:has-text("Inbox & Outreach")');
await sleep(2200);
// 6. vault + scheduler
await p.click('button:has-text("Vault & Scheduler")');
await sleep(2500);
// 7. drive tab
await p.click('button:has-text("Drive & Docs")');
await sleep(2000);
// 8. back to chat: mail approval flow
await p.click('button:has-text("Chat")');
await sleep(800);
await type(inp, 'send mail to hiring@razorpay.com: Hi! I applied for the SDE intern role - happy to share more.');
await p.press(inp, 'Enter');
await sleep(3000);
const btn = await p.$('button:has-text("Approve & Run")');
if (btn) { await btn.click(); await sleep(2500); }

recording = false;
await loop;
await b.close();
console.log('frames:', frames.length);

// assemble: 150ms per frame ~ 6.6fps input
execSync(`ffmpeg -y -framerate 6.6 -i ${DIR}/f%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 28 -preset medium -vf "scale=1280:720" /tmp/v2-demo.mp4`, { stdio: 'inherit' });
