# Git Blame

Surfaces git authorship for the repository in the **active terminal's working
directory** — no need to type `git log` / `git blame` by hand.

## What it does

- **Status bar item** showing the last commit `hash · author` of the current
  repo, refreshed automatically as you move between repos. Click it to open the
  details dialog.
- **Show Last Commit** (`Cmd+Shift+B`) — dialog with repo, branch, commit hash,
  author, date (absolute + relative), subject and refs. "Copy Hash" button.
- **Blame a File…** — prompts for a path and shows the file's last commit plus
  the top authors ranked by line ownership (`git blame`).

## How to use

1. Open a terminal inside any git repository.
2. Press `Cmd+Shift+B`, or run **Git Blame: Show Last Commit** from the command
   palette (`Cmd+K`), or click the status bar entry.
3. For per-file ownership, run **Git Blame: Blame a File…** and enter a path.

## Capabilities

`commands`, `keybindings`, `exec` (whitelisted to `git *`), `dialog`,
`clipboard`, `statusbar`, `notifications`.

Commands run in the active terminal's working directory, so the plugin always
reflects the repo you are currently looking at.
