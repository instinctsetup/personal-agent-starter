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
npm start          # builds the UI + daemon, opens http://127.0.0.1:8787
```

Requires Node 22+. First run: `npx playwright install chromium` for the browser features.
No terminal needed after that - daily use is the web UI.

### Windows note (no compiler needed)

`npm install` works on a plain Windows machine with no C++ build tools: the pinned
`better-sqlite3@^12` ships prebuilt binaries for Windows x64 on Node 22. (The v13
line of better-sqlite3 dropped prebuilt binaries, so stay on v12.) If you upgrade
better-sqlite3 past v12 and `npm install` fails with "Could not find any Visual
Studio installation", install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the "Desktop development with C++" workload - or keep better-sqlite3 on v12.

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
connect <gemini|model|email|drive|github|telegram|profile|anything>
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

## Connect an AI model (free options)

Without a key the app answers with an offline mock ("Mock reply: ..."). Connect a
real model to get real answers. All options below are free - no credit card.

**Recommended: Google Gemini free tier** - say `connect gemini` in chat.

1. Open [aistudio.google.com](https://aistudio.google.com) and sign in with any
   Google account.
2. Click **Get API key** > **Create API key** and copy it.
3. In the app chat, say `connect gemini` and paste the key into the card.
   Leave the model field blank to use `gemini-3.8-flash`, the most capable
   model on the free tier.

Notes:
- A paid Gemini app subscription (Google AI Pro/Ultra) is **not** needed and is
  not the same as an API key. The free API key is enough.
- Free-tier rate limits (requests per minute/day) apply and are shown for your
  project at [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).
  On the free tier Google may use content to improve its products.
- The key is stored AES-256-GCM encrypted in the local vault, like every other
  secret.

**Backup: Groq free tier** - fast, no card, works from India. Create a key at
[console.groq.com/keys](https://console.groq.com/keys), then say `connect model`
with base URL `https://api.groq.com/openai/v1` and a model like
`openai/gpt-oss-120b` (about 30 requests/min and 1,000 requests/day free).

**Other free routes through `connect model`** (any OpenAI-compatible endpoint):

| Service | Base URL | Free notes |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `:free` model variants, 50 requests/day (1,000/day after $10 lifetime credits) |
| Mistral | `https://api.mistral.ai/v1` | Free mode, no card, low evaluation limits |
| Ollama (local, offline) | `http://localhost:11434/v1` | Runs on your laptop, no key (enter any text); needs a few GB RAM; weaker than Gemini |

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
npm test    # 81 tests: v1 core + v2 vault/otp/search/tracker/approvals/scheduler/git/signup/drive/bridge/mail + providers (mock, OpenAI-compatible, Gemini)
```

## v1 (tag `v1.0`)

The original starter (Express-less server, vanilla-web chat, agent core,
mail/apply/linkedin/profile/telegram tools, 48 tests) is preserved at tag `v1.0`.
v1 demo video: https://drive.google.com/file/d/1ABEXE6dvq6-Rh2-AxJGjgUGeWTDK-1i7/view -
v1 guide: https://drive.google.com/file/d/1vw5o4Z0GnoyS8c2ccwlW5G1pd7a6U15D/view
