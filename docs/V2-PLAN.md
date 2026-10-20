# v2.0 implementation plan (from the user's spec, 2026-10-20 03:10 IST)

Status: NOT STARTED. v1 (current main) is the base: agent core, tools, tests, guide/demo scripts are reusable.

## Locked guardrails (from main agent)
1. No stealth/anti-bot evasion or fingerprint spoofing. Real Chrome/Chromium with a persistent profile; the user signs in himself once; any block/challenge => stop and hand off in a visible browser. Never bypass.
2. LinkedIn: slow pacing, daily caps, stop on any checkpoint.
3. Never invent facts on forms; ask for missing ones.
4. Approval cards (in chat) for: send mail, submit application, sign-up on a new site, shell command, git push. Cards include [Approve & Run] [Edit Payload] [Reject].
5. Generated site passwords go only into the encrypted vault; never logs.
6. Every commit carries: Co-authored-by: Mahesh Thakur <177501980+ursthakurmahesh@users.noreply.github.com>
7. Push milestone commits often; label honestly what was verified live vs mocked.

## Spec deltas vs v1
- Frontend: Next.js/React + Tailwind dark-mode 6-tab workspace: (A) chat & command stream with SSE tool cards (inputs, logs, duration, inline browser screenshots) + approval cards; (B) mail; (C) applications/tracker; (D) vault; (E) scheduler/reminders; (F) settings + in-chat setup cards. No terminal for daily use.
- Backend: Node/TS (Express/Fastify) + SSE/WebSocket; better-sqlite3 (WAL) replacing JSON stores; keep mode-600 perms on the db file.
- Engines: Google SSO sign-up engine with OTP readback over IMAP; web surf/search without paid keys; universal apply-from-link; LinkedIn suite (v1 module extends); multi-model router; git/file tools; Telegram/Slack bridge.
- Vault: AES-256-GCM encrypted secrets store (replaces plaintext secrets.json), master key local.
- Tests: 50+; PDF guide 25+ pages with real screenshots; full demo video; Drive links at top of README.

## Suggested milestone order
1. better-sqlite3 data layer + vault (AES-256-GCM) + migration from v1 JSON stores.
2. Express backend + SSE event bus; port v1 agent core; approval cards with Edit Payload.
3. Next.js+Tailwind shell, 6 tabs, chat tab with streaming tool cards.
4. Mail tab, tracker tab, scheduler tab, vault tab, settings/in-chat setup.
5. Sign-up engine (Google persistent profile, IMAP OTP), web surf, LinkedIn suite, bridges.
6. Tests to 50+, PDF (25+ pages, screenshots from the real UI), demo video, Drive upload, README links.
