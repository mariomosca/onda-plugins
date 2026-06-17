# Clipboard History

A persistent clipboard manager for Onda. Keeps the last 50 distinct things you
copied and lets you re-paste any of them with a click.

## What it does

- Polls the system clipboard and records every new text entry (de-duped).
- **Floating panel** listing entries newest-first, each with a one-line preview,
  age, and length. Click an entry to copy it back to the clipboard.
- **Pin** (★) keeps an entry at the top and exempts it from eviction.
- **Delete** (✕) removes a single entry; **Clear all** wipes the history.
- History is saved in plugin storage, so it survives restarts.
- Status bar item shows the entry count and toggles the panel.

## How to use

- Press `Cmd+Shift+V` (or run **Clipboard: Toggle Clipboard History**, or click
  the `Clip (N)` status bar item) to open the panel.
- Copy things normally with `Cmd+C` — they show up automatically.
- Click any entry to put it back on the clipboard, then paste with `Cmd+V`.

## Capabilities

`commands`, `keybindings`, `clipboard`, `storage`, `panel`, `statusbar`,
`notifications`.

Up to 50 entries are retained (pinned entries always kept); the newest copy is
floated to the top.
