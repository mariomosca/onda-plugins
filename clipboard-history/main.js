/**
 * Clipboard History Plugin for Onda
 *
 * Polls the system clipboard, keeps the last N distinct text entries in
 * persistent storage, and renders them in a floating panel where each entry
 * can be re-copied with one click. Entries can be pinned (kept at the top,
 * never evicted) and the whole history can be cleared.
 *
 * Pattern follows team-panel: a floating panel rendered via panel.setContent,
 * click handlers wired through panel.onAction, an appRail/statusbar entry
 * point, and a polling loop. No external dependencies.
 */

self.__ondaPlugin = {
  async onActivate(api) {
    const PANEL_ID = 'main';
    const STATUS_ID = 'clipboard-history.statusbar';
    const STORAGE_KEY = 'history';
    const MAX_ENTRIES = 50;
    const POLL_MS = 1500;

    // entry: { id, text, pinned, ts }
    let history = [];
    let lastClipboard = null;
    let pollTimer = null;
    let lastHtml = '';

    // ── persistence ──────────────────────────────────────────────────
    async function load() {
      try {
        const raw = await api.storage.get(STORAGE_KEY);
        if (Array.isArray(raw)) { history = raw; return; }
        // Be tolerant of plugins that stored a JSON string.
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) history = parsed;
        }
      } catch (_) { history = []; }
    }

    async function persist() {
      try { await api.storage.set(STORAGE_KEY, history); } catch (_) {}
    }

    // ── clipboard polling ────────────────────────────────────────────
    async function readClipboard() {
      try {
        const res = await api.clipboard.read();
        if (typeof res === 'string') return res;
        if (res && typeof res.text === 'string') return res.text;
      } catch (_) {}
      return null;
    }

    function addEntry(text) {
      if (!text || !text.trim()) return false;
      // Skip if identical to the most recent (non-pinned-aware) entry.
      const existingIdx = history.findIndex((e) => e.text === text);
      if (existingIdx !== -1) {
        // Bump to top (preserving pinned flag) only if not already first.
        const [e] = history.splice(existingIdx, 1);
        e.ts = Date.now();
        history.unshift(e);
        return true;
      }
      history.unshift({
        id: 'c' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        text,
        pinned: false,
        ts: Date.now(),
      });
      evict();
      return true;
    }

    function evict() {
      const pinned = history.filter((e) => e.pinned);
      const unpinned = history.filter((e) => !e.pinned);
      const room = Math.max(0, MAX_ENTRIES - pinned.length);
      const keptUnpinned = unpinned.slice(0, room);
      // Reassemble preserving recency order overall.
      history = history.filter((e) => e.pinned || keptUnpinned.includes(e));
    }

    async function tick() {
      const current = await readClipboard();
      if (current != null && current !== lastClipboard) {
        lastClipboard = current;
        if (addEntry(current)) {
          await persist();
          await render();
          await refreshStatusBar();
        }
      }
    }

    // ── rendering ────────────────────────────────────────────────────
    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function relTime(ts) {
      if (!ts) return '';
      const sec = Math.round((Date.now() - ts) / 1000);
      if (sec < 60) return sec + 's ago';
      const min = Math.round(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.round(min / 60);
      if (hr < 24) return hr + 'h ago';
      return Math.round(hr / 24) + 'd ago';
    }

    function preview(text) {
      const oneLine = text.replace(/\s+/g, ' ').trim();
      return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
    }

    function renderRow(e) {
      const pinColor = e.pinned ? '#fbbf24' : '#52525b';
      const payload = esc(JSON.stringify({ id: e.id }));
      return (
        '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;' +
        'border-radius:8px;border:1px solid #27272a;background:rgba(255,255,255,0.02);' +
        'transition:background 120ms;" ' +
        'onmouseover="this.style.background=\'rgba(255,255,255,0.05)\'" ' +
        'onmouseout="this.style.background=\'rgba(255,255,255,0.02)\'">' +
          '<div data-action="copy" data-payload="' + payload + '" ' +
          'style="flex:1;min-width:0;cursor:pointer;display:flex;flex-direction:column;gap:3px;" ' +
          'title="Click to copy">' +
            '<div style="font-size:11px;color:#e4e4e7;font-family:ui-monospace,Menlo,monospace;' +
            'white-space:pre-wrap;word-break:break-word;line-height:1.4;max-height:54px;overflow:hidden;">' +
              esc(preview(e.text)) +
            '</div>' +
            '<div style="font-size:9px;color:#71717a;">' +
              esc(relTime(e.ts)) + ' · ' + e.text.length + ' chars' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">' +
            '<span data-action="pin" data-payload="' + payload + '" ' +
            'title="' + (e.pinned ? 'Unpin' : 'Pin') + '" ' +
            'style="cursor:pointer;font-size:13px;line-height:1;color:' + pinColor + ';">★</span>' +
            '<span data-action="delete" data-payload="' + payload + '" ' +
            'title="Remove" ' +
            'style="cursor:pointer;font-size:13px;line-height:1;color:#52525b;">✕</span>' +
          '</div>' +
        '</div>'
      );
    }

    function renderPanel() {
      const header =
        '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'padding:0 4px 8px;border-bottom:1px solid #27272a;margin-bottom:8px;">' +
          '<div style="color:#a1a1aa;font-size:10px;font-weight:600;letter-spacing:0.06em;' +
          'text-transform:uppercase;">History · ' + history.length + '</div>' +
          '<span data-action="clear" style="cursor:pointer;color:#f87171;font-size:10px;' +
          'padding:2px 6px;border-radius:4px;" ' +
          'onmouseover="this.style.background=\'rgba(248,113,113,0.12)\'" ' +
          'onmouseout="this.style.background=\'transparent\'">Clear all</span>' +
        '</div>';

      if (!history.length) {
        return (
          '<div style="display:flex;flex-direction:column;height:100%;padding:8px;">' +
            header +
            '<div style="color:#71717a;font-size:12px;padding:24px 12px;text-align:center;line-height:1.6;">' +
              'No clipboard entries yet.<br/>Copy something (Cmd+C) and it will appear here.' +
            '</div>' +
          '</div>'
        );
      }

      const rows = history.map(renderRow).join('');
      return (
        '<div style="display:flex;flex-direction:column;height:100%;padding:8px;overflow:hidden;">' +
          header +
          '<div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">' +
            rows +
          '</div>' +
        '</div>'
      );
    }

    async function render() {
      const html = renderPanel();
      if (html === lastHtml) return;
      lastHtml = html;
      try { await api.panel.setContent(PANEL_ID, html); } catch (_) {}
    }

    // ── status bar ───────────────────────────────────────────────────
    async function refreshStatusBar() {
      try {
        await api.statusBar.updateItem(STATUS_ID, {
          text: 'Clip (' + history.length + ')',
          tooltip: 'Clipboard History — ' + history.length + ' entries',
        });
      } catch (_) {}
    }

    // ── actions ──────────────────────────────────────────────────────
    function findEntry(id) { return history.find((e) => e.id === id); }
    function parse(d) { try { return typeof d === 'string' ? JSON.parse(d) : d; } catch { return null; } }

    api.panel.onAction('copy', async (data) => {
      const p = parse(data);
      const e = p && findEntry(p.id);
      if (!e) return;
      try {
        await api.clipboard.write(e.text);
        lastClipboard = e.text; // avoid re-capturing our own write
        api.notifications.show({ type: 'success', title: 'Clipboard History', message: 'Copied to clipboard.' });
      } catch (_) {
        api.notifications.show({ type: 'error', title: 'Clipboard History', message: 'Copy failed.' });
      }
    });

    api.panel.onAction('pin', async (data) => {
      const p = parse(data);
      const e = p && findEntry(p.id);
      if (!e) return;
      e.pinned = !e.pinned;
      // Keep pinned entries floated to the top.
      history.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
      await persist();
      lastHtml = '';
      await render();
    });

    api.panel.onAction('delete', async (data) => {
      const p = parse(data);
      if (!p) return;
      history = history.filter((e) => e.id !== p.id);
      await persist();
      lastHtml = '';
      await render();
      await refreshStatusBar();
    });

    api.panel.onAction('clear', async () => {
      history = [];
      await persist();
      lastHtml = '';
      await render();
      await refreshStatusBar();
      api.notifications.show({ type: 'info', title: 'Clipboard History', message: 'History cleared.' });
    });

    // ── panel + commands + entry points ──────────────────────────────
    await api.panel.register({
      id: PANEL_ID,
      title: 'Clipboard History',
      icon: 'clipboard',
      position: 'floating',
      floating: {
        defaultSize: { width: 360, height: 480 },
        defaultPosition: 'bottom-right',
        minimizable: true,
      },
    });

    await api.commands.register('clipboard-history.toggle', {
      title: 'Toggle Clipboard History',
      category: 'Clipboard',
      handler: async () => { try { await api.panel.toggle(PANEL_ID); } catch (_) {} },
    });

    await api.commands.register('clipboard-history.clear', {
      title: 'Clear Clipboard History',
      category: 'Clipboard',
      handler: async () => {
        history = [];
        await persist();
        lastHtml = '';
        await render();
        await refreshStatusBar();
        api.notifications.show({ type: 'info', title: 'Clipboard History', message: 'History cleared.' });
      },
    });

    try {
      await api.statusBar.addItem({
        id: STATUS_ID,
        text: 'Clip (0)',
        icon: 'clipboard',
        tooltip: 'Toggle Clipboard History',
        position: 'right',
        priority: 90,
        onClick: 'clipboard-history.toggle',
      });
    } catch (_) {}

    // ── boot ─────────────────────────────────────────────────────────
    await load();
    // Seed lastClipboard with current value so the existing clipboard
    // contents aren't re-injected as a "new" capture on startup.
    lastClipboard = await readClipboard();
    if (lastClipboard) { addEntry(lastClipboard); await persist(); }

    await api.panel.setContent(PANEL_ID, renderPanel());
    await refreshStatusBar();

    pollTimer = setInterval(() => { void tick(); }, POLL_MS);

    self.__ondaPluginDeactivate = async () => {
      if (pollTimer) clearInterval(pollTimer);
      try { await api.statusBar.removeItem(STATUS_ID); } catch (_) {}
    };

    console.log('[Clipboard History] Activated');
  },
};
