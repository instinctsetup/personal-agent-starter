# Security notes

- The server binds to loopback (127.0.0.1) only. Do not expose it to a network without adding authentication.
- Secrets live in `data/secrets.json` (mode 600). They are registered with the logger's redactor at startup and are never written to logs, chat history, or git.
- `data/` (settings, profile, chat history, application log, LinkedIn browser profile) is git-ignored. Do not commit it.
- Sending mail, submitting applications and LinkedIn actions all require an explicit in-chat confirmation that expires after 15 minutes.
- The LinkedIn module uses your own logged-in session in a local persistent browser profile. Your LinkedIn password is never stored by the app - you log in yourself in the opened window.
- Dependencies are pinned by `package-lock.json`; CI runs on every push.
