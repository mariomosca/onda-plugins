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

    /**
     * Cache of avatar → data URL keyed by absolute path. We probe a small
     * list of extensions (png/jpg/jpeg/webp) so the user can swap formats
     * after cropping in Preview.app without renaming. Cache is invalidated
     * only by a plugin reload — fine, avatars change rarely.
     */
    const avatarCache = new Map();

    async function tryReadBinary(absPath) {
      if (typeof api.filesystem.readFileBinary !== 'function') return null;
      try {
        const res = await api.filesystem.readFileBinary(absPath);
        if (res && res.base64 && !res.error) return res;
      } catch (_) { /* fallthrough */ }
      return null;
    }

    async function loadAvatarDataUrl(absPath) {
      if (!absPath) return null;
      if (avatarCache.has(absPath)) return avatarCache.get(absPath);

      // Candidate paths: the declared one first, then the same path with
      // each common image extension (so a `.png` registry entry still
      // finds an existing `.jpeg` next to it).
      const candidates = [absPath];
      const lastDot = absPath.lastIndexOf('.');
      const base = lastDot > 0 ? absPath.slice(0, lastDot) : absPath;
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
        const variant = base + ext;
        if (variant !== absPath) candidates.push(variant);
      }

      for (const candidate of candidates) {
        const res = await tryReadBinary(candidate);
        if (res) {
          const mime = res.mimeType || 'image/png';
          const dataUrl = 'data:' + mime + ';base64,' + res.base64;
          avatarCache.set(absPath, dataUrl);
          return dataUrl;
        }
      }

      avatarCache.set(absPath, null);
      return null;
    }

    // ──────────────────────────────────────────────────────────────
    // STATE
    // ──────────────────────────────────────────────────────────────
    let lastSnapshot = null;
    let pollTimer = null;
    let selectedAgent = null;        // when set, panel renders the agent detail view
    let selectedThread = null;       // when set, panel renders a thread reader view
    let selectedInboxMsg = null;     // { agent, file_name } when reading a pending inbox msg
    let lastError = null;

    // Dedup caches — declared up here so the `let` initialization runs
    // before any of the helpers below references them (avoids TDZ errors
    // when the bundler reorders things).
    let lastPushedHtml = '';
    let lastEntrySignature = '';
    let lastMinimizedHtml = '';

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

    /**
     * Load the pending message envelopes for an agent (msg-*.json files in
     * the inboxes directory). Returns up to `limit` most recent by name.
     */
    async function loadInboxMessages(agent, limit = 20) {
      try {
        const entries = await api.filesystem.readDir(ROOT + '/inboxes/' + agent);
        if (!Array.isArray(entries)) return [];
        const names = entries
          .map((e) => (typeof e === 'string' ? e : e.name))
          .filter((n) => typeof n === 'string' && n.startsWith('msg-') && n.endsWith('.json'))
          .sort()
          .reverse()
          .slice(0, limit);
        const msgs = [];
        for (const n of names) {
          const data = await readJson(ROOT + '/inboxes/' + agent + '/' + n);
          if (data) {
            data._file_name = n;
            msgs.push(data);
          }
        }
        return msgs;
      } catch {
        return [];
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
          if (data) {
            // Capture the filename id so we can re-fetch the same thread
            // later (the JSON usually has its own `thread_id` but falling
            // back to the filename is safer if the writer skips it).
            data._file_id = file.replace(/\.json$/, '');
            threads.push(data);
          }
        }
        return threads;
      } catch {
        return [];
      }
    }

    async function loadThreadById(threadFileId) {
      if (!threadFileId) return null;
      const data = await readJson(ROOT + '/threads/' + threadFileId + '.json');
      if (data) data._file_id = threadFileId;
      return data;
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
          // Avatar fallback chain (per v1.3 contract):
          //   registry.avatar_path > AGENT_MAP.avatar_path > avatar_default_path
          const avatarPath =
            reg?.avatar_path || meta?.avatar_path || meta?.avatar_default_path || null;
          const avatarDataUrl = await loadAvatarDataUrl(avatarPath);
          return {
            id,
            display_name: meta?.display_name || id,
            role: meta?.role || '',
            workspace_default: meta?.workspace_path || null,
            avatar_path: avatarPath,
            avatar_data_url: avatarDataUrl,
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

    function renderAvatarBubble(agent, size) {
      const s = size || 32;
      const hue = AGENT_HUE[agent.id] || '#94a3b8';
      if (agent.avatar_data_url) {
        return (
          '<img src="' + esc(agent.avatar_data_url) + '" ' +
          'alt="' + esc(agent.display_name) + '" ' +
          'style="width:' + s + 'px;height:' + s + 'px;border-radius:50%;' +
          'object-fit:cover;flex-shrink:0;' +
          'border:1.5px solid ' + hue + '66;background:' + hue + '11;" />'
        );
      }
      // Fallback: initial bubble
      const initial = (agent.display_name || agent.id).charAt(0).toUpperCase();
      return (
        '<div style="' +
        'width:' + s + 'px;height:' + s + 'px;border-radius:50%;' +
        'background:' + hue + '22;' +
        'border:1px solid ' + hue + '66;' +
        'display:flex;align-items:center;justify-content:center;' +
        'color:' + hue + ';font-size:' + Math.round(s * 0.4) + 'px;font-weight:600;flex-shrink:0;' +
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
      const fileId = t._file_id || '';
      const payload = JSON.stringify({ file_id: fileId });
      return (
        '<div data-action="select-thread" data-payload="' + esc(payload) + '" ' +
        'style="display:flex;align-items:center;gap:8px;padding:6px 10px;' +
        'border-radius:6px;font-size:11px;color:#d4d4d8;cursor:pointer;transition:background 120ms;" ' +
        'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
        'onmouseout="this.style.background=\'transparent\'">' +
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

    function renderInboxMsgReader(msg, agentId) {
      if (!msg) {
        return (
          '<div style="display:flex;flex-direction:column;gap:12px;height:100%;">' +
            '<div data-action="back" style="' +
            'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
            'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;" ' +
            'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
            'onmouseout="this.style.background=\'transparent\'">' +
              '&larr; back' +
            '</div>' +
            '<div style="padding:16px;color:#a1a1aa;font-size:12px;">Message not found.</div>' +
          '</div>'
        );
      }
      const from = msg.from || '?';
      const intent = msg.intent || msg.type || 'message';
      const ts = msg.ts || msg.created_at || null;
      const priority = msg.priority || 'normal';
      const body =
        typeof msg.payload === 'string'
          ? msg.payload
          : msg.payload && typeof msg.payload === 'object'
          ? JSON.stringify(msg.payload, null, 2)
          : msg.body || msg.text || '';
      const refs = Array.isArray(msg.context_refs) ? msg.context_refs : [];
      const fromColor = AGENT_HUE[from] || '#94a3b8';

      return (
        '<div style="display:flex;flex-direction:column;gap:10px;height:100%;overflow:hidden;">' +
          '<div data-action="back" style="' +
          'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
          'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;flex-shrink:0;" ' +
          'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
          'onmouseout="this.style.background=\'transparent\'">' +
            '&larr; back to ' + esc(agentId) +
          '</div>' +
          '<div style="padding:0 10px;display:flex;flex-direction:column;gap:6px;flex-shrink:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="color:' + fromColor + ';font-size:13px;font-weight:600;">' +
                esc(from) + ' &rarr; ' + esc(agentId) +
              '</span>' +
              '<span style="background:#27272a;color:#d4d4d8;font-size:10px;padding:1px 6px;' +
              'border-radius:9px;">' + esc(priority) + '</span>' +
            '</div>' +
            '<div style="color:#e4e4e7;font-size:13px;font-weight:500;">' + esc(intent) + '</div>' +
            '<div style="color:#71717a;font-size:10px;">' + esc(relativeTime(ts)) + '</div>' +
          '</div>' +
          '<div style="border-top:1px solid #27272a;padding-top:8px;overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding-bottom:8px;">' +
            '<div style="padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.02);' +
            'border:1px solid #27272a;font-size:11px;color:#d4d4d8;white-space:pre-wrap;' +
            'word-break:break-word;line-height:1.5;font-family:ui-monospace,Menlo,monospace;">' +
              esc(body || '(empty payload)') +
            '</div>' +
            (refs.length
              ? '<div style="padding:0 10px;color:#71717a;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Context refs</div>' +
                '<div style="padding:0 10px;display:flex;flex-direction:column;gap:4px;font-size:10px;color:#a1a1aa;font-family:ui-monospace,Menlo,monospace;">' +
                  refs.map((r) => '<div style="word-break:break-all;">' + esc(String(r)) + '</div>').join('') +
                '</div>'
              : '') +
          '</div>' +
        '</div>'
      );
    }

    function renderThreadReader(thread) {
      if (!thread) {
        return (
          '<div style="display:flex;flex-direction:column;gap:12px;height:100%;">' +
            '<div data-action="back" style="' +
            'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
            'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;" ' +
            'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
            'onmouseout="this.style.background=\'transparent\'">' +
              '&larr; back' +
            '</div>' +
            '<div style="padding:16px;color:#a1a1aa;font-size:12px;">Thread not found.</div>' +
          '</div>'
        );
      }

      const status = thread.status || 'open';
      const intent = thread.intent || (thread.messages && thread.messages[0]?.intent) || 'message';
      const from = thread.from || thread.initiator || (thread.messages && thread.messages[0]?.from) || '?';
      const to = thread.to || thread.target || (thread.messages && thread.messages[0]?.to) || '?';
      const statusColor =
        status === 'completed' ? '#22c55e' : status === 'in-progress' ? '#eab308' : '#60a5fa';

      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const messagesHtml = messages.length
        ? messages.map(renderMessage).join('')
        : '<div style="color:#71717a;font-size:11px;padding:10px;">No messages in this thread.</div>';

      return (
        '<div style="display:flex;flex-direction:column;gap:10px;height:100%;">' +
          '<div data-action="back" style="' +
          'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
          'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;" ' +
          'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
          'onmouseout="this.style.background=\'transparent\'">' +
            '&larr; back' +
          '</div>' +
          '<div style="padding:0 10px;display:flex;flex-direction:column;gap:6px;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
              statusColor + ';"></span>' +
              '<span style="color:#e4e4e7;font-size:13px;font-weight:600;">' + esc(intent) + '</span>' +
            '</div>' +
            '<div style="color:#a1a1aa;font-size:11px;">' +
              esc(from) + ' &rarr; ' + esc(to) + ' &middot; ' + esc(status) +
            '</div>' +
          '</div>' +
          '<div style="border-top:1px solid #27272a;padding-top:8px;display:flex;flex-direction:column;gap:8px;' +
          'overflow-y:auto;flex:1;">' +
            messagesHtml +
          '</div>' +
        '</div>'
      );
    }

    function renderMessage(msg) {
      const from = msg.from || '?';
      const ts = msg.ts || msg.created_at || msg.timestamp || null;
      const body =
        typeof msg.payload === 'string'
          ? msg.payload
          : msg.payload && typeof msg.payload === 'object'
          ? JSON.stringify(msg.payload, null, 2)
          : msg.body || msg.text || msg.intent || '';
      const fromColor = AGENT_HUE[from] || '#94a3b8';
      return (
        '<div style="padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.02);' +
        'border:1px solid #27272a;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
            '<span style="font-size:11px;font-weight:600;color:' + fromColor + ';">' + esc(from) + '</span>' +
            '<span style="font-size:10px;color:#71717a;">' + esc(relativeTime(ts)) + '</span>' +
            (msg.type ? '<span style="font-size:10px;color:#a1a1aa;background:#27272a;' +
              'padding:1px 6px;border-radius:9px;">' + esc(msg.type) + '</span>' : '') +
          '</div>' +
          '<div style="font-size:11px;color:#d4d4d8;white-space:pre-wrap;word-break:break-word;' +
          'line-height:1.5;font-family:ui-monospace,Menlo,monospace;">' +
            esc(body) +
          '</div>' +
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

    function renderInboxRow(msg) {
      const from = msg.from || '?';
      const intent = msg.intent || msg.type || 'message';
      const ts = msg.ts || msg.created_at || msg.timestamp || null;
      const priority = msg.priority || 'normal';
      const priColor =
        priority === 'urgent' ? '#ef4444' :
        priority === 'high' ? '#f97316' :
        priority === 'low' ? '#71717a' : '#60a5fa';
      const fromColor = AGENT_HUE[from] || '#94a3b8';
      const payload = JSON.stringify({ msg_id: msg.id, file_name: msg._file_name });
      return (
        '<div data-action="select-inbox-msg" data-payload="' + esc(payload) + '" ' +
        'style="display:flex;align-items:center;gap:8px;padding:6px 10px;' +
        'border-radius:6px;font-size:11px;color:#d4d4d8;cursor:pointer;' +
        'transition:background 120ms;" ' +
        'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
        'onmouseout="this.style.background=\'transparent\'">' +
          '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' +
          priColor + ';flex-shrink:0;" title="' + esc(priority) + '"></span>' +
          '<span style="color:' + fromColor + ';font-weight:600;font-size:10px;">' + esc(from) + '</span>' +
          '<span style="color:#e4e4e7;flex:1;min-width:0;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;">' + esc(intent) + '</span>' +
          '<span style="color:#71717a;font-size:10px;flex-shrink:0;">' +
            esc(relativeTime(ts)) + '</span>' +
        '</div>'
      );
    }

    function renderAgentDetail(agent, snap, inboxMessages) {
      const threadsForAgent = snap.threads.filter((t) => {
        const from = t.from || t.initiator || (t.messages && t.messages[0]?.from);
        const to = t.to || t.target || (t.messages && t.messages[0]?.to);
        return from === agent.id || to === agent.id;
      });

      const inboxHtml = inboxMessages.length
        ? inboxMessages.map(renderInboxRow).join('')
        : '<div style="color:#71717a;font-size:11px;padding:6px 10px;font-style:italic;">' +
          'No pending messages.</div>';

      const threadsHtml = threadsForAgent.length
        ? threadsForAgent.map(renderThreadRow).join('')
        : '<div style="color:#71717a;font-size:11px;padding:6px 10px;font-style:italic;">' +
          'No threads.</div>';

      return (
        '<div style="display:flex;flex-direction:column;gap:12px;height:100%;overflow:hidden;">' +
          '<div data-action="back" style="' +
          'display:flex;align-items:center;gap:6px;color:#a1a1aa;font-size:11px;' +
          'cursor:pointer;padding:4px 8px;border-radius:4px;width:fit-content;flex-shrink:0;" ' +
          'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" ' +
          'onmouseout="this.style.background=\'transparent\'">' +
            '&larr; back to roster' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:12px;padding:0 10px;flex-shrink:0;">' +
            renderAvatarBubble(agent, 40) +
            '<div style="display:flex;flex-direction:column;gap:2px;min-width:0;">' +
              '<div style="color:#e4e4e7;font-size:15px;font-weight:600;">' +
                esc(agent.display_name) +
              '</div>' +
              '<div style="color:#a1a1aa;font-size:11px;">' + esc(agent.role) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;padding:0 10px;font-size:11px;color:#d4d4d8;flex-shrink:0;">' +
            '<div><span style="color:#71717a;">status:</span> ' + esc(agent.status) +
              (agent.status === 'online' ? '' : ' &middot; ' + esc(relativeTime(agent.last_seen))) +
            '</div>' +
            '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              '<span style="color:#71717a;">workspace:</span> ' +
              esc(agent.workspace_path || agent.workspace_default || '—') +
            '</div>' +
          '</div>' +
          '<div style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
              '<div style="color:#a1a1aa;font-size:10px;font-weight:600;letter-spacing:0.06em;' +
              'text-transform:uppercase;padding:0 10px;display:flex;align-items:center;gap:6px;">' +
                '<span>Inbox</span>' +
                (inboxMessages.length > 0
                  ? '<span style="background:#ef4444;color:#fff;font-size:9px;padding:1px 6px;' +
                    'border-radius:9px;font-weight:600;">' + inboxMessages.length + '</span>'
                  : '') +
                '<span style="color:#52525b;font-size:9px;font-weight:400;text-transform:none;letter-spacing:0;">' +
                  '— pending messages' +
                '</span>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:2px;">' + inboxHtml + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;border-top:1px solid #27272a;padding-top:10px;">' +
              '<div style="color:#a1a1aa;font-size:10px;font-weight:600;letter-spacing:0.06em;' +
              'text-transform:uppercase;padding:0 10px;display:flex;align-items:center;gap:6px;">' +
                '<span>Threads</span>' +
                '<span style="color:#52525b;font-size:9px;font-weight:400;text-transform:none;letter-spacing:0;">' +
                  '— conversation history' +
                '</span>' +
              '</div>' +
              '<div style="display:flex;flex-direction:column;gap:2px;">' + threadsHtml + '</div>' +
            '</div>' +
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

    function renderMinimizedPill(snap) {
      const totalInbox = snap.agents.reduce((acc, a) => acc + (a.inbox || 0), 0);
      const avatarsRow = snap.agents
        .map((a) => {
          // Tiny avatar circle, with a status dot overlapping bottom-right.
          // Inline because the pill content is rendered via dangerouslySetInnerHTML.
          const dotColor = STATUS_COLOR[a.status] || '#71717a';
          const img = a.avatar_data_url
            ? '<img src="' + esc(a.avatar_data_url) + '" alt="' + esc(a.display_name) +
              '" style="width:20px;height:20px;border-radius:50%;object-fit:cover;' +
              'object-position:top;display:block;" />'
            : '<div style="width:20px;height:20px;border-radius:50%;background:' +
              (AGENT_HUE[a.id] || '#94a3b8') + '22;color:' + (AGENT_HUE[a.id] || '#94a3b8') +
              ';display:flex;align-items:center;justify-content:center;font-size:10px;' +
              'font-weight:600;">' + esc((a.display_name || a.id).charAt(0).toUpperCase()) +
              '</div>';
          return (
            '<div style="position:relative;display:inline-block;">' +
              img +
              '<span style="position:absolute;bottom:-1px;right:-1px;width:7px;height:7px;' +
              'border-radius:50%;background:' + dotColor + ';border:1.5px solid #18181b;"></span>' +
            '</div>'
          );
        })
        .join('');
      const badge = totalInbox > 0
        ? '<span style="background:#ef4444;color:#fff;font-size:10px;padding:2px 7px;' +
          'border-radius:9px;font-weight:600;margin-left:6px;">' + totalInbox + '</span>'
        : '';
      return (
        '<div style="display:flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;font-size:11px;color:#d4d4d8;">' +
          '<span style="color:#a1a1aa;margin-right:2px;">Team</span>' +
          avatarsRow +
          badge +
        '</div>'
      );
    }

    async function refreshMinimizedContent() {
      if (!lastSnapshot) return;
      const html = renderMinimizedPill(lastSnapshot);
      if (html === lastMinimizedHtml) return;
      lastMinimizedHtml = html;
      try {
        await api.panel.setMinimizedContent(PANEL_ID, html);
      } catch (_) { /* older Onda builds may not support this; harmless */ }
    }

    async function pushContent(html) {
      if (html === lastPushedHtml) return;
      lastPushedHtml = html;
      await api.panel.setContent(PANEL_ID, html);
    }

    async function rerender() {
      if (lastError) { await pushContent(renderError(lastError)); return; }
      if (!lastSnapshot) { await pushContent(renderEmpty()); return; }
      if (selectedInboxMsg) {
        const msg = await readJson(
          ROOT + '/inboxes/' + selectedInboxMsg.agent + '/' + selectedInboxMsg.file_name
        );
        await pushContent(renderInboxMsgReader(msg, selectedInboxMsg.agent));
        return;
      }
      if (selectedThread) {
        const thread = await loadThreadById(selectedThread);
        await pushContent(renderThreadReader(thread));
        return;
      }
      if (selectedAgent) {
        const agent = lastSnapshot.agents.find((a) => a.id === selectedAgent);
        if (agent) {
          const inbox = await loadInboxMessages(agent.id, 20);
          await pushContent(renderAgentDetail(agent, lastSnapshot, inbox));
          return;
        }
        selectedAgent = null;
      }
      await pushContent(renderRoster(lastSnapshot));
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
      await refreshMinimizedContent();
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
        // Wire the rail icon to the panel — pass the *bare* panel id; the
        // appRail handler will prefix it with our pluginId, so we'd end up
        // with `team-panel:team-panel:main` if we passed the full id.
        panelId: PANEL_ID,
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
     * count across all agents. Idempotent — skips the round-trip when the
     * derived signature hasn't changed since the last tick (cuts log spam
     * and IPC traffic dramatically given a 5s poll).
     */
    async function refreshEntryBadges() {
      if (!lastSnapshot) return;
      const totalInbox = lastSnapshot.agents.reduce((acc, a) => acc + (a.inbox || 0), 0);
      const onlineCount = lastSnapshot.agents.filter((a) => a.status === 'online').length;
      const sig = totalInbox + ':' + onlineCount;
      if (sig === lastEntrySignature) return;
      lastEntrySignature = sig;

      const tooltip =
        'Agent Team — ' + onlineCount + ' online' +
        (totalInbox > 0 ? ', ' + totalInbox + ' pending' : '');

      try {
        await api.appRail.updateItem(APP_RAIL_ID, {
          badge: totalInbox > 0 ? String(totalInbox) : undefined,
          tooltip,
        });
      } catch (_) {}

      try {
        await api.statusBar.updateItem(STATUS_BAR_ID, {
          text: totalInbox > 0 ? 'Team (' + totalInbox + ')' : 'Team',
          color: totalInbox > 0 ? 'warning' : undefined,
          tooltip,
        });
      } catch (_) {}
    }

    // Click handlers
    api.panel.onAction('select-agent', async (data) => {
      const payload = typeof data === 'string' ? safeParse(data) : data;
      selectedAgent = payload?.id || null;
      selectedThread = null;
      await rerender();
    });
    api.panel.onAction('select-thread', async (data) => {
      const payload = typeof data === 'string' ? safeParse(data) : data;
      selectedThread = payload?.file_id || null;
      await rerender();
    });
    api.panel.onAction('select-inbox-msg', async (data) => {
      const payload = typeof data === 'string' ? safeParse(data) : data;
      if (selectedAgent && payload?.file_name) {
        selectedInboxMsg = { agent: selectedAgent, file_name: payload.file_name };
        await rerender();
      }
    });
    api.panel.onAction('back', async () => {
      // Back is contextual: drill back up the stack
      // inbox-msg → agent detail → roster
      // thread    → wherever we came from (agent detail / roster)
      if (selectedInboxMsg) {
        selectedInboxMsg = null;
      } else if (selectedThread) {
        selectedThread = null;
      } else {
        selectedAgent = null;
      }
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
