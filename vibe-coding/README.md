# VibeCoding

Play real arcade games while your AI agents grind in the terminals. When a
session goes back to **waiting for input**, the game pauses itself and shows a
recall overlay so you never miss a prompt.

## Games

- **Snake** — arrows / WASD, grow by eating, don't hit yourself or the walls.
- **Tetris** — `←` `→` move, `↑` rotate, `↓` soft drop, `Space` hard drop, clear lines.
- **Pong** — `↑` `↓` (or just play it as-is) vs a beatable CPU; the ball speeds up on every hit. First to 5 loses.

Pick a game from the hub. In-game: **P** pauses manually, **ESC** returns to the
hub. High scores are saved per game.

## The pause-on-waiting mechanic

VibeCoding subscribes to Onda's AI session status (`aiStatus` capability) and
reacts to transitions:

| Session state | What the game does |
|---|---|
| any session **waiting** | **pauses** + recall overlay "▸ \<tool\> is waiting for you" + a notification |
| no waiting, ≥1 **busy** | **resumes** — keep playing while the agent works |
| everything **idle** | free play, no forced pause |

The recall overlay has a **Back to terminal** button. (This Onda build exposes
no plugin API to focus a specific terminal, so it falls back to a notification
and closing the panel to nudge you back to the grid.)

## How it works

The panel is an interactive sandboxed `<iframe>` (`panel:interactive`
capability) whose document is a self-contained canvas game engine. The plugin
Worker talks to it over the host-relayed `postMessage` bridge
(`api.panel.postMessage` / `api.panel.onMessage`) to deliver `recall` / `resume`
/ `idle` messages and to receive high-score updates.

## Open it

- `Cmd+Shift+G`
- Command palette → **Toggle VibeCoding**
- The **Vibe** status-bar item
