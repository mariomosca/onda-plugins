/**
 * AI Agent Launcher Plugin for Onda Terminal
 * Quickly launch AI coding agents with preset configurations
 */

const DEFAULT_PRESETS = [
  {
    id: 'claude-plan',
    name: 'Claude Code - Plan Mode',
    description: 'Review and approve each step before execution',
    agent: 'claude-code',
    icon: '\u{1F4CB}',
    command: 'claude --permission-mode plan',
    color: '#60a5fa'
  },
  {
    id: 'claude-edit',
    name: 'Claude Code - Accept Edits',
    description: 'Auto-accept file edits, prompt for other actions',
    agent: 'claude-code',
    icon: '\u{270F}\u{FE0F}',
    command: 'claude --permission-mode acceptEdits',
    color: '#34d399'
  },
  {
    id: 'claude-full',
    name: 'Claude Code - Full Access',
    description: 'Skip all permission prompts (use with caution)',
    agent: 'claude-code',
    icon: '\u{26A1}',
    command: 'claude --dangerously-skip-permissions',
    color: '#f97316'
  },
  {
    id: 'claude-opus',
    name: 'Claude Code - Opus Model',
    description: 'Use Claude Opus 4.6 for complex tasks',
    agent: 'claude-code',
    icon: '\u{1F9E0}',
    command: 'claude --model claude-opus-4-6',
    color: '#a78bfa'
  },
  {
    id: 'claude-sonnet',
    name: 'Claude Code - Sonnet Model',
    description: 'Use Claude Sonnet 4.5 for faster responses',
    agent: 'claude-code',
    icon: '\u{1F680}',
    command: 'claude --model claude-sonnet-4-5-20250929',
    color: '#38bdf8'
  },
  {
    id: 'claude-continue',
    name: 'Claude Code - Continue Session',
    description: 'Continue the most recent conversation',
    agent: 'claude-code',
    icon: '\u{1F504}',
    command: 'claude --continue',
    color: '#fbbf24'
  }
];

self.__ondaPlugin = {
  onActivate: async (api) => {
    let presets = [];
    const PANEL_ID = 'launcher-panel';

    // --- Initialize storage ---
    const initPresets = async () => {
      const stored = await api.storage.get('presets');
      if (!stored || stored.length === 0) {
        await api.storage.set('presets', DEFAULT_PRESETS);
        presets = DEFAULT_PRESETS;
      } else {
        presets = stored;
      }
    };

    // --- Generate panel HTML ---
    const generatePanelHTML = () => {
      const presetCards = presets.map(preset => `
        <div style="
          background: #27272a;
          border: 1px solid #3f3f46;
          border-left: 3px solid ${preset.color};
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 8px;
        ">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
            <span style="font-size: 20px;">${preset.icon}</span>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 13px; font-weight: 600; color: #f4f4f5;">${preset.name}</div>
              <div style="font-size: 11px; color: #71717a; margin-top: 2px;">${preset.description}</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; align-items: center; margin-top: 8px;">
            <button onclick="window.dispatchEvent(new CustomEvent('plugin-panel-action', { detail: { pluginId: 'ai-agent-launcher', action: 'launch', payload: { presetId: '${preset.id}' } } }))" style="
              background: ${preset.color};
              color: #18181b;
              border: none;
              padding: 5px 12px;
              border-radius: 5px;
              font-weight: 600;
              font-size: 12px;
              cursor: pointer;
            ">Launch</button>
            <code style="
              background: #18181b;
              color: #52525b;
              padding: 3px 6px;
              border-radius: 3px;
              font-size: 10px;
              font-family: 'Monaco', 'Menlo', monospace;
              flex: 1;
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            ">${preset.command}</code>
            <button onclick="window.dispatchEvent(new CustomEvent('plugin-panel-action', { detail: { pluginId: 'ai-agent-launcher', action: 'edit', payload: { presetId: '${preset.id}' } } }))" style="
              background: transparent;
              color: #71717a;
              border: 1px solid #3f3f46;
              padding: 4px 8px;
              border-radius: 5px;
              font-size: 11px;
              cursor: pointer;
            ">Edit</button>
            <button onclick="window.dispatchEvent(new CustomEvent('plugin-panel-action', { detail: { pluginId: 'ai-agent-launcher', action: 'delete', payload: { presetId: '${preset.id}' } } }))" style="
              background: transparent;
              color: #ef4444;
              border: 1px solid #3f3f46;
              padding: 4px 8px;
              border-radius: 5px;
              font-size: 11px;
              cursor: pointer;
            ">Del</button>
          </div>
        </div>
      `).join('');

      return `
        <div style="
          padding: 16px;
          background: #18181b;
          color: #d4d4d8;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          height: 100%;
          overflow-y: auto;
        ">
          <div style="margin-bottom: 16px;">
            <h2 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 700; color: #f4f4f5;">
              AI Agent Launcher
            </h2>
            <p style="margin: 0; font-size: 12px; color: #71717a;">
              Launch AI coding agents with preset configurations
            </p>
          </div>
          ${presetCards}
          <button onclick="window.dispatchEvent(new CustomEvent('plugin-panel-action', { detail: { pluginId: 'ai-agent-launcher', action: 'add', payload: {} } }))" style="
            width: 100%;
            background: transparent;
            color: #a78bfa;
            border: 2px dashed #3f3f46;
            padding: 10px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 13px;
            cursor: pointer;
            margin-top: 4px;
          ">+ Add New Preset</button>
        </div>
      `;
    };

    // --- Refresh panel content ---
    const refreshPanel = async () => {
      await api.panel.setContent(PANEL_ID, generatePanelHTML());
    };

    // --- Launch preset ---
    const launchPreset = async (presetId) => {
      const preset = presets.find(p => p.id === presetId);
      if (!preset) {
        api.notifications.show({ type: 'error', message: 'Preset not found' });
        return;
      }
      await api.terminal.write(preset.command + '\n');
      api.notifications.show({ type: 'info', message: 'Launched: ' + preset.name });
    };

    // --- Show add/edit dialog ---
    const showPresetDialog = async (editPresetId) => {
      const isEdit = !!editPresetId;
      const existing = isEdit ? presets.find(p => p.id === editPresetId) : null;

      const result = await api.dialog.show({
        title: isEdit ? 'Edit Preset' : 'Add New Preset',
        message: isEdit ? 'Modify preset configuration:' : 'Create a new AI agent preset:',
        fields: [
          { id: 'name', label: 'Name', type: 'text', required: true, placeholder: 'My Agent Preset' },
          { id: 'description', label: 'Description', type: 'text', required: true, placeholder: 'What this preset does' },
          { id: 'command', label: 'Command', type: 'text', required: true, placeholder: 'claude --permission-mode plan' },
          { id: 'icon', label: 'Icon (emoji)', type: 'text', required: true, placeholder: '\u{1F916}' },
          { id: 'color', label: 'Color (hex)', type: 'text', required: true, placeholder: '#a78bfa' }
        ],
        buttons: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary' },
          { id: 'save', label: isEdit ? 'Save' : 'Add', variant: 'primary' }
        ]
      });

      if (result && result.buttonId === 'save' && result.fields) {
        const newPreset = {
          id: isEdit ? editPresetId : 'custom-' + Date.now(),
          name: result.fields.name || 'Unnamed',
          description: result.fields.description || '',
          command: result.fields.command || '',
          icon: result.fields.icon || '\u{1F916}',
          color: result.fields.color || '#a78bfa',
          agent: 'custom'
        };

        if (isEdit) {
          const index = presets.findIndex(p => p.id === editPresetId);
          if (index >= 0) presets[index] = newPreset;
        } else {
          presets.push(newPreset);
        }

        await api.storage.set('presets', presets);
        await refreshPanel();
        api.notifications.show({ type: 'success', message: isEdit ? 'Preset updated' : 'Preset added' });
      }
    };

    // --- Delete preset ---
    const deletePreset = async (presetId) => {
      const preset = presets.find(p => p.id === presetId);
      if (!preset) return;

      const result = await api.dialog.confirm({
        title: 'Delete Preset',
        message: 'Delete "' + preset.name + '"? This cannot be undone.'
      });

      if (result && result.buttonId === 'confirm') {
        presets = presets.filter(p => p.id !== presetId);
        await api.storage.set('presets', presets);
        await refreshPanel();
        api.notifications.show({ type: 'success', message: 'Preset deleted' });
      }
    };

    // --- Panel action handlers ---
    api.panel.onAction('launch', (payload) => launchPreset(payload.presetId));
    api.panel.onAction('add', () => showPresetDialog(null));
    api.panel.onAction('edit', (payload) => showPresetDialog(payload.presetId));
    api.panel.onAction('delete', (payload) => deletePreset(payload.presetId));

    // --- Register panel ---
    await api.panel.register({
      id: PANEL_ID,
      title: 'AI Agent Launcher',
      icon: '\u{1F916}',
      position: 'right'
    });

    // --- Register app rail icon ---
    await api.appRail.addItem({
      id: 'ai-launcher',
      icon: '\u{1F916}',
      tooltip: 'AI Agent Launcher',
      panelId: PANEL_ID
    });

    // --- Register commands ---
    await api.commands.register('ai-agent-launcher.open-panel', {
      title: 'Open AI Agent Launcher',
      category: 'AI',
      handler: () => api.panel.toggle(PANEL_ID)
    });

    await api.commands.register('ai-agent-launcher.launch-claude-plan', {
      title: 'Launch Claude Code (Plan Mode)',
      category: 'AI',
      handler: async () => {
        await api.terminal.write('claude --permission-mode plan\n');
        api.notifications.show({ type: 'info', message: 'Launched: Claude Code (Plan Mode)' });
      }
    });

    await api.commands.register('ai-agent-launcher.launch-claude-edit', {
      title: 'Launch Claude Code (Accept Edits)',
      category: 'AI',
      handler: async () => {
        await api.terminal.write('claude --permission-mode acceptEdits\n');
        api.notifications.show({ type: 'info', message: 'Launched: Claude Code (Accept Edits)' });
      }
    });

    await api.commands.register('ai-agent-launcher.launch-claude-full', {
      title: 'Launch Claude Code (Full Access)',
      category: 'AI',
      handler: async () => {
        await api.terminal.write('claude --dangerously-skip-permissions\n');
        api.notifications.show({ type: 'info', message: 'Launched: Claude Code (Full Access)' });
      }
    });

    await api.commands.register('ai-agent-launcher.manage-presets', {
      title: 'Manage AI Agent Presets',
      category: 'AI',
      handler: () => api.panel.toggle(PANEL_ID)
    });

    // --- Initialize ---
    await initPresets();
    await refreshPanel();

    console.log('[AI Agent Launcher] Activated with', presets.length, 'presets');
  }
};
