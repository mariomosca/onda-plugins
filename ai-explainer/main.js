/**
 * AI Command Explainer Plugin for Onda
 *
 * Explains the last command / error in the active terminal. Self-contained:
 * instead of depending on a remote AI endpoint (which would need an API key
 * and network access), it ships a local knowledge base of common shell error
 * patterns and produces a diagnosis + likely fixes instantly. For cases the
 * heuristics don't cover, it builds a clean, context-rich prompt and offers a
 * one-click "Copy AI prompt" so the user can paste it into Claude / ChatGPT /
 * the Onda AI box.
 *
 * Why local-first: it works offline, leaks no terminal contents to third
 * parties by default, has no key-management UX, and degrades gracefully (the
 * AI-prompt path always works even when no rule matches). Capabilities stay
 * minimal — no `http`, no settings/envVars.
 *
 * Entry points: command palette, Cmd+Shift+E keybinding, and a terminal
 * right-click context menu item.
 */

self.__ondaPlugin = {
  async onActivate(api) {
    // ── recent-output capture ────────────────────────────────────────
    // We keep a rolling buffer of streamed output so "explain last" works
    // even if terminal.read can't be granted; terminal.read is the primary
    // source when available.
    let rolling = '';
    const ROLLING_MAX = 16000;

    function stripAnsi(s) {
      return (s || '')
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b./g, '')
        .replace(/\r/g, '');
    }

    try {
      await api.terminal.subscribe({ terminalId: 'active' });
      api.on('terminal:output', (event) => {
        rolling += event.data || '';
        if (rolling.length > ROLLING_MAX) rolling = rolling.slice(-ROLLING_MAX);
      });
    } catch (_) { /* subscribe optional; read is the main path */ }

    async function getRecentOutput() {
      // Prefer a real buffer read; fall back to the rolling stream capture.
      try {
        const r = await api.terminal.read({ scrollback: 60 });
        const content = (r && (r.content || r.text)) || '';
        if (content && content.trim()) return stripAnsi(content);
      } catch (_) {}
      try {
        const r = await api.terminal.getLastLines(60);
        const content = (r && (r.content || r.text)) || '';
        if (content && content.trim()) return stripAnsi(content);
      } catch (_) {}
      return stripAnsi(rolling);
    }

    // ── parse the most recent command + its output ───────────────────
    // Heuristic: find the last shell prompt line ($ / % / ❯ / >) that has a
    // command after it; everything after it is treated as that command's
    // output.
    function extractLastCommandBlock(text) {
      const lines = text.split('\n');
      const promptRe = /^(?:[^\n@]*[@:][^\n$%❯>]*)?[\s]*[$%❯#>]\s+(\S.*)$/;
      let cmdIdx = -1;
      let command = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(promptRe);
        if (m && m[1] && m[1].trim().length > 0) {
          // Ignore lines that are themselves a bare prompt awaiting input.
          cmdIdx = i;
          command = m[1].trim();
          break;
        }
      }
      let output;
      if (cmdIdx >= 0) {
        output = lines.slice(cmdIdx + 1).join('\n').trim();
      } else {
        // No prompt detected — use the tail of the buffer as "output".
        output = lines.slice(-25).join('\n').trim();
      }
      return { command, output };
    }

    // ── local knowledge base ─────────────────────────────────────────
    // Each rule: a matcher (regex over command+output), a human title, the
    // explanation, and a list of concrete fixes. Order matters — more
    // specific rules first.
    const RULES = [
      {
        id: 'cmd-not-found',
        test: (t) => /command not found|: not found|is not recognized as an internal or external command/i.test(t),
        title: 'Command not found',
        why: 'The shell could not locate the executable on your PATH. Either the tool is not installed, or its install location is not in PATH.',
        fixes: (t) => {
          const m = t.match(/([\w.-]+): command not found/i) || t.match(/(\S+): not found/i);
          const bin = m ? m[1] : 'the command';
          return [
            'Confirm it is installed: `which ' + bin + '` (or `command -v ' + bin + '`).',
            'If missing, install it (e.g. `brew install ' + bin + '`, `npm i -g ' + bin + '`, or your package manager).',
            'If installed, add its directory to PATH in ~/.zshrc / ~/.bashrc and re-open the shell.',
          ];
        },
      },
      {
        id: 'permission-denied',
        test: (t) => /permission denied|EACCES|operation not permitted/i.test(t),
        title: 'Permission denied',
        why: 'The current user lacks permission to read/write/execute the target, or a port/file is owned by another user.',
        fixes: () => [
          'Check ownership/permissions: `ls -l <path>`.',
          'Make a script executable: `chmod +x <file>`.',
          'Avoid blanket `sudo`; prefer fixing ownership: `sudo chown -R "$USER" <dir>` for dirs you own.',
          'For npm EACCES on global installs, use a node version manager (nvm/fnm) instead of sudo.',
        ],
      },
      {
        id: 'port-in-use',
        test: (t) => /EADDRINUSE|address already in use|port .* is already in use/i.test(t),
        title: 'Port already in use',
        why: 'Another process is already listening on the port your app tried to bind.',
        fixes: (t) => {
          const m = t.match(/:(\d{2,5})\b/) || t.match(/port\s+(\d{2,5})/i);
          const port = m ? m[1] : '<port>';
          return [
            'Find the process: `lsof -i :' + port + '` (macOS/Linux).',
            'Kill it: `kill -9 <PID>` from the lsof output.',
            'Or run your app on a different port (e.g. `PORT=' + (m ? Number(port) + 1 : 3001) + '`).',
          ];
        },
      },
      {
        id: 'git-merge-conflict',
        test: (t) => /CONFLICT \(content\)|Automatic merge failed|fix conflicts and then commit/i.test(t),
        title: 'Git merge conflict',
        why: 'A merge/rebase touched the same lines in both branches and git cannot auto-resolve them.',
        fixes: () => [
          'List conflicted files: `git status`.',
          'Open each, resolve the `<<<<<<< ======= >>>>>>>` markers, then `git add <file>`.',
          'Finish: `git commit` (merge) or `git rebase --continue` (rebase).',
          'Bail out entirely: `git merge --abort` / `git rebase --abort`.',
        ],
      },
      {
        id: 'git-not-repo',
        test: (t) => /fatal: not a git repository/i.test(t),
        title: 'Not a git repository',
        why: 'You ran a git command outside any repository (no .git directory up the tree).',
        fixes: () => [
          '`cd` into the project directory first.',
          'Initialize a new repo here: `git init`.',
          'Clone an existing one: `git clone <url>`.',
        ],
      },
      {
        id: 'git-no-upstream',
        test: (t) => /has no upstream branch|set-upstream/i.test(t),
        title: 'Branch has no upstream',
        why: 'The local branch is not tracking a remote branch, so plain `git push` does not know where to push.',
        fixes: (t) => {
          const m = t.match(/git push --set-upstream (\S+) (\S+)/);
          return [
            m ? 'Run the suggested command: `git push --set-upstream ' + m[1] + ' ' + m[2] + '`.'
              : 'Push and set tracking: `git push -u origin <branch>`.',
          ];
        },
      },
      {
        id: 'npm-missing-module',
        test: (t) => /Cannot find module|ERR_MODULE_NOT_FOUND|Module not found/i.test(t),
        title: 'Module not found',
        why: 'Node could not resolve an import — usually dependencies were not installed, or the path is wrong.',
        fixes: (t) => {
          const m = t.match(/Cannot find module ['"]([^'"]+)['"]/i);
          const mod = m ? m[1] : null;
          const out = ['Install deps: `npm install` (or `pnpm install` / `yarn`).'];
          if (mod && !mod.startsWith('.')) out.push('Add the package: `npm install ' + mod + '`.');
          if (mod && mod.startsWith('.')) out.push('Check the relative import path and file extension for `' + mod + '`.');
          out.push('Delete and reinstall if stale: `rm -rf node_modules package-lock.json && npm install`.');
          return out;
        },
      },
      {
        id: 'npm-eresolve',
        test: (t) => /ERESOLVE|peer dep|could not resolve dependency/i.test(t),
        title: 'npm dependency resolution conflict',
        why: 'npm found conflicting peer-dependency requirements between packages.',
        fixes: () => [
          'Try `npm install --legacy-peer-deps` (loosens peer checks).',
          'Or `npm install --force` (last resort — may pull mismatched versions).',
          'Better: read the conflict and align the offending package versions.',
        ],
      },
      {
        id: 'enoent',
        test: (t) => /ENOENT|no such file or directory/i.test(t),
        title: 'No such file or directory',
        why: 'A path you referenced does not exist (typo, wrong cwd, or a file that was never created).',
        fixes: () => [
          'Check where you are: `pwd`, then `ls` the directory.',
          'Verify the exact path/spelling and that the file exists.',
          'If a build/output file, run the step that generates it first.',
        ],
      },
      {
        id: 'docker-daemon',
        test: (t) => /Cannot connect to the Docker daemon|docker daemon is not running/i.test(t),
        title: 'Docker daemon not running',
        why: 'The Docker CLI cannot reach the engine — Docker Desktop / the daemon is not started.',
        fixes: () => [
          'Start Docker Desktop (macOS/Windows) and wait for it to be ready.',
          'On Linux: `sudo systemctl start docker`.',
          'Verify: `docker info`.',
        ],
      },
      {
        id: 'ssl-cert',
        test: (t) => /SSL certificate problem|unable to get local issuer certificate|CERT_HAS_EXPIRED|self.?signed certificate/i.test(t),
        title: 'TLS / certificate error',
        why: 'The client could not validate the server certificate chain (expired, self-signed, or missing CA bundle).',
        fixes: () => [
          'Check your system clock — an expired cert error is often a wrong date.',
          'Update CA certificates / your tool (Node, curl, git).',
          'Only as a temporary local workaround, disable verification (never in production).',
        ],
      },
      {
        id: 'connection-refused',
        test: (t) => /ECONNREFUSED|connection refused|Failed to connect to/i.test(t),
        title: 'Connection refused',
        why: 'Nothing is listening at the host:port you tried to reach (service down, wrong port, or not started yet).',
        fixes: () => [
          'Confirm the target service is running and on the expected port.',
          'Check the host/port in your config or URL.',
          'If local, start the dependency (db/server) before the client.',
        ],
      },
    ];

    function looksLikeError(text) {
      return /error|fatal|exception|failed|denied|not found|cannot|ENOENT|EACCES|traceback|panic/i.test(text);
    }

    function buildAiPrompt(command, output) {
      const lines = [
        'I ran a command in my terminal and want a clear explanation and a fix.',
        '',
        command ? 'Command:\n' + command : 'Command: (not captured)',
        '',
        'Output / error:',
        '```',
        (output || '(no output captured)').slice(0, 2500),
        '```',
        '',
        'Please: (1) explain in one paragraph what happened and why, ' +
        '(2) give the exact commands to fix it, ' +
        '(3) note any caveats. Be concise.',
      ];
      return lines.join('\n');
    }

    function diagnose(command, output) {
      const haystack = ((command || '') + '\n' + (output || ''));
      for (const rule of RULES) {
        if (rule.test(haystack)) {
          return {
            matched: true,
            title: rule.title,
            why: rule.why,
            fixes: rule.fixes(haystack),
          };
        }
      }
      return { matched: false };
    }

    // ── main flow ────────────────────────────────────────────────────
    async function explainLast() {
      const text = await getRecentOutput();
      if (!text || !text.trim()) {
        api.notifications.show({
          type: 'warning',
          title: 'AI Explainer',
          message: 'No terminal output to analyze yet.',
        });
        return;
      }

      const { command, output } = extractLastCommandBlock(text);
      const result = diagnose(command, output);

      const aiPrompt = buildAiPrompt(command, output);

      let message;
      if (result.matched) {
        const fixList = result.fixes.map((f, i) => '  ' + (i + 1) + '. ' + f).join('\n');
        message = [
          (command ? 'Command:  ' + command : 'Command:  (not detected)'),
          '',
          '◆ ' + result.title,
          '',
          result.why,
          '',
          'Likely fixes:',
          fixList,
        ].join('\n');
      } else {
        const verdict = looksLikeError(output)
          ? 'This looks like an error, but it does not match a known pattern.'
          : (command
              ? 'No obvious error detected in the recent output.'
              : 'Could not isolate a command/error from the buffer.');
        message = [
          (command ? 'Command:  ' + command : 'Command:  (not detected)'),
          '',
          verdict,
          '',
          'Use "Copy AI prompt" below to ask your AI assistant with full context.',
        ].join('\n');
      }

      const res = await api.dialog.show({
        title: 'AI Explainer' + (result.matched ? ' — ' + result.title : ''),
        message,
        buttons: [
          { id: 'copy-prompt', label: 'Copy AI prompt', variant: 'secondary' },
          { id: 'ok', label: 'Close', variant: 'primary' },
        ],
      }).catch(() => null);

      const btn = res && (res.buttonId || (res.cancelled ? 'cancel' : null));
      if (btn === 'copy-prompt') {
        try {
          await api.clipboard.write(aiPrompt);
          api.notifications.show({
            type: 'success',
            title: 'AI Explainer',
            message: 'Prompt copied — paste it into your AI assistant (Cmd+V).',
          });
        } catch (_) {
          api.notifications.show({ type: 'error', title: 'AI Explainer', message: 'Could not copy prompt.' });
        }
      }
    }

    // ── register command + context menu ──────────────────────────────
    await api.commands.register('ai-explainer.explain-last', {
      title: 'Explain Last Command / Error',
      category: 'AI Explainer',
      handler: explainLast,
    });

    try {
      await api.contextMenu.register('terminal', {
        id: 'ai-explainer.explain-last',
        label: 'Explain last command / error',
        icon: 'help-circle',
        command: 'ai-explainer.explain-last',
      });
    } catch (_) { /* contextmenu optional */ }

    self.__ondaPluginDeactivate = async () => {
      try { await api.terminal.unsubscribe({ terminalId: 'active' }); } catch (_) {}
      try { await api.contextMenu.unregister('ai-explainer.explain-last'); } catch (_) {}
    };

    console.log('[AI Explainer] Activated');
  },
};
