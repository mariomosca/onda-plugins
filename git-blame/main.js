/**
 * Git Blame Plugin for Onda
 *
 * Surfaces git authorship for the repository in the active terminal's
 * working directory. Two entry points:
 *   - "Show Last Commit": HEAD author / short-hash / relative date / subject,
 *     shown in a dialog and mirrored to the status bar.
 *   - "Blame a File…": runs `git blame` on a path and shows the most recent
 *     line authors.
 *
 * Uses the `exec` capability (whitelisted to `git *`). exec.run() runs in the
 * active terminal's working directory when no cwd is passed, so the plugin is
 * automatically scoped to "the repo I'm currently looking at".
 */

self.__ondaPlugin = {
  async onActivate(api) {
    const STATUS_ID = 'git-blame.statusbar';

    // ── helpers ──────────────────────────────────────────────────────
    async function run(cmd) {
      // Returns { stdout, stderr, exitCode }. exec defaults to the active
      // terminal cwd; no second arg keeps us scoped to the current repo.
      try {
        return await api.exec.run(cmd);
      } catch (err) {
        return { stdout: '', stderr: String(err && err.message || err), exitCode: 1 };
      }
    }

    function clean(s) {
      return (s || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    }

    async function isGitRepo() {
      const r = await run('git rev-parse --is-inside-work-tree');
      return r.exitCode === 0 && clean(r.stdout) === 'true';
    }

    async function getRepoName() {
      const r = await run('git rev-parse --show-toplevel');
      if (r.exitCode !== 0) return null;
      const top = clean(r.stdout);
      const parts = top.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : top;
    }

    async function getLastCommit() {
      // %h short hash, %an author, %ar relative age, %s subject, %D refs
      const fmt = '%h%x1f%an%x1f%ar%x1f%cd%x1f%s%x1f%D';
      const r = await run('git log -1 --date=format:"%Y-%m-%d %H:%M" --pretty=format:"' + fmt + '"');
      if (r.exitCode !== 0) return null;
      const line = clean(r.stdout);
      if (!line) return null;
      const [hash, author, relative, date, subject, refs] = line.split('\x1f');
      return { hash, author, relative, date, subject, refs: (refs || '').trim() };
    }

    async function getBranch() {
      const r = await run('git rev-parse --abbrev-ref HEAD');
      return r.exitCode === 0 ? clean(r.stdout) : null;
    }

    // ── status bar: keep HEAD author visible ─────────────────────────
    try {
      await api.statusBar.addItem({
        id: STATUS_ID,
        text: '',
        icon: 'git-commit',
        tooltip: 'Git Blame — last commit',
        position: 'left',
        priority: 80,
        onClick: 'git-blame.show-last-commit',
      });
    } catch (_) { /* statusbar unavailable in this mode — fine */ }

    async function refreshStatusBar() {
      try {
        if (!(await isGitRepo())) {
          await api.statusBar.updateItem(STATUS_ID, { text: '', tooltip: 'Git Blame — no repo here' });
          return;
        }
        const c = await getLastCommit();
        if (!c) {
          await api.statusBar.updateItem(STATUS_ID, { text: '', tooltip: 'Git Blame — no commits' });
          return;
        }
        await api.statusBar.updateItem(STATUS_ID, {
          text: c.hash + ' · ' + c.author,
          tooltip: c.subject + '  (' + c.relative + ')',
        });
      } catch (_) { /* ignore */ }
    }

    // ── command: show last commit ────────────────────────────────────
    await api.commands.register('git-blame.show-last-commit', {
      title: 'Show Last Commit (current repo)',
      category: 'Git Blame',
      handler: async () => {
        if (!(await isGitRepo())) {
          api.notifications.show({
            type: 'warning',
            title: 'Git Blame',
            message: 'The active terminal is not inside a git work tree.',
          });
          return;
        }

        const [repo, branch, commit] = await Promise.all([
          getRepoName(), getBranch(), getLastCommit(),
        ]);

        if (!commit) {
          api.notifications.show({
            type: 'info',
            title: 'Git Blame',
            message: 'Repository has no commits yet.',
          });
          return;
        }

        const lines = [
          'Repo:    ' + (repo || '(unknown)'),
          'Branch:  ' + (branch || '(detached)'),
          '',
          'Commit:  ' + commit.hash,
          'Author:  ' + commit.author,
          'Date:    ' + commit.date + '  (' + commit.relative + ')',
          'Subject: ' + commit.subject,
        ];
        if (commit.refs) lines.push('Refs:    ' + commit.refs);

        await refreshStatusBar();

        await api.dialog.show({
          title: 'Last Commit — ' + (repo || 'repo'),
          message: lines.join('\n'),
          buttons: [
            { id: 'copy', label: 'Copy Hash', variant: 'secondary' },
            { id: 'ok', label: 'Close', variant: 'primary' },
          ],
        }).then(async (res) => {
          const btn = res && (res.buttonId || (res.cancelled ? 'cancel' : null));
          if (btn === 'copy') {
            try {
              await api.clipboard.write(commit.hash);
              api.notifications.show({ type: 'success', title: 'Git Blame', message: 'Commit hash copied.' });
            } catch (_) {
              api.notifications.show({ type: 'info', title: 'Git Blame', message: commit.hash });
            }
          }
        }).catch(() => {});
      },
    });

    // ── command: blame a file ────────────────────────────────────────
    await api.commands.register('git-blame.blame-file', {
      title: 'Blame a File…',
      category: 'Git Blame',
      handler: async () => {
        if (!(await isGitRepo())) {
          api.notifications.show({
            type: 'warning',
            title: 'Git Blame',
            message: 'The active terminal is not inside a git work tree.',
          });
          return;
        }

        const res = await api.dialog.show({
          title: 'Blame a File',
          message: 'Path relative to the repo (or absolute):',
          fields: [
            { id: 'path', label: 'File path', type: 'text', placeholder: 'src/index.ts', required: true },
          ],
          buttons: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            { id: 'blame', label: 'Blame', variant: 'primary' },
          ],
        });

        // Support both documented dialog return shapes.
        const btn = res && (res.buttonId || (res.cancelled ? 'cancel' : 'blame'));
        const values = (res && (res.fields || res.values)) || {};
        const path = (values.path || '').trim();
        if (btn === 'cancel' || !path) return;

        // -L picks a window; here we summarize the most recent authors per
        // line across the whole file via porcelain, then de-dup by author.
        const safePath = path.includes(' ') ? '"' + path + '"' : path;
        const r = await run('git log -1 --pretty=format:"%h %an %ar %s" -- ' + safePath);
        const lastTouch = clean(r.stdout);

        const blame = await run('git blame --date=short -- ' + safePath);
        if (blame.exitCode !== 0) {
          api.notifications.show({
            type: 'error',
            title: 'Git Blame',
            message: clean(blame.stderr) || 'git blame failed for ' + path,
          });
          return;
        }

        // Parse author counts from default blame format:
        //   <hash> (<Author Name> <date> <time> <tz> <lineno>) <code>
        const counts = {};
        let total = 0;
        for (const ln of clean(blame.stdout).split('\n')) {
          const m = ln.match(/\(([^\d][^\)]*?)\s+\d{4}-\d{2}-\d{2}/);
          if (m) {
            const author = m[1].trim();
            counts[author] = (counts[author] || 0) + 1;
            total++;
          }
        }
        const ranked = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([author, n]) => {
            const pct = total ? Math.round((n / total) * 100) : 0;
            return '  ' + String(pct + '%').padStart(4) + '  ' + author + '  (' + n + ' lines)';
          });

        const lines = [
          'File:  ' + path,
          'Lines: ' + total,
          '',
          'Last touched:',
          '  ' + (lastTouch || '(no history)'),
          '',
          'Top authors by line ownership:',
          ...(ranked.length ? ranked : ['  (no blame data)']),
        ];

        await api.dialog.show({
          title: 'Blame — ' + path,
          message: lines.join('\n'),
          buttons: [{ id: 'ok', label: 'Close', variant: 'primary' }],
        }).catch(() => {});
      },
    });

    // Initial paint + light refresh loop so the status bar tracks the repo
    // the user is currently working in.
    await refreshStatusBar();
    const timer = setInterval(() => { void refreshStatusBar(); }, 15000);

    self.__ondaPluginDeactivate = async () => {
      clearInterval(timer);
      try { await api.statusBar.removeItem(STATUS_ID); } catch (_) {}
    };

    console.log('[Git Blame] Activated');
  },
};
