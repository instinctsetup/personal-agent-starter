# Personal Agent Starter

> **Demo video (2 min walkthrough):** https://drive.google.com/file/d/12Ja-crRlLy7bjXA5RHiszHuNIYRuBgjJ/view
> **26-page PDF guide (with real screenshots):** https://drive.google.com/file/d/1Cl34FnBS-EK1JJ1-OHO0rvw4JTd4e181/view


A local-first personal agent you run on your own machine: chat with it in plain
English, let it browse, sign up, apply, mail, schedule, remember, and sync - with
every consequential action behind an approval card you can edit before anything
happens, per-day caps on outgoing actions, durable multi-step plans, and a full
trace of everything it did.

**v2.0** turns the CLI starter into a self-hosted web app. **v3** adds the agent
layer on top: an LLM intent router (no command syntax to learn), durable plans,
memory, boards, local models, a typed tool registry, and structured tracing.

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

## The 7 tabs

| Tab | What it does |
|---|---|
| Chat | Command stream with live tool cards, human-in-the-loop approval cards (Approve / Edit Payload / Reject, 15-min expiry), in-chat setup cards |
| Browser | Live screenshot stream of the agent's browser, URL bar, click-to-interact, type-into-page, **Take control** takeover for CAPTCHA/2FA |
| Jobs & Tracker | Application tracker (Applied / Cold Mailed / Replied / Rejected / Scam Flagged), CSV export |
| Drive & Docs | Drive file list; upload/sync via chat (`upload <path> to drive`, `sync <dir> to drive`) |
| Inbox & Outreach | IMAP inbox, cold-mail composer that routes through the approval card |
| Vault & Scheduler | Credential list (usernames only), model router, scheduler jobs (pause/delete) |
| Traces | Live run list + waterfall timeline: every tool call, model race and plan step as a timed span, errors in red |

## What you can say (chat)

Plain English works for all of this - "can u apply to <url>" is fine. An LLM
intent router turns your sentence into the same commands below (and chains
multi-step requests into a durable plan). Exact forms if you want them:

```
connect <gemini|groq|cerebras|github models|openrouter|model|email|drive|github|telegram|profile|anything>
search <query>                        # keyless web search (DuckDuckGo, then Bing)
hunt <query>                          # job hunt: shortlist -> "apply to 1,3" / "apply all"
open / browse <url>                   # live browser
sign up on <site> with google         # signup engine, OTP assist from your inbox
signups                               # list completed signups
apply to <job-url>                    # fills profile facts only; approval before submit
track <Company> - <role>  /  applications
plan <goal>  /  plans  /  resume plan <id>  /  cancel plan <id>
caps  /  cap <action> <N>             # per-day limits on sends, applications, LinkedIn
remember <fact>  /  memories  /  forget <id>
board <pipeline|inbox|overview>  /  boards  /  unshare <kind>
local  /  local setup  /  local on|off   # on-device models via Ollama
skills                                # full tool manifest with risk tiers + caps
traces  /  trace <run-id>             # structured run logs as span trees
send mail to <addr>: <body>           # approval card, then real SMTP send
inbox  /  check mail
drive  /  upload <path> to drive [as doc]  /  sync <dir> to drive
git init <name>  /  commit <path> [msg]  /  push <path>  /  create github repo <name>
every 2 hours search AI internships   /  at 18:30 tracker  /  jobs
linkedin  /  linkedin on  /  i accept the linkedin risk  /  linkedin feed
linkedin message <profile-url>: <text>   # approval-gated, daily-capped
vault  /  help
```

## The v3 agent layer

- **Intent router** - your message is normalized, matched against exact command
  forms first, then classified by the connected model into the same commands.
  Multi-step requests ("find X and mail me the top 3") become durable plans.
- **Durable plans** - a plan is a checkpointed step list in SQLite. A failed step
  is retried once, then the model proposes a corrected step; if it still fails
  the plan pauses (never loses state) until you `resume plan <id>` or
  `cancel plan <id>`. Rejections, expired approvals and cap denials are
  PERMANENT - never retried, never routed around.
- **Action caps** - per-day limits (default: 10 mails, 10 applications, 5
  LinkedIn actions). Checked before anything is drafted; every action is
  recorded in an append-only ledger. `caps` shows today, `cap <action> <N>` raises.
- **Memory** - `remember <fact>` stores durable facts across sessions; relevant
  memories are injected into the router and chat context. Secret-looking values
  are refused (those belong in the vault). Extraction after chat turns is
  automatic, and plan completions are summarized into memory.
- **Boards** - live dashboards (pipeline kanban, inbox triage, overview) at
  `/boards/<id>`, generated from live SQLite data at request time (no snapshots
  to go stale). Each board has a share link; `unshare <kind>` rotates the token
  and kills every old link.
- **Local models** - `local setup` detects your GPU VRAM (nvidia-smi) and
  recommends an honest Ollama model tier (4 GB -> ~2B class, 8 GB -> ~4B,
  16 GB -> ~8B; under 2 GB is refused). A fast local 1B handles short commands;
  a local 2B joins every cloud race. See docs/LOCAL-MODELS.md.
- **Tool registry** - every tool is declared once (typed argument schema, risk
  tier, cap key, approval gate) and the manifest is served at `/api/skills`.
  Invariant under test: every identity or money tool is approval-gated.
- **Structured tracing** - every run is a tree of spans (tool calls, model
  races, plan steps) with timing and status, stored in SQLite, served at
  `/api/traces`, and rendered live in the Traces tab.

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
- `connect gemini` checks the key in two steps: a fast model-metadata lookup,
  then a tiny test completion. Each step is timed and logged to the app
  console. Thinking models can take a while to answer the first call, so the
  test completion allows 90s; if the connect card still fails, run
  `npm run check:gemini` and paste its output (the key is always redacted).

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

**Also first-class: `connect cerebras` and `connect github models`.** These get
their own setup cards and join every model race automatically:
- Cerebras (llama-3.3-70b) - free key at cloud.cerebras.ai, ~30 req/min and
  ~1M tokens/day.
- GitHub Models (openai/gpt-4o-mini) - free with a GitHub token from
  github.com/settings/tokens (Models permission).

Every chat answer is a race across all connected providers plus a local model
when enabled: first good answer wins, and the Traces tab shows which one did.

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
npm test    # 197 tests: v1 core + v2 (vault/otp/search/tracker/approvals/scheduler/git/signup/drive/bridge/mail/providers)
            # + v3 (LLM router, boards, plans, caps, memory, local models, skill registry, tracing, help audit)
```

## v1 (tag `v1.0`)

The original starter (Express-less server, vanilla-web chat, agent core,
mail/apply/linkedin/profile/telegram tools, 48 tests) is preserved at tag `v1.0`.
v1 demo video: https://drive.google.com/file/d/1ABEXE6dvq6-Rh2-AxJGjgUGeWTDK-1i7/view -
v1 guide: https://drive.google.com/file/d/1vw5o4Z0GnoyS8c2ccwlW5G1pd7a6U15D/view
