/**
 * Variable Replacer Plugin
 *
 * Detects placeholders in terminal output and helps replace them with actual values.
 * Useful when Claude Code suggests commands with placeholders like YOUR_API_KEY.
 *
 * Features:
 * - Auto-detect placeholders in streaming output
 * - Context menu: "Replace Variables" on selected text
 * - Command palette: "Replace Variables in Terminal"
 */

self.__ondaPlugin = {
  onActivate: async function(onda) {
    console.log('[Variable Replacer] Initializing...');

    // Patterns to detect (order matters - more specific first)
    const PLACEHOLDER_PATTERNS = [
      /YOUR_[A-Z][A-Z0-9_]+/g,       // YOUR_SOMETHING pattern
      /<[a-z][a-z0-9-_]*>/gi,        // <placeholder-name> pattern
      /\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, // {{variable}} pattern
      /\$[A-Z][A-Z0-9_]+/g,          // $VARIABLE pattern
      /"[A-Za-z]+ [A-Za-z]+"/g,      // "Placeholder Text" in quotes
    ];

    // Buffer to accumulate output (Claude sends data in chunks)
    let outputBuffer = '';
    let bufferTimeout = null;
    const BUFFER_DELAY = 800; // Increased for better chunk accumulation

    // Track recently shown placeholders to avoid spam
    const recentlyShown = new Set();
    const COOLDOWN_MS = 60000; // 1 minute cooldown

    // Stored replacements (persistent)
    let savedReplacements = {};

    // Load saved replacements
    try {
      const stored = await onda.storage.get('replacements');
      if (stored) {
        savedReplacements = JSON.parse(stored);
        console.log('[Variable Replacer] Loaded saved replacements:', Object.keys(savedReplacements).length);
      }
    } catch (e) {
      console.log('[Variable Replacer] No saved replacements found');
    }

    // Helper: Check if placeholder looks like a secret
    function isSecretPlaceholder(placeholder) {
      const secretKeywords = ['API_KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'CREDENTIAL', 'PRIVATE', 'KEY'];
      const upper = placeholder.toUpperCase();
      return secretKeywords.some(kw => upper.includes(kw));
    }

    // Helper: Check for common false positives
    function isLikelyFalsePositive(placeholder) {
      const falsePositives = [
        '$HOME', '$USER', '$PATH', '$PWD', '$SHELL', '$TERM',
        '<div>', '<span>', '<br>', '<p>', '<a>', '<li>', '<ul>',
        '<head>', '<body>', '<html>', '<script>', '<style>',
        '<T>', '<K>', '<V>', '<E>', '<S>',
        '"Hello"', '"World"', '"test"', '"true"', '"false"',
      ];
      return falsePositives.includes(placeholder);
    }

    // Helper: Find all placeholders in text
    function findPlaceholders(text) {
      const found = new Set();

      for (const pattern of PLACEHOLDER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const placeholder = match[0];
          if (!isLikelyFalsePositive(placeholder)) {
            found.add(placeholder);
          }
        }
      }

      return Array.from(found);
    }

    // Helper: Extract command line from text
    function extractCommandLine(text, placeholders) {
      const lines = text.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length < 5) continue;

        const hasPlaceholder = placeholders.some(p => trimmed.includes(p));
        if (!hasPlaceholder) continue;

        const commandPatterns = [
          /^(curl|wget|http|git|npm|yarn|pnpm|node|python|pip|docker|kubectl)\s/i,
          /^(export|set|env)\s+\w+=/i,
          /^[\w-]+\s+--?[\w-]+/,
          /^(\.\/|\/|~\/)/,
        ];

        if (commandPatterns.some(p => p.test(trimmed))) {
          return trimmed.replace(/\x1b\[[0-9;]*m/g, '');
        }
      }

      // Fallback: first line with placeholder
      for (const line of lines) {
        const trimmed = line.trim();
        if (placeholders.some(p => trimmed.includes(p))) {
          return trimmed.replace(/\x1b\[[0-9;]*m/g, '');
        }
      }

      return text.replace(/\x1b\[[0-9;]*m/g, ''); // Return all text cleaned
    }

    // Main function to process text and show dialog
    async function processText(text, source) {
      const placeholders = findPlaceholders(text).slice(0, 6);

      if (placeholders.length === 0) {
        onda.notifications.show({
          type: 'info',
          title: 'No Placeholders Found',
          message: 'No variables to replace in ' + source
        });
        return;
      }

      console.log('[Variable Replacer] Found placeholders:', placeholders);

      // Build dialog fields
      const fields = placeholders.map(p => ({
        id: p,
        label: p,
        type: isSecretPlaceholder(p) ? 'password' : 'text',
        placeholder: 'Enter value for ' + p,
        defaultValue: savedReplacements[p] || '',
        required: false
      }));

      // Show dialog
      const result = await onda.dialog.show({
        title: 'Replace Variables',
        message: 'Found ' + placeholders.length + ' placeholder(s). Enter replacement values:',
        fields: fields,
        buttons: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary' },
          { id: 'replace', label: 'Replace & Write', variant: 'primary' }
        ]
      });

      if (result.cancelled) return;

      const values = result.values || {};
      let hasNewValues = false;

      // Save non-empty, non-secret values
      for (const [key, value] of Object.entries(values)) {
        if (value && value.trim() && !isSecretPlaceholder(key)) {
          savedReplacements[key] = value;
          hasNewValues = true;
        }
      }

      if (hasNewValues) {
        try {
          await onda.storage.set('replacements', JSON.stringify(savedReplacements));
        } catch (e) {
          console.error('[Variable Replacer] Failed to save replacements:', e);
        }
      }

      // Build replaced command
      const commandLine = extractCommandLine(text, placeholders);
      let replacedCommand = commandLine;

      for (const [key, value] of Object.entries(values)) {
        if (value && value.trim()) {
          const escapedValue = value.includes(' ') ? '"' + value + '"' : value;
          replacedCommand = replacedCommand.split(key).join(escapedValue);
        }
      }

      // Copy to clipboard
      try {
        await onda.clipboard.write(replacedCommand);
        onda.notifications.show({
          type: 'success',
          title: 'Copied to Clipboard!',
          message: 'Paste with Cmd+V to run the command'
        });
      } catch (err) {
        // Fallback: write to terminal
        await onda.terminal.write({
          terminalId: 'active',
          data: replacedCommand
        });
        onda.notifications.show({
          type: 'success',
          title: 'Command Ready',
          message: 'Written to terminal (clipboard failed)'
        });
      }
    }

    // ========================================
    // COMMAND: Replace Variables in Terminal
    // ========================================
    await onda.commands.register('variable-replacer.replace-from-terminal', {
      title: 'Replace Variables in Terminal',
      category: 'Variable Replacer',
      handler: async () => {
        try {
          const result = await onda.terminal.getLastLines(30);
          await processText(result.content || '', 'terminal output');
        } catch (err) {
          onda.notifications.show({
            type: 'error',
            title: 'Error',
            message: err.message
          });
        }
      }
    });

    // ========================================
    // CONTEXT MENU: Terminal
    // ========================================
    await onda.contextMenu.register('terminal', {
      id: 'replace-variables',
      label: 'Replace Variables',
      icon: 'replace',
      command: 'variable-replacer.replace-from-terminal'
    });

    // ========================================
    // AUTO-DETECT (streaming terminal output)
    // ========================================
    try {
      // Subscribe WITHOUT pattern filter - we filter ourselves for better control
      const sub = await onda.terminal.subscribe({
        terminalId: 'active'
      });

      console.log('[Variable Replacer] Subscribed to terminal output:', sub.subscriptionId);

      // Listen for terminal output events
      onda.on('terminal:output', (event) => {
        // Accumulate data
        outputBuffer += event.data;

        // Debounce processing
        if (bufferTimeout) {
          clearTimeout(bufferTimeout);
        }

        bufferTimeout = setTimeout(async () => {
          const text = outputBuffer;
          outputBuffer = '';

          // Skip if too short
          if (text.length < 10) return;

          const placeholders = findPlaceholders(text);
          if (placeholders.length === 0) return;

          // Only show for NEW placeholders (not recently shown)
          const newPlaceholders = placeholders.filter(p => !recentlyShown.has(p));
          if (newPlaceholders.length === 0) return;

          // Mark as shown (with cooldown)
          newPlaceholders.forEach(p => {
            recentlyShown.add(p);
            setTimeout(() => recentlyShown.delete(p), COOLDOWN_MS);
          });

          console.log('[Variable Replacer] AUTO-DETECTED:', newPlaceholders);

          // Show prominent notification
          onda.notifications.show({
            type: 'warning',
            title: 'Variables Found!',
            message: newPlaceholders.slice(0, 3).join(', ') + ' - Right-click > Replace Variables'
          });
        }, BUFFER_DELAY);
      });

      console.log('[Variable Replacer] Auto-detect enabled');
    } catch (err) {
      console.log('[Variable Replacer] Auto-detect failed:', err.message);
    }

    // Show activation notification
    onda.notifications.show({
      type: 'success',
      title: 'Variable Replacer',
      message: 'Right-click terminal or use Cmd+K > Replace Variables'
    });

    console.log('[Variable Replacer] Activated successfully');
  }
};
