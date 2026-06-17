# AI Command Explainer

Explains the last command or error in your terminal — instantly, offline, and
without an API key.

## Approach: local-first (self-contained)

This plugin deliberately **does not** call a remote AI endpoint. Instead it
ships a curated knowledge base of common shell error patterns (command not
found, permission denied, port in use, git merge conflicts / no upstream,
`Cannot find module`, npm ERESOLVE, ENOENT, Docker daemon down, TLS/cert
errors, connection refused, …). When it recognizes one, it shows a plain-English
diagnosis and concrete fix commands immediately.

Why local instead of remote:

- **Works offline**, zero latency, no rate limits.
- **No API key management** and no settings to configure.
- **Privacy by default** — your terminal contents are not sent anywhere.
- **Graceful fallback** — for anything the rules don't cover, it builds a clean,
  context-rich prompt (command + output) and copies it to your clipboard with
  one click, so you can paste it into Claude / ChatGPT / Onda's AI box.

This keeps the capability allow-list minimal (no `http`, no secrets).

## How to use

1. Run a command that fails (or any command).
2. Press `Cmd+Shift+E`, run **AI Explainer: Explain Last Command / Error** from
   the command palette, or right-click the terminal → *Explain last command /
   error*.
3. Read the diagnosis. If you want a full AI answer, click **Copy AI prompt**
   and paste it into your assistant.

## Capabilities

`commands`, `keybindings`, `contextmenu`, `terminal:read`, `terminal:subscribe`,
`clipboard`, `dialog`, `notifications`.
