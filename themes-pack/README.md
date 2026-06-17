# Onda Themes Pack

A curated pack of 5 dark color themes for Onda.

| Theme | Vibe |
|-------|------|
| **Nord Aurora** | Cool arctic blues/greys, calm and low-contrast |
| **Solarized Deep** | The classic teal-on-deep-cyan palette |
| **Tokyo Night** | Soft indigo night, popular editor palette |
| **Gruvbox Material** | Warm retro earth tones, muted |
| **Catppuccin Mocha** | Pastel mauve/lavender on dark plum |

Each theme defines all 22 Onda color tokens (backgrounds, text, borders,
accent, semantic, terminal, selection).

## How it works

The themes are contributed **declaratively** via `contributes.themes` in
`manifest.json`, so Onda registers them automatically. The plugin code adds two
conveniences:

- **Cycle Through Pack Themes** (`Cmd+Shift+T`) — rotate to the next theme in
  the pack.
- **Pick a Theme…** — choose any theme by number from a dialog.

Your selection is saved and re-applied on the next launch.

## How to use

- Press `Cmd+Shift+T` to cycle, or run **Themes: Pick a Theme…** from the
  command palette (`Cmd+K`).
- Themes also appear in Onda's normal theme list (Settings → Appearance),
  prefixed by this plugin.

## Capabilities

`themes`, `commands`, `keybindings`, `storage`, `dialog`, `notifications`.
