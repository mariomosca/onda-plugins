# Agent Team Panel — Onda plugin

Read-only HUD for the [Agent Team OS](https://github.com/mariomosca/agent-team-os) roster, surfaced as an attached floating panel inside Onda.

## What it shows

- 5 agents (Alita, Kai, Vera, Leo, Nico) with status dot (online / idle / offline), role, last-seen timestamp and pending inbox count.
- Click an agent → detail view with workspace path, threads involving them, full status.
- Recent threads section (last 5) with `from → to · intent · age`.

## Data source

Reads directly from `~/.agent-team-os/` (Public Read API v1.3):

| Path | What | How often |
|---|---|---|
| `AGENT_MAP.json` | roster + roles + avatar fallback chain | every poll (5 s) |
| `registry/<agent>.json` | active flag, workspace_path, last_seen | every poll |
| `inboxes/<agent>/msg-*.json` | pending message count (counted, not read) | every poll |
| `threads/thread-*.json` | last 5 thread files by name (lexicographic desc) | every poll |

Polling interval: 5 s. Liveness rule: `active && last_seen < 10 min ago` → online. Stale `last_seen` flips to idle even with `active:true`.

## Install (local dev)

```bash
ln -s ~/Projects/04-Production/Onda/onda-plugins/team-panel ~/.config/onda/plugins/team-panel
```

Restart Onda or run **Settings → Plugins → enable** if the panel doesn't auto-activate on first launch.

## Capabilities

- `filesystem:read` — Onda will prompt for read access to `~/.agent-team-os/` on first activation.
- `panel` — registers a `position: 'floating'` attached overlay (pattern Gallery, bottom-right corner).
- `commands` — `team-panel.toggle`, `team-panel.refresh` in the command palette.
- `notifications` — reserved for future surfacing of urgent inbox events.

## Known limits (v0.2.0)

- Avatars use the real PNG files (`registry.avatar_path` with fallback to `avatar_default_path` from `AGENT_MAP.json`), loaded via Onda's `filesystem.readFileBinary` and rendered as data URLs. If the binary API isn't available (older Onda builds), the panel falls back to colored initial bubbles.
- No send / reply (read-only by design). To act on a message, open the relevant agent session and use `/inbox` + `/read`.
- No file watch — uses polling. Tail latency of new messages: up to one poll cycle (5 s).
- Companion agents (Sera/Riccia/Polo/Bit/Bolt brainstorm) not surfaced. Will be added when those ship.
