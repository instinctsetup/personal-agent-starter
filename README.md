# Personal Agent Starter

> **Demo video (2 min walkthrough):** https://drive.google.com/file/d/12Ja-crRlLy7bjXA5RHiszHuNIYRuBgjJ/view
> **26-page PDF guide (with real screenshots):** https://drive.google.com/file/d/1Cl34FnBS-EK1JJ1-OHO0rvw4JTd4e181/view


A local-first personal agent you run on your own machine: chat with it in a web UI,
let it browse, sign up, apply, mail, schedule, and sync - with every consequential
action behind an approval card you can edit before anything happens.

**v2.0 (branch `v2`)** turns the CLI starter into a self-hosted web app.

## Quick start

```bash
npm install
npm start          # builds the UI + daemon, opens http://127.0.0.1:3090
```

Requires Node 20+. First run: `npx playwright install chromium` for the browser features.
No terminal needed after that - daily use is the web UI.

## Stack

- **UI**: React + Vite + Tailwind (dark), 6-tab workspace. The spec mentioned Next.js;
  v2 deliberately uses a Vite SPA + Fastify daemon instead - this is a loopback
  desktop-style app, so SSR/SEO adds nothing and the Vite build is much lighter.
- **Daemon**: Fastify + WebSocket event stream, Node/TypeScript.
- **Storage**: SQLite (better-sqlite3, WAL) under `./data/`. Vault secrets are
  AES-256-GCM encrypted with a local key (`data/.vault-key`, mode 600) - never logged, never shown.
- **Browser**: Playwright persistent profile. Plain Chromium - **no stealth, no
  anti-bot evasion, no fingerprint spoofing** (default user agent, no webdriver
  patching). CAPTCHAs and 2FA are handed to you via the Browser tab's takeover mode.

## The 6 tabs

| Tab | What it does |
|---|---|
| Chat | Command stream with live tool cards, human-in-the-loop approval cards (Approve / Edit Payload / Reject, 15-min expiry), in-chat setup cards |
| Browser | Live screenshot stream of the agent's browser, URL bar, click-to-interact, type-into-page, **Take control** takeover for CAPTCHA/2FA |
| Jobs & Tracker | Application tracker (Applied / Cold Mailed / Replied / Rejected / Scam Flagged), CSV export |
| Drive & Docs | Drive file list; upload/sync via chat (`upload <path> to drive`, `sync <dir> to drive`) |
| Inbox & Outreach | IMAP inbox, cold-mail composer that routes through the approval card |
| Vault & Scheduler | Credential list (usernames only), model router, scheduler jobs (pause/delete) |

## What you can say (chat)

```
connect <model|email|drive|github|telegram|profile|anything>
search <query>                        # keyless web search (DuckDuckGo, then Bing)
open / browse <url>                   # live browser
sign up on <site> with google         # signup engine, OTP assist from your inbox
apply to <job-url>                    # fills profile facts only; approval before submit
track <Company> - <role>  /  applications
send mail to <addr>: <body>           # approval card, then real SMTP send
inbox  /  check mail
drive  /  upload <path> to drive [as doc]  /  sync <dir> to drive
git init <name>  /  commit <path> [msg]  /  push <path>  /  create github repo <name>
every 2 hours search AI internships   /  at 18:30 tracker  /  jobs
linkedin  /  linkedin on  /  i accept the linkedin risk  /  linkedin feed
vault  /  help
```

## Bridges

- **Telegram**: store a bot token (`connect telegram`), then `POST /api/bridge/telegram/start`.
  Messages to your bot land in chat; replies go back to Telegram.
- **Slack**: point a Slack app's Events URL at `POST /api/slack/events`
  (signing-secret verified when `connect slack-signing` is set).

## Honest limits

- Keyless search can be rate-limited or blocked on datacenter IPs (DuckDuckGo
  returns a challenge). It works from normal residential connections; the parser
  and fallback chain are unit-tested.
- The signup engine automates *your own* accounts on sites that allow it. If a
  site blocks automation, you take over in the Browser tab - by design, there is
  no evasion.
- LinkedIn's terms discourage automation. The suite is risk-gated, slow-paced,
  daily-capped, and uses your own logged-in session. Your account could still be
  restricted - the app tells you this before enabling.
- Email send is real SMTP once `connect email` is done; until then everything is
  simulated and labeled as such.

## Tests

```bash
npm test    # 79 tests: v1 core + v2 vault/otp/search/tracker/approvals/scheduler/git/signup/drive/bridge/mail
```

## v1 (branch `main`)

The original CLI + vanilla-web starter remains on `main`: Express-less server,
agent core, mail/apply/linkedin/profile/telegram tools, 48 tests.
