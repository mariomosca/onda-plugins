// Agent Team Panel — read-only HUD over ~/.agent-team-os/ public read API.
//
// Pattern: filesystem polling every POLL_MS, render via panel.setContent.
// No write capabilities: the panel cannot send messages, only display.
//
// Spec contract: ~/work-hub/plans/PLAN-AGENT-TEAM-OS.md v1.3 "Public Read API"
//   - ~/.agent-team-os/AGENT_MAP.json (roster + capabilities + avatar_path)
//   - ~/.agent-team-os/registry/<agent>.json (liveness + workspace_path)
//   - ~/.agent-team-os/inboxes/<agent>/msg-*.json (pending messages)
//   - ~/.agent-team-os/threads/thread-*.json (conversation history)

self.__ondaPlugin = {
  async onActivate(api) {
    const PANEL_ID = 'main';
    const POLL_MS = 5000;
    const STALE_MIN = 10;            // registry record older than this → forced offline
    const AGENT_TEAM_DIR_REL = '/.agent-team-os';
    const ROSTER_ORDER = ['alita', 'kai', 'vera', 'leo', 'nico'];

    // Resolve absolute paths once (api.filesystem is async).
    const home = await api.filesystem.getHome();
    const ROOT = home + AGENT_TEAM_DIR_REL;

    // ──────────────────────────────────────────────────────────────
    // STATE
    // ──────────────────────────────────────────────────────────────
    let lastSnapshot = null;
    let pollTimer = null;
    let selectedAgent = null;        // when set, panel renders the agent detail view
    let lastError = null;

    // ──────────────────────────────────────────────────────────────
    // DATA LAYER
    // ──────────────────────────────────────────────────────────────
    // Reasons why a readJson call may fail. Tracked so the error UI can
    // tell the user "permission denied" vs "file genuinely missing" — the
    // remediation is different.
    let lastReadFailureKind = null;  // null | 'permission' | 'missing' | 'parse'

    /**
     * api.filesystem.readFile resolves to { content: string, error?: string }
     * (Onda's main-process readFile wraps fs.readFile this way to keep the
     * IPC contract uniform). Throws only for permission denials raised by
     * the plugin permission gate.
     */
    async function readJson(path) {
      let res;
      try {
        res = await api.filesystem.readFile(path);
      } catch (err) {
        const msg = String(err || '');
        if (msg.toLowerCase().includes('permission')) {
          lastReadFailureKind = 'permission';
        } else {
          lastReadFailureKind = 'missing';
        }
        return null;
      }

      // Some Onda builds return the raw string from readFile, others the
      // {content,error?} envelope. Handle both shapes defensively.
      let content;
      if (typeof res === 'string') {
        content = res;
      } else if (res && typeof res === 'object') {
        if (res.error) {
          const errMsg = String(res.error).toLowerCase();
          lastReadFailureKind =
            errMsg.includes('permission') ? 'permission' : 'missing';
          return null;
        }
        content = res.content;
      }
      if (typeof content !== 'string') {
        lastReadFailureKind = 'missing';
        return null;
      }

      try {
        return JSON.parse(content);
      } catch {
        lastReadFailureKind = 'parse';
        return null;
      }
    }

    async function loadAgentMap() {
      lastReadFailureKind = null;
      return await readJson(ROOT + '/AGENT_MAP.json');
    }

    async function loadRegistry(agent) {
      return await readJson(ROOT + '/registry/' + agent + '.json');
    }

    /**
     * Count pending messages in an agent's inbox. We list the directory
     * and count msg-*.json files. Read errors → 0.
     */
    async function inboxCount(agent) {
      try {
        const entries = await api.filesystem.readDir(ROOT + '/inboxes/' + agent);
        if (!Array.isArray(entries)) return 0;
        return entries.filter((e) => {
          const name = typeof e === 'string' ? e : e.name;
          return typeof name === 'string' && name.startsWith('msg-') && name.endsWith('.json');
        }).length;
      } catch {
        return 0;
      }
    }

    async function loadRecentThreads(limit = 5) {
      try {
        const entries = await api.filesystem.readDir(ROOT + '/threads');
        if (!Array.isArray(entries)) return [];
        const files = entries
          .map((e) => (typeof e === 'string' ? e : e.name))
          .filter((n) => typeof n === 'string' && n.startsWith('thread-') && n.endsWith('.json'))
          .sort()
          .reverse()
          .slice(0, limit);
        const threads = [];
        for (const file of files) {
          const data = await readJson(ROOT + '/threads/' + file);
          if (data) threads.push(data);
        }
        return threads;
      } catch {
        return [];
      }
    }

    /**
     * Build a complete snapshot of the team state. Errors per agent are
     * captured locally so one bad file doesn't blank the whole panel.
     */
    async function buildSnapshot() {
      const map = await loadAgentMap();
      if (!map || !map.agents) {
        if (lastReadFailureKind === 'permission') {
          lastError =
            'Read access to ~/.agent-team-os/ was denied. ' +
            'Open Onda Settings → Plugins → Agent Team Panel and grant ' +
            'filesystem:read for that directory, then click Refresh.';
        } else if (lastReadFailureKind === 'parse') {
          lastError = 'AGENT_MAP.json exists but is not valid JSON.';
        } else {
          lastError =
            'AGENT_MAP.json not found at ~/.agent-team-os/AGENT_MAP.json. ' +
            'Is the agent-team-os system installed?';
        }
        return null;
      }
      lastError = null;

      const order = ROSTER_ORDER.filter((id) => map.agents[id]);
      // Append any agents declared in AGENT_MAP but not in our preferred order.
      for (const id of Object.keys(map.agents)) {
        if (!order.includes(id)) order.push(id);
      }

      const agents = await Promise.all(
        order.map(async (id) => {
          const meta = map.agents[id];
          const reg = await loadRegistry(id);
          const inbox = await inboxCount(id);
          return {
            id,
            display_name: meta?.display_name || id,
            role: meta?.role || '',
            workspace_default: meta?.workspace_path || null,
            avatar_path: reg?.avatar_path || meta?.avatar_path || null,
            // Liveness rules (per v1.3 contract):
            //   active && last_seen within STALE_MIN min → 'online'
            //   active but last_seen stale            → 'idle'
            //   !active                                → 'offline'
            status: livenessOf(reg, STALE_MIN),
            workspace_path: reg?.workspace_path || null,
            last_seen: reg?.last_seen || null,
            inbox,
          };
        })
      );

      const threads = await loadRecentThreads(5);

      return {
        agents,
        threads,
        fetchedAt: new Date().toISOString(),
      };
    }

    function livenessOf(reg, staleMin) {
      if (!reg || reg.active !== true) return 'offline';
      if (!reg.last_seen) return 'idle';
      const ts = Date.parse(reg.last_seen);
      if (isNaN(ts)) return 'idle';
      const ageMin = (Date.now() - ts) / 60000;
      return ageMin <= staleMin ? 'online' : 'idle';
    }

    // ──────────────────────────────────────────────────────────────
    // RENDER LAYER
    // ──────────────────────────────────────────────────────────────
    const STATUS_COLOR = {
      online: '#22c55e',
      idle: '#eab308',
      offline: '#71717a',
    };
    const AGENT_HUE = {
      alita: '#60a5fa',
      kai: '#34d399',
      vera: '#f472b6',
      leo: '#fbbf24',
      nico: '#a78bfa',
    };

    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function relativeTime(iso) {
      if (!iso) return '';
      const ts = Date.parse(iso);
      if (isNaN(ts)) return '';
      const delta = Date.now() - ts;
      const sec = Math.round(delta / 1000);
      if (sec < 60) return sec + 's ago';
      const min = Math.round(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.round(min / 60);
      if (hr < 24) return hr + 'h ago';
      const day = Math.round(hr / 24);
      return day + 'd ago';
    }

    function renderAvatarBubble(agent) {
      const initial = (agent.display_name || agent.id).charAt(0).toUpperCase();
      const hue = AGENT_HUE[agent.id] || '#94a3b8';
      return (
        '<div style="' +
        'width:32px;height:32px;border-radius:50%;' +
        'background:' + hue + '22;' +
        'border:1px solid ' + hue + '66;' +
        'display:flex;align-items:center;justify-content:center;' +
        'color:' + hue + ';font-size:13px;font-weight:600;flex-shrink:0;' +
        '">' + esc(initial) + '</div>'
      );
    }

    function renderAgentCard(agent) {
      const dot =
        '<span style="' +
        'display:inline-block;width:8px;height:8px;border-radius:50%;' +
        'background:' + STATUS_COLOR[agent.status] + ';' +
        'box-shadow:0 0 0 2px rgba(0,0,0,0.25);' +
        '"></span>';

      const inboxBadge =
        agent.inbox > 0
          ? '<span style="background:#ef4444;color:#fff;font-size:10px;' +
            'padding:1px 6px;border-radius:9px;font-weight:600;">' +
            agent.inbox +
            '</span>'
          : '';

      const lastSeen = agent.status === 'online' ? 'online' : relativeTime(agent.last_seen);

      return (
        '<div data-action="select-agent" data-payload="' + esc(JSON.stringify({ id: agent.id })) + '" ' +
        'style="display:flex;align-items:center;gap:10px;padding:8px 10px;' +
        'border-radius:8px;cursor:pointer;transition:background 120ms;" ' +
        'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
        'onmouseout="this.style.background=\'transparent\'">' +
          renderAvatarBubble(agent) +
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span style="color:#e4e4e7;font-size:13px;font-weight:500;">' +
                esc(agent.display_name) +
              '</span>' +
              dot +
              inboxBadge +
            '</div>' +
            '<div style="color:#a1a1aa;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              esc(agent.role) +
            '</div>' +
            '<div style="color:#71717a;font-size:10px;">' + esc(lastSeen) + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    function renderThreadRow(t) {
      const status = t.status || 'open';
      const from = t.from || t.initiator || (t.messages && t.messages[0]?.from) || '?';
      const to = t.to || t.target || (t.messages && t.messages[0]?.to) || '?';
      const intent = t.intent || (t.messages && t.messages[0]?.intent) || 'message';
      const ts = t.last_updated || t.updated_at || t.created_at || null;
      const statusColor =
        status === 'completed' ? '#22c55e' : status === 'in-progress' ? '#eab308' : '#60a5fa';
      return (
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;' +
        'border-radius:6px;font-size:11px;color:#d4d4d8;">' +
          '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' +
          statusColor + ';flex-shrink:0;"></span>' +
          '<span style="color:#a1a1aa;">' + esc(from) + ' &rarr; ' + esc(to) + '</span>' +
          '<span style="color:#e4e4e7;font-weight:500;flex:1;min-width:0;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;">' + esc(intent) + '</span>' +
          '<span style="color:#71717a;font-size:10px;flex-shrink:0;">' +
            esc(relativeTime(ts)) +
          '</span>' +
        '</div>'
      );
    }

    function renderRoster(snap) {
      const cards = snap.agents.map(renderAgentCard).join('');
      const threads = snap.threads.length
        ? snap.threads.map(renderThreadRow).join('')
        : '<div style="color:#71717a;font-size:11px;padding:6px 10px;">No recent threads.</div>';

      return (
        '<div style="display:flex;flex-direction:column;gap:12px;height:100%;">' +
          '<div style="display:flex;flex-direction:column;gap:2px;">' + cards + '</div>' +
          '<div style="border-top:1px solid #27272a;padding-top:8px;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="color:#a1a1aa;font-size:10px;font-weight:600;letter-spacing:0.06em;' +
            'text-transform:uppercase;padding:0 10px;">Recent threads</div>' +
            '<div style="display:flex;flex-direction:column;gap:2px;">' + threads + '</div>' +
          '</div>' +
          '<div style="margin-top:auto;color:#52525b;font-size:9px;text-align:right;padding:0 10px 4px;">' +
            'Updated ' + esc(new Date(snap.fetchedAt).toLocaleTimeString()) +
          '</div>' +
        '</div>'
      );
    }

    function renderAgentDetail(agent, snap) {
      const threadsForAgent = snap.threads.filter((t) => {
        const from = t.from || t.initiator || (t.messages && t.messages[0]?.from);
        const to = t.to || t.target || (t.messages && t.messages[0]?.to);
        return from === agent.id || to === agent.id;
      });

      const threadsHtml = threadsForAgent.length
        ? threadsForAgent.map(renderThreadRow).join('')
        : '<div style="color:#71717a;font-size:11px;padding:6px 10px;">No threads involving ' +
          esc(agent.display_name) + '.</div>';

      return (
        '<div style="display:flex;flex-direction:column;gap:12px;height:100%;">' +
          '<div data-action="back" style="' +
          'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
          'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;" ' +
          'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
          'onmouseout="this.style.background=\'transparent\'">' +
            '&larr; back to roster' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;padding:0 10px;">' +
            renderAvatarBubble(agent) +
            '<div style="display:flex;flex-direction:column;gap:2px;">' +
              '<div style="color:#e4e4e7;font-size:15px;font-weight:600;">' +
                esc(agent.display_name) +
              '</div>' +
              '<div style="color:#a1a1aa;font-size:11px;">' + esc(agent.role) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;padding:0 10px;font-size:11px;color:#d4d4d8;">' +
            '<div><span style="color:#71717a;">status:</span> ' + esc(agent.status) + '</div>' +
            '<div><span style="color:#71717a;">workspace:</span> ' +
              esc(agent.workspace_path || agent.workspace_default || '—') +
            '</div>' +
            '<div><span style="color:#71717a;">last seen:</span> ' +
              esc(relativeTime(agent.last_seen)) +
            '</div>' +
            '<div><span style="color:#71717a;">inbox:</span> ' + esc(String(agent.inbox)) + '</div>' +
          '</div>' +
          '<div style="border-top:1px solid #27272a;padding-top:8px;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="color:#a1a1aa;font-size:10px;font-weight:600;letter-spacing:0.06em;' +
            'text-transform:uppercase;padding:0 10px;">Threads</div>' +
            '<div style="display:flex;flex-direction:column;gap:2px;">' + threadsHtml + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    function renderError(msg) {
      return (
        '<div style="padding:16px;color:#fca5a5;font-size:12px;line-height:1.5;">' +
          '<div style="font-weight:600;margin-bottom:6px;">Cannot read Agent Team OS</div>' +
          '<div style="color:#fecaca;">' + esc(msg) + '</div>' +
          '<div style="margin-top:10px;color:#a1a1aa;font-size:11px;">' +
            'Verify that <code>~/.agent-team-os/AGENT_MAP.json</code> exists ' +
            'and that this plugin has read permission for the directory.' +
          '</div>' +
        '</div>'
      );
    }

    function renderEmpty() {
      return (
        '<div style="padding:16px;color:#a1a1aa;font-size:12px;">Loading team…</div>'
      );
    }

    async function rerender() {
      if (lastError) {
        await api.panel.setContent(PANEL_ID, renderError(lastError));
        return;
      }
      if (!lastSnapshot) {
        await api.panel.setContent(PANEL_ID, renderEmpty());
        return;
      }
      if (selectedAgent) {
        const agent = lastSnapshot.agents.find((a) => a.id === selectedAgent);
        if (agent) {
          await api.panel.setContent(PANEL_ID, renderAgentDetail(agent, lastSnapshot));
          return;
        }
        selectedAgent = null;
      }
      await api.panel.setContent(PANEL_ID, renderRoster(lastSnapshot));
    }

    // ──────────────────────────────────────────────────────────────
    // POLLING + LIFECYCLE
    // ──────────────────────────────────────────────────────────────
    async function tick() {
      try {
        const snap = await buildSnapshot();
        if (snap) lastSnapshot = snap;
      } catch (err) {
        lastError = String(err);
      }
      await rerender();
      await refreshEntryBadges();
    }

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => { void tick(); }, POLL_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    // ──────────────────────────────────────────────────────────────
    // REGISTER PANEL + COMMANDS + ACTIONS
    // ──────────────────────────────────────────────────────────────
    await api.panel.register({
      id: PANEL_ID,
      title: 'Agent Team',
      icon: 'users',
      position: 'floating',
      floating: {
        defaultSize: { width: 360, height: 560 },
        defaultPosition: 'bottom-right',
        minimizable: true,
      },
    });
    await api.panel.setContent(PANEL_ID, renderEmpty());

    // Use api.panel.toggle(id) directly — Onda's plugin store is the
    // source of truth for visibility, so a stale local flag (e.g. when
    // the user closes the panel with its X button) can't desync the
    // entry-point buttons.
    async function showPanel() { await api.panel.show(PANEL_ID); }
    async function togglePanel() { await api.panel.toggle(PANEL_ID); }

    await showPanel();

    // Initial fetch + start polling
    await tick();
    startPolling();

    // ──────────────────────────────────────────────────────────────
    // ENTRY POINTS — AppRail icon (tabs mode) + status bar (both modes)
    // ──────────────────────────────────────────────────────────────
    const APP_RAIL_ID = 'team-panel.rail';
    const STATUS_BAR_ID = 'team-panel.statusbar';

    try {
      await api.appRail.addItem({
        id: APP_RAIL_ID,
        icon: 'users',
        tooltip: 'Agent Team',
        priority: 50,
      });
    } catch (_) { /* capability may not be available in some modes */ }

    try {
      await api.statusBar.addItem({
        id: STATUS_BAR_ID,
        text: 'Team',
        icon: 'users',
        tooltip: 'Toggle Agent Team panel',
        position: 'right',
        priority: 100,
        onClick: 'team-panel.toggle',
      });
    } catch (_) { /* statusbar capability missing — fine */ }

    /**
     * Update appRail badge + statusbar text with the total pending inbox
     * count across all agents. Called after every snapshot refresh.
     */
    async function refreshEntryBadges() {
      if (!lastSnapshot) return;
      const totalInbox = lastSnapshot.agents.reduce((acc, a) => acc + (a.inbox || 0), 0);
      const onlineCount = lastSnapshot.agents.filter((a) => a.status === 'online').length;

      try {
        await api.appRail.updateItem(APP_RAIL_ID, {
          badge: totalInbox > 0 ? String(totalInbox) : undefined,
          tooltip:
            'Agent Team — ' + onlineCount + ' online' +
            (totalInbox > 0 ? ', ' + totalInbox + ' pending' : ''),
        });
      } catch (_) {}

      try {
        await api.statusBar.updateItem(STATUS_BAR_ID, {
          text: totalInbox > 0 ? 'Team (' + totalInbox + ')' : 'Team',
          color: totalInbox > 0 ? 'warning' : undefined,
          tooltip:
            'Agent Team — ' + onlineCount + ' online' +
            (totalInbox > 0 ? ', ' + totalInbox + ' pending' : ''),
        });
      } catch (_) {}
    }

    // Click handlers
    api.panel.onAction('select-agent', async (data) => {
      const payload = typeof data === 'string' ? safeParse(data) : data;
      selectedAgent = payload?.id || null;
      await rerender();
    });
    api.panel.onAction('back', async () => {
      selectedAgent = null;
      await rerender();
    });

    // Commands
    api.commands.register('team-panel.toggle', {
      title: 'Toggle Team Panel',
      category: 'Team',
      handler: async () => { await togglePanel(); },
    });
    api.commands.register('team-panel.refresh', {
      title: 'Refresh Team Panel',
      category: 'Team',
      handler: async () => { await tick(); },
    });

    function safeParse(s) {
      try { return JSON.parse(s); } catch { return null; }
    }

    // Cleanup if Onda deactivates the plugin at runtime
    self.__ondaPluginDeactivate = async () => {
      stopPolling();
      try { await api.appRail.removeItem(APP_RAIL_ID); } catch (_) {}
      try { await api.statusBar.removeItem(STATUS_BAR_ID); } catch (_) {}
    };
  },
};
