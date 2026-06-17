/**
 * Onda Themes Pack
 *
 * Ships 5 curated dark themes. The themes themselves are contributed
 * declaratively via `contributes.themes` in the manifest (the recommended,
 * lowest-risk path), so they are registered by Onda at load time. This runtime
 * code adds the *interaction*:
 *   - "Cycle Through Pack Themes" (Cmd+Shift+T) rotates the active theme
 *     through the pack.
 *   - "Pick a Theme…" shows a picker dialog.
 * The chosen theme id is remembered in plugin storage and re-applied on the
 * next activation, so the selection survives restarts.
 *
 * Theme ids are namespaced by Onda as `<pluginId>.<themeId>` when activating
 * (per the api.themes docs), so we build the fully-qualified id from our
 * plugin id.
 */

self.__ondaPlugin = {
  async onActivate(api) {
    const PLUGIN_ID = 'themes-pack';
    const STORAGE_KEY = 'activeTheme';

    // Must mirror the ids declared in manifest.contributes.themes.
    const PACK = [
      { id: 'nord-aurora', name: 'Nord Aurora' },
      { id: 'solarized-deep', name: 'Solarized Deep' },
      { id: 'tokyo-night', name: 'Tokyo Night' },
      { id: 'gruvbox-material', name: 'Gruvbox Material' },
      { id: 'catppuccin-mocha', name: 'Catppuccin Mocha' },
    ];

    const fq = (id) => PLUGIN_ID + '.' + id;

    async function activate(themeId) {
      const full = fq(themeId);
      await api.themes.activate(full);
      try { await api.storage.set(STORAGE_KEY, themeId); } catch (_) {}
      const meta = PACK.find((t) => t.id === themeId);
      api.notifications.show({
        type: 'success',
        title: 'Themes Pack',
        message: 'Activated ' + (meta ? meta.name : themeId) + '.',
      });
    }

    // Determine which pack theme (if any) is currently active so cycle picks
    // the *next* one rather than always restarting at index 0.
    async function currentPackIndex() {
      // First trust our own stored choice.
      try {
        const stored = await api.storage.get(STORAGE_KEY);
        const idx = PACK.findIndex((t) => t.id === stored);
        if (idx !== -1) return idx;
      } catch (_) {}
      // Fall back to whatever Onda reports as current.
      try {
        const cur = await api.themes.getCurrent();
        const curId = cur && (cur.id || '');
        const idx = PACK.findIndex((t) => fq(t.id) === curId || t.id === curId);
        if (idx !== -1) return idx;
      } catch (_) {}
      return -1;
    }

    // ── commands ─────────────────────────────────────────────────────
    await api.commands.register('themes-pack.cycle', {
      title: 'Cycle Through Pack Themes',
      category: 'Themes',
      handler: async () => {
        try {
          const idx = await currentPackIndex();
          const next = PACK[(idx + 1) % PACK.length];
          await activate(next.id);
        } catch (err) {
          api.notifications.show({
            type: 'error',
            title: 'Themes Pack',
            message: 'Could not switch theme: ' + (err && err.message || err),
          });
        }
      },
    });

    await api.commands.register('themes-pack.pick', {
      title: 'Pick a Theme…',
      category: 'Themes',
      handler: async () => {
        let curId = null;
        try {
          curId = await api.storage.get(STORAGE_KEY);
        } catch (_) {}

        const list = PACK
          .map((t, i) => '  ' + (i + 1) + '. ' + t.name + (t.id === curId ? '  (active)' : ''))
          .join('\n');

        const res = await api.dialog.show({
          title: 'Pick a Theme',
          message: 'Enter the number of the theme to activate:\n\n' + list,
          fields: [
            { id: 'choice', label: 'Number (1-' + PACK.length + ')', type: 'text', placeholder: '1', required: true },
          ],
          buttons: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            { id: 'apply', label: 'Apply', variant: 'primary' },
          ],
        }).catch(() => null);

        if (!res) return;
        const btn = res.buttonId || (res.cancelled ? 'cancel' : 'apply');
        if (btn === 'cancel') return;
        const values = res.fields || res.values || {};
        const n = parseInt(String(values.choice || '').trim(), 10);
        if (!Number.isInteger(n) || n < 1 || n > PACK.length) {
          api.notifications.show({ type: 'warning', title: 'Themes Pack', message: 'Invalid choice.' });
          return;
        }
        try {
          await activate(PACK[n - 1].id);
        } catch (err) {
          api.notifications.show({
            type: 'error',
            title: 'Themes Pack',
            message: 'Could not activate theme: ' + (err && err.message || err),
          });
        }
      },
    });

    // ── restore previous selection ───────────────────────────────────
    // If the user previously picked one of our themes, re-apply it. We do this
    // best-effort and silently — failure just means Onda keeps its own theme.
    try {
      const stored = await api.storage.get(STORAGE_KEY);
      if (stored && PACK.some((t) => t.id === stored)) {
        try { await api.themes.activate(fq(stored)); } catch (_) {}
      }
    } catch (_) {}

    console.log('[Themes Pack] Activated with ' + PACK.length + ' themes');
  },
};
