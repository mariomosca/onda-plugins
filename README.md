# Onda Plugins (Homemade)

Plugin development workspace for Onda terminal emulator.

## Directory Structure

```
onda-plugins/
├── README.md
├── variable-replacer/      # Plugin: detects and replaces placeholders
│   ├── manifest.json
│   └── main.js
└── [other-plugins]/
```

## Plugin Architecture

Plugins run in isolated **Web Workers**. Each plugin must export:

```javascript
self.__ondaPlugin = {
  onActivate: async function(onda) {
    // Plugin initialization code
    // 'onda' is the API object with all capabilities
  }
};
```

## Quick Start

### 1. Create Plugin

```bash
cd onda-plugins
mkdir my-plugin && cd my-plugin
```

**manifest.json:**
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Description here",
  "main": "main.js",
  "capabilities": ["notifications", "commands"]
}
```

**main.js:**
```javascript
self.__ondaPlugin = {
  onActivate: async function(onda) {
    console.log('[MyPlugin] Activated');

    // Show notification
    onda.notifications.show({
      type: 'success',
      message: 'My plugin is active!'
    });

    // Register command
    onda.commands.register('my-plugin.hello', {
      title: 'Say Hello',
      handler: async () => {
        onda.notifications.show({ message: 'Hello World!' });
      }
    });
  }
};
```

### 2. Install for Testing

```bash
# Symlink for development (changes reflect on reload)
ln -s "$(pwd)/my-plugin" ~/.config/onda/plugins/my-plugin

# Or copy for release
cp -r my-plugin ~/.config/onda/plugins/
```

### 3. Enable in Onda

1. Open Onda Settings (Cmd+,)
2. Navigate to Plugins tab
3. Enable your plugin

### 4. Debug

- Open DevTools (Cmd+Option+I)
- Check Console for plugin logs
- Plugin errors appear with stack traces

## Capabilities Reference

| Capability | Description |
|------------|-------------|
| `commands` | Register commands in Command Palette |
| `keybindings` | Register keyboard shortcuts |
| `statusbar` | Add items to status bar |
| `panel` | Create side panels |
| `notifications` | Show toast notifications |
| `contextmenu` | Add context menu items |
| `storage` | Persistent key-value storage |
| `themes` | Register custom themes |
| `terminal:read` | Read terminal buffer |
| `terminal:write` | Write to terminal |
| `terminal:subscribe` | Real-time terminal output events |
| `dialog` | Show modal dialogs with inputs |
| `clipboard` | Read/write system clipboard |
| `filesystem:read` | Read files |
| `filesystem:write` | Write files |
| `http` | Make HTTP requests |
| `exec` | Execute shell commands |

## API Reference

### onda.commands

```javascript
// Register a command (appears in Command Palette)
onda.commands.register('plugin-id.command-name', {
  title: 'Command Title',
  category: 'Category',  // optional
  handler: async (args) => {
    // Command logic
  }
});

// Execute another command
await onda.commands.execute('some.other.command', [args]);
```

### onda.terminal

```javascript
// Write to active terminal
await onda.terminal.write('echo "Hello"\n');

// Write to specific terminal
await onda.terminal.write({ terminalId: 'term-123', data: 'ls -la\n' });

// Read terminal content
const { content } = await onda.terminal.read();

// Read last N lines
const { content } = await onda.terminal.getLastLines(10);

// Subscribe to terminal output (real-time)
const sub = await onda.terminal.subscribe({
  terminalId: 'active',  // or specific ID
  patterns: ['ERROR', 'WARNING']  // optional regex filters
});

// Listen for output events
onda.on('terminal:output', (event) => {
  console.log('Terminal:', event.terminalId);
  console.log('Data:', event.data);
  console.log('Time:', event.timestamp);
});

// Unsubscribe
await onda.terminal.unsubscribe({ subscriptionId: sub.subscriptionId });
```

### onda.notifications

```javascript
onda.notifications.show({
  type: 'success',  // 'success' | 'error' | 'info' | 'warning'
  title: 'Optional Title',
  message: 'Notification message'
});
```

### onda.dialog

```javascript
// Full dialog with form fields
const result = await onda.dialog.show({
  title: 'Configure Settings',
  message: 'Enter your configuration:',
  fields: [
    { id: 'apiKey', label: 'API Key', type: 'password', required: true },
    { id: 'name', label: 'Name', type: 'text', defaultValue: 'default' },
    { id: 'notes', label: 'Notes', type: 'textarea' }
  ],
  buttons: [
    { id: 'cancel', label: 'Cancel', variant: 'secondary' },
    { id: 'save', label: 'Save', variant: 'primary' }
  ]
});

if (!result.cancelled) {
  console.log('Button clicked:', result.buttonId);
  console.log('Values:', result.values);  // { apiKey: '...', name: '...' }
}

// Simple alert
await onda.dialog.alert({ title: 'Info', message: 'Done!' });

// Confirmation dialog
const { confirmed } = await onda.dialog.confirm({
  title: 'Delete?',
  message: 'Are you sure?'
});
```

### onda.storage

```javascript
// Store value (persists across sessions)
await onda.storage.set('myKey', 'myValue');

// Retrieve value
const value = await onda.storage.get('myKey');

// Remove value
await onda.storage.remove('myKey');

// Clear all plugin storage
await onda.storage.clear();
```

### onda.statusBar

```javascript
// Add status bar item
await onda.statusBar.addItem({
  id: 'my-status',
  text: 'Status Text',
  icon: 'wrench',  // lucide icon name
  tooltip: 'Hover text',
  position: 'right',  // 'left' | 'right'
  onClick: 'my-plugin.some-command'  // command to execute on click
});

// Update item
await onda.statusBar.updateItem('my-status', {
  text: 'New Text',
  icon: 'check'
});

// Remove item
await onda.statusBar.removeItem('my-status');
```

### onda.panel

```javascript
// Register panel
await onda.panel.register({
  id: 'my-panel',
  title: 'My Panel',
  icon: 'layout',
  position: 'right',
  width: 300,
  minWidth: 200,
  maxWidth: 500,
  resizable: true
});

// Set HTML content
await onda.panel.setContent('my-panel', '<div>Panel content</div>');

// Show/hide/toggle
await onda.panel.show('my-panel');
await onda.panel.hide('my-panel');
await onda.panel.toggle('my-panel');
```

### onda.contextMenu

```javascript
// Register context menu item
await onda.contextMenu.register('file-panel', {
  id: 'my-menu-item',
  label: 'My Action',
  icon: 'star',
  command: 'my-plugin.action'
});

// Contexts: 'file-panel', 'terminal'

// Unregister
await onda.contextMenu.unregister('my-menu-item');
```

### onda.exec

```javascript
// Execute shell command
const result = await onda.exec.run('whoami');
console.log('Output:', result.stdout);
console.log('Error:', result.stderr);
console.log('Exit code:', result.code);

// With working directory
const result = await onda.exec.run('ls -la', '/path/to/dir');
```

### onda.http

```javascript
const response = await onda.http.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'value' })
});

console.log('Status:', response.status);
console.log('Data:', response.data);
```

### onda.filesystem

```javascript
// Read file
const { content, error } = await onda.filesystem.readFile('/path/to/file');

// Write file
await onda.filesystem.writeFile('/path/to/file', 'content');

// Read directory
const { entries } = await onda.filesystem.readDir('/path/to/dir');
// entries: [{ name, path, is_dir, is_hidden }]
```

### onda.clipboard

```javascript
// Copy text to clipboard
await onda.clipboard.write('text to copy');

// Read from clipboard
const { text } = await onda.clipboard.read();
```

### Event System

```javascript
// Subscribe to events
onda.on('terminal:output', (event) => {
  console.log('Output:', event.data);
});

// Unsubscribe
onda.off('terminal:output', handler);
```

## Complete Examples

### Command Plugin (exec + notifications)

```javascript
self.__ondaPlugin = {
  onActivate: async function(onda) {
    onda.commands.register('whoami.run', {
      title: 'Who Am I?',
      handler: async () => {
        const res = await onda.exec.run('whoami');
        onda.notifications.show({
          type: 'info',
          message: 'User: ' + res.stdout.trim()
        });
      }
    });
  }
};
```

### Status Bar + Panel Plugin

```javascript
self.__ondaPlugin = {
  onActivate: async function(onda) {
    // Add status bar item
    await onda.statusBar.addItem({
      id: 'my-status',
      text: 'My Plugin',
      icon: 'wrench',
      onClick: 'my-plugin.toggle'
    });

    // Register panel
    await onda.panel.register({
      id: 'my-panel',
      title: 'My Panel',
      position: 'right',
      width: 300
    });

    // Set panel content
    await onda.panel.setContent('my-panel', `
      <div style="padding: 16px; color: #e4e4e7;">
        <h3>My Panel</h3>
        <p>Panel content here</p>
      </div>
    `);

    // Toggle command
    onda.commands.register('my-plugin.toggle', {
      title: 'Toggle Panel',
      handler: () => onda.panel.toggle('my-panel')
    });
  }
};
```

### HTTP + Storage Plugin

```javascript
self.__ondaPlugin = {
  onActivate: async function(onda) {
    onda.commands.register('api.fetch', {
      title: 'Fetch API Data',
      handler: async () => {
        try {
          const response = await onda.http.fetch('https://api.example.com/data');
          await onda.storage.set('lastData', JSON.stringify(response.data));
          onda.notifications.show({ type: 'success', message: 'Data saved!' });
        } catch (err) {
          onda.notifications.show({ type: 'error', message: err.message });
        }
      }
    });
  }
};
```

## Manifest Options

```json
{
  "id": "plugin-id",
  "name": "Display Name",
  "version": "1.0.0",
  "description": "Plugin description",
  "author": {
    "name": "Author Name",
    "url": "https://example.com"
  },
  "main": "main.js",
  "capabilities": ["commands", "notifications"],
  "activationEvents": ["onStartup"],
  "contributes": {
    "commands": [
      { "id": "plugin-id.command", "title": "Command Title", "category": "Category" }
    ]
  },
  "envVars": [
    {
      "name": "API_KEY",
      "description": "API key for service",
      "type": "secret",
      "required": false
    }
  ]
}
```

## Tips

- Use symlinks during development for instant reload
- Plugin logs prefixed with `[PluginWorker]` in DevTools Console
- Each plugin runs in isolated Web Worker (no DOM access)
- Panel content is HTML string only (no React components)
- Use `type: 'password'` for sensitive dialog fields
- Restart Onda after modifying manifest.json
