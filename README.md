# Personal Agent

A local-first personal assistant with a real app experience: a polished web chat UI, one-command setup, and an in-app setup wizard. Chat with it like WhatsApp/ChatGPT - it reads and summarizes your mail, sends mail you approve, talks to you on Telegram, reads your Telegram channels, fills out job applications from a pasted link, and helps on LinkedIn (opt-in, careful pacing). Everything runs on your machine; secrets stay local.

**[Demo video (Google Drive)](https://drive.google.com/file/d/1ABEXE6dvq6-Rh2-AxJGjgUGeWTDK-1i7/view)** · **[PDF usage guide (Google Drive)](https://drive.google.com/file/d/1vw5o4Z0GnoyS8c2ccwlW5G1pd7a6U15D/view)** · local copy: [`docs/Personal-Agent-Guide.pdf`](docs/Personal-Agent-Guide.pdf)

## Quickstart

```bash
git clone https://github.com/instinctsetup/personal-agent-starter.git
cd personal-agent-starter
./start.sh          # macOS/Linux - or double-click start.command / start.bat on Windows
```

Requires [Node.js 22+](https://nodejs.org). The first run installs dependencies and a browser, then opens `http://127.0.0.1:8787` with the setup wizard (model key, Gmail app password, Telegram, your profile). Skip any step and finish it later in **Settings**.

## What it does

| Feature | How | Status |
| --- | --- | --- |
| Web chat UI | Built-in SPA on loopback, chat bubbles, inline confirm/question cards | tested (offline suite) |
| Model provider | Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, LM Studio) + offline mock for tests | tested against a stub endpoint |
| Read/search/summarize mail | Gmail IMAP with an app password | unit-tested client; **not live-verified** - use Settings > Test connection |
| Send mail | SMTP, only after you confirm the exact email in chat | gate tested; **not live-verified** |
| Telegram bot | Long polling, no framework; shares the same agent and chat history | **not live-verified** |
| Read Telegram channels | GramJS user client, channels you configure, one-time login in chat | **not live-verified** |
| Apply from a link | Playwright fills the form strictly from your saved profile, asks for gaps, confirms before submit, logs every attempt | tested end-to-end against a local fixture form |
| LinkedIn assist | Opt-in. Your own logged-in session in a persistent browser profile: feed reading, Easy Apply, messages, connection invites | guardrails unit-tested; **not live-verified** |
| Memory | "remember ..." / "recall" / "forget" notes, plain-text, secret-guarded | tested |
| Reminders | Natural times ("in 30 minutes", "at 6pm", "tomorrow"), delivered in chat | tested |
| Workspace files | List/read/write/append inside a confined folder | tested |
| Plugins | Drop-in .mjs commands in plugins/ | tested |

## Safety model

- **Nothing is sent or submitted without your confirmation.** Emails, applications, LinkedIn messages/invites all show a summary card first; cards expire after 15 minutes.
- **Form answers come only from your saved profile or your chat answers.** Unknown fields are asked, never invented.
- **Secrets stay local**: `data/secrets.json`, mode 600, masked in logs, never uploaded anywhere.
- **LinkedIn is off by default.** Enabling shows a one-time note: LinkedIn's terms discourage automation, so use is at your own risk. The module paces itself (about one feed check an hour, small daily caps, configurable) and **stops immediately on any checkpoint, captcha or throttle** instead of bypassing it - it tells you in chat.

## Architecture

```text
src/
  server.ts              # loopback HTTP: JSON API + static web UI, Telegram bot wiring
  config.ts              # settings + secrets store (data/, mode 600)
  agent/
    core.ts              # chat orchestration, confirmations, question cards
    intents.ts           # deterministic command parsing (works with no model)
    pending.ts           # confirm/question card manager
    history.ts           # append-only chat log (data/chat.jsonl)
  providers/
    openai.ts            # OpenAI-compatible /chat/completions
    mock.ts              # offline deterministic provider for tests/demos
  tools/
    mail.ts              # IMAP read/search + SMTP send
    telegramBot.ts       # long-poll bot
    telegramChannels.ts  # GramJS channel reader
    apply.ts             # Playwright form filling + application log
    linkedin.ts          # opt-in LinkedIn assist with pacing caps
    profile.ts           # form-answer profile + field matching
web/                     # chat UI, setup wizard, settings, application log
test/                    # 48 offline tests, incl. a full Playwright apply flow
scripts/                 # doctor, PDF guide builder, demo recorder
```

## Everyday commands

```text
help
check mail · unread mail · mail search <words> · summarize mail
send mail                                  # guided, confirm before sending
apply https://jobs.example.com/post/123    # fill from profile, ask gaps, confirm, log
applications                               # your application log
telegram channels · telegram status
linkedin login · linkedin feed · linkedin status
linkedin apply <url> · linkedin message <url>: hi · linkedin invite <url>: note
remember that ... · recall <topic> · notes · forget <id>
remind me in 30 minutes to ... · remind me at 6pm to ... · reminders
list files · read file X · write file X: ... · append file X: ... · plugins
```

Anything else goes to the model provider as chat. With the offline mock provider every command above still works except free-form conversation.

## Development

```bash
npm install && npx playwright install chromium
npm run dev        # auto-reload server
npm test           # offline test suite
npm run doctor     # install sanity check
npm run guide      # rebuild docs/Personal-Agent-Guide.pdf
npm run build && node scripts/record-demo.mjs   # re-record assets/demo.mp4
```

Docker (optional): `docker build -t personal-agent . && docker run -p 8787:8787 -v pa-data:/app/data personal-agent`

## Honest limits

- Mail, Telegram and LinkedIn paths are built against documented APIs and site structure but are **not live-verified** on this repo's CI; the Settings page has one-click tests for each, and the sidebar always shows what's actually working on your machine.
- Generic form filling covers single-page and Greenhouse/Lever-style forms. Complex multi-step builders may need you to finish by hand - the agent says so instead of guessing.
- This is a personal tool you supervise, not an unattended service.
