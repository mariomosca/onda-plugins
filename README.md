# Onda Plugins

Official plugins for [Onda Terminal Emulator](https://github.com/mariomosca/onda-electron) - extending your terminal with powerful features.

## Available Plugins

### AI Agent Launcher

Launch AI coding agents (Claude Code, Codex, Gemini CLI) with preset configurations directly from your terminal.

**Features:**
- Quick access to multiple AI agent presets
- Pre-configured commands for different modes (Plan, Accept Edits, Full Access)
- Model selection presets (Opus, Sonnet)
- Session continuation support
- Custom preset management
- Dark-themed UI panel
- App rail icon for quick access

**Default Presets:**
- **Plan Mode**: Review and approve each step before execution
- **Accept Edits**: Auto-accept file edits, prompt for other actions
- **Full Access**: Skip all permission prompts (use with caution)
- **Opus Model**: Use Claude Opus 4.6 for complex tasks
- **Sonnet Model**: Use Claude Sonnet 4.5 for faster responses
- **Continue Session**: Continue the most recent conversation

**Capabilities:**
Commands, Terminal Write, Panel, App Rail, Storage, Notifications, Dialog

---

## Installation

### Option 1: Clone and Copy (Recommended)

```bash
# Clone the entire repository
git clone https://github.com/mariomosca/onda-plugins.git /tmp/onda-plugins

# Copy the plugin you want
cp -r /tmp/onda-plugins/ai-agent-launcher ~/.config/onda/plugins/

# Clean up
rm -rf /tmp/onda-plugins
```

### Option 2: Direct Download

```bash
# Create plugin directory
mkdir -p ~/.config/onda/plugins/ai-agent-launcher

# Download files
curl -o ~/.config/onda/plugins/ai-agent-launcher/manifest.json \
  https://raw.githubusercontent.com/mariomosca/onda-plugins/main/ai-agent-launcher/manifest.json

curl -o ~/.config/onda/plugins/ai-agent-launcher/main.js \
  https://raw.githubusercontent.com/mariomosca/onda-plugins/main/ai-agent-launcher/main.js
```

### Enable in Onda

1. Open Onda Terminal
2. Go to Settings > Plugins
3. Find "AI Agent Launcher" and toggle it ON
4. Restart Onda (or reload plugins)

## Usage

### AI Agent Launcher

1. **Open the Panel:** Click the bot icon in the left sidebar, or use Command Palette: `AI: Open AI Agent Launcher`
2. **Launch an Agent:** Click the "Launch" button on any preset card
3. **Manage Presets:**
   - **Add**: Click "+ Add New Preset" at the bottom
   - **Edit**: Click "Edit" on any preset card
   - **Delete**: Click "Del" on any preset card
4. **Quick Commands (Cmd+K):**
   - `AI: Launch Claude Code (Plan Mode)`
   - `AI: Launch Claude Code (Accept Edits)`
   - `AI: Launch Claude Code (Full Access)`

## Plugin Development

Want to create your own Onda plugin? Check out the [Plugin Development Guide](https://github.com/mariomosca/onda-electron/blob/main/docs/PLUGIN-DEVELOPMENT.md).

### Plugin Structure

```
~/.config/onda/plugins/
└── your-plugin-name/
    ├── manifest.json   # Plugin metadata and capabilities
    └── main.js         # Plugin code (Web Worker)
```

## Contributing

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/amazing-plugin`)
3. Commit your changes
4. Open a Pull Request

### Plugin Submission Guidelines

- Must include `manifest.json` and `main.js`
- Code must be well-documented
- Follow the existing code style
- Test thoroughly before submitting

## License

MIT

## Links

- [Onda Terminal Emulator](https://github.com/mariomosca/onda-electron)
- [Plugin Development Docs](https://github.com/mariomosca/onda-electron/blob/main/docs/PLUGIN-DEVELOPMENT.md)
- [Report Issues](https://github.com/mariomosca/onda-plugins/issues)
