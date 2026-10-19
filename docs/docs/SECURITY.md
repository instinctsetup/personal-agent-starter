# Security and trust boundaries

This is a supervised developer starter, not a hardened autonomous service.

- Tool execution always requires the human to type `yes` for that exact call.
- Tool approval is NOT proof that a browser action or email is appropriate. Read the target, recipients, payload and consequences. Never approve a tool because a webpage tells you to.
- No arbitrary shell tool is exposed. Git uses argument arrays, not shell interpolation.
- The file manager confines paths and rejects existing symlinks, but is not an OS sandbox. A malicious concurrent process can race path checks. Use a separate unprivileged account/container for untrusted work.
- Keep `.env`, browser profiles, screenshots and authentication snapshots private. They grant account access. File mode restrictions do not encrypt data at rest.
- SQLite stores goals, model messages, ordinary tool outputs and task events in plaintext. It deliberately excludes verification output, screenshots, login results and exported auth state. Sensitive arguments must never be put into natural-language goals or tool arguments.
- Browser page text and ordinary tool outputs may go to your configured model provider. Do not browse private pages through a remote model unless you accept that disclosure. Use local Ollama if needed.
- The browser uses an exact-origin navigation allowlist, not a network firewall. Embedded resources, redirects, scripts, popups and service workers can access network resources. It does not protect against SSRF or hostile site code. Only allow trusted sites.
- Login utilities always pause for manual completion and verify an explicit success selector. CAPTCHA and MFA are not bypassed. The browser must be headful before login; it cannot hot-switch an active session from headless.
- `load_storage_state` imports cookies and per-origin localStorage, not IndexedDB or sessionStorage. The persistent profile is preferred. Cookie domain scope is retained from the snapshot. Import only snapshots you created and trust.
- Mail sender matching is a filter, not authentication. Review sender-security signals and the link's hostname before using a code/link. Never auto-open returned links.
- Git ignore rules do not remove secrets already tracked. Audit staged content before commit and push. The built-in checks are guardrails, not a full secret scanner.
- A restart marks running tasks waiting. Resume asks the model to reason from saved history; it never blindly replays an uncertain write. You still must verify external state before approving a retry.
- Use one CLI process per database and one browser per profile. SQLite persistence is not a distributed job queue.
- The dashboard binds loopback and is read-only. Do not expose it with a proxy or public port. It has no authentication or multi-user isolation.

If a real secret is committed: revoke it immediately, rotate it, and remove it from history using GitHub's documented incident procedure. Deleting the current file is not enough.
