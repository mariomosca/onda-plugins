/**
 * AI Status Monitor Plugin
 *
 * Monitors AI coding agents (Claude Code, Gemini, OpenCode, etc.) status
 * and provides notifications when an agent is waiting for input.
 *
 * This plugin demonstrates how to use the terminal:subscribe capability
 * to monitor terminal output in real-time.
 */

// Braille spinner characters used by CLI tools
const SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Status types
const STATUS = {
  BUSY: 'busy',
  WAITING: 'waiting',
  IDLE: 'idle',
  UNKNOWN: 'unknown'
};

// Status indicators
const STATUS_INDICATOR = {
  [STATUS.BUSY]: '●',
  [STATUS.WAITING]: '◐',
  [STATUS.IDLE]: '○',
  [STATUS.UNKNOWN]: ''
};

// Track status per terminal
const terminalStatuses = new Map();

// Settings
let notificationsEnabled = true;
let statusBarItemId = null;

/**
 * Strip ANSI escape codes from terminal content
 */
function stripANSI(content) {
  if (!content.includes('\x1b') && !content.includes('\x9B')) {
    return content;
  }
  return content
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b./g, '')
    .replace(/\x9B[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Get the last N non-empty lines from content
 */
function getLastLines(content, count) {
  const lines = content.split('\n');
  const nonEmpty = [];
  for (let i = lines.length - 1; i >= 0 && nonEmpty.length < count; i--) {
    const line = lines[i].trim();
    if (line) {
      nonEmpty.unshift(lines[i]);
    }
  }
  return nonEmpty;
}

/**
 * Check if content contains spinner characters
 */
function hasSpinnerChars(lines) {
  const last3 = lines.slice(-3);
  for (const line of last3) {
    for (const spinner of SPINNER_CHARS) {
      if (line.includes(spinner)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect AI tool from content
 */
function detectTool(content) {
  const lower = content.toLowerCase();

  if (lower.includes('claude') || lower.includes('anthropic') ||
      content.includes('❯') || lower.includes('ctrl+c to interrupt')) {
    return 'claude';
  }
  if (lower.includes('gemini>') || lower.includes('gemini cli')) {
    return 'gemini';
  }
  if (lower.includes('opencode') || lower.includes('ask anything')) {
    return 'opencode';
  }
  if (lower.includes('aider>') || lower.includes('aider v')) {
    return 'aider';
  }
  return null;
}

/**
 * Detect Claude Code status
 */
function detectClaudeStatus(content, lines) {
  const recentContent = lines.join('\n');
  const recentLower = recentContent.toLowerCase();

  // BUSY indicators
  const busyIndicators = ['ctrl+c to interrupt', 'esc to interrupt'];
  for (const indicator of busyIndicators) {
    if (recentLower.includes(indicator)) {
      return { status: STATUS.BUSY, reason: 'working' };
    }
  }

  if (hasSpinnerChars(lines)) {
    return { status: STATUS.BUSY, reason: 'spinner' };
  }

  if (recentLower.includes('thinking') && recentLower.includes('tokens')) {
    return { status: STATUS.BUSY, reason: 'thinking' };
  }

  // WAITING - Permission prompts
  const permissionPrompts = [
    'No, and tell Claude what to do differently',
    'Yes, allow once', 'Yes, allow always',
    'Do you trust the files in this folder?',
    'Run this command?', '❯ Yes', '❯ No'
  ];
  for (const prompt of permissionPrompts) {
    if (recentContent.includes(prompt)) {
      return { status: STATUS.WAITING, reason: 'permission' };
    }
  }

  // WAITING - Input prompt
  if (lines.length > 0) {
    const lastLine = stripANSI(lines[lines.length - 1]).trim().replace(/\u00A0/g, ' ');
    if (lastLine === '>' || lastLine === '❯' || lastLine === '> ' || lastLine === '❯ ') {
      return { status: STATUS.WAITING, reason: 'input' };
    }
  }

  // WAITING - Question prompts
  const questionPrompts = ['Continue?', 'Proceed?', '(Y/n)', '(y/N)', 'Approve this plan?'];
  for (const prompt of questionPrompts) {
    if (recentContent.includes(prompt)) {
      return { status: STATUS.WAITING, reason: 'question' };
    }
  }

  return { status: STATUS.IDLE, reason: null };
}

/**
 * Main status detection
 */
function detectStatus(content) {
  if (!content || content.trim().length === 0) {
    return { status: STATUS.UNKNOWN, tool: null };
  }

  const lines = getLastLines(content, 15);
  if (lines.length === 0) {
    return { status: STATUS.UNKNOWN, tool: null };
  }

  const tool = detectTool(content);

  // Only detect status if an AI tool is actually running
  // Don't show anything for regular shell sessions
  if (!tool) {
    return { status: STATUS.UNKNOWN, tool: null };
  }

  if (tool === 'claude') {
    const result = detectClaudeStatus(content, lines);
    return { ...result, tool };
  }

  // Generic detection for other AI tools (gemini, opencode, aider)
  const lastLine = stripANSI(lines[lines.length - 1]).trim();
  const aiPrompts = ['gemini>', 'aider>', '❯ ', '> '];
  for (const prompt of aiPrompts) {
    if (lastLine.endsWith(prompt.trim()) || lastLine === prompt.trim()) {
      return { status: STATUS.WAITING, tool, reason: 'prompt' };
    }
  }

  return { status: STATUS.IDLE, tool };
}

// Plugin entry point
self.__ondaPlugin = {
  onActivate: async function(onda) {
    console.log('[AI Status Monitor] Activating...');

    // Add status bar item (hidden by default until AI detected)
    try {
      const result = await onda.statusBar.addItem({
        id: 'ai-status',
        text: '',  // Empty initially - shown only when AI detected
        tooltip: 'AI Status Monitor',
        position: 'right',
        priority: 100
      });
      statusBarItemId = result?.id || 'ai-status';
      console.log('[AI Status Monitor] Status bar item added (hidden until AI detected)');
    } catch (e) {
      console.warn('[AI Status Monitor] Could not add status bar item:', e);
    }

    // Subscribe to terminal output
    try {
      const sub = await onda.terminal.subscribe({
        terminalId: 'active'
      });
      console.log('[AI Status Monitor] Subscribed to terminal output:', sub.subscriptionId);
    } catch (e) {
      console.warn('[AI Status Monitor] Could not subscribe to terminal:', e);
    }

    // Listen for terminal output
    onda.on('terminal:output', async (event) => {
      const { terminalId, data } = event;

      // Get full terminal content for better detection
      let content = data;
      try {
        const result = await onda.terminal.read({ terminalId, lastLines: 30 });
        if (result.content) {
          content = result.content;
        }
      } catch (e) {
        // Use just the new data
      }

      const detection = detectStatus(content);
      const prevStatus = terminalStatuses.get(terminalId);
      terminalStatuses.set(terminalId, detection);

      // Update status bar (only show when AI tool detected)
      if (statusBarItemId) {
        if (detection.tool && detection.status !== STATUS.UNKNOWN) {
          const indicator = STATUS_INDICATOR[detection.status] || '○';
          try {
            await onda.statusBar.updateItem(statusBarItemId, {
              text: `${indicator} ${detection.tool}`,
              tooltip: `AI Status: ${detection.status}${detection.reason ? ` (${detection.reason})` : ''}`
            });
          } catch (e) {
            // Ignore status bar errors
          }
        } else {
          // Hide status bar item when no AI detected
          try {
            await onda.statusBar.updateItem(statusBarItemId, {
              text: '',
              tooltip: 'AI Status Monitor (no AI detected)'
            });
          } catch (e) {
            // Ignore status bar errors
          }
        }
      }

      // Notify when status changes to waiting
      if (notificationsEnabled &&
          detection.status === STATUS.WAITING &&
          prevStatus?.status !== STATUS.WAITING) {
        try {
          await onda.notifications.show({
            message: `${detection.tool || 'AI'} is waiting for input`,
            type: 'info',
            duration: 3000
          });
        } catch (e) {
          // Ignore notification errors
        }
      }
    });

    // Register commands
    await onda.commands.register('ai-status-monitor.check-status', {
      title: 'Check AI Status',
      handler: async () => {
        try {
          const result = await onda.terminal.read({ lastLines: 30 });
          const detection = detectStatus(result.content || '');

          await onda.notifications.show({
            message: `AI Status: ${detection.status}${detection.tool ? ` (${detection.tool})` : ''}${detection.reason ? ` - ${detection.reason}` : ''}`,
            type: detection.status === STATUS.WAITING ? 'warning' : 'info',
            duration: 4000
          });
        } catch (e) {
          await onda.notifications.show({
            message: 'Could not read terminal content',
            type: 'error',
            duration: 3000
          });
        }
      }
    });

    await onda.commands.register('ai-status-monitor.toggle-notifications', {
      title: 'Toggle AI Waiting Notifications',
      handler: async () => {
        notificationsEnabled = !notificationsEnabled;
        await onda.notifications.show({
          message: `AI waiting notifications ${notificationsEnabled ? 'enabled' : 'disabled'}`,
          type: 'info',
          duration: 2000
        });
      }
    });

    console.log('[AI Status Monitor] Activated successfully');
  }
};
