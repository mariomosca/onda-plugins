/**
 * Claude Plans Viewer Plugin
 *
 * Scans ~/.claude/plans/ for implementation plans and displays them
 * with progress tracking. Associates plans with projects based on
 * file paths and project names mentioned in the content.
 */

// Claude plans directory
const PLANS_DIR = '~/.claude/plans';

// Cached plans data
let plansCache = [];
let lastScanTime = null;

// Current view state
let currentView = 'list'; // 'list' or 'detail'
let selectedPlanId = null;

// Onda reference for event handlers
let ondaRef = null;

/**
 * Extract title from markdown content
 * Looks for first # heading or uses filename
 */
function extractTitle(content, filename) {
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)/);
    if (match) {
      return match[1].trim();
    }
  }
  // Fallback to filename without extension
  return filename.replace('.md', '').split('-').map(w =>
    w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
}

/**
 * Extract tasks from markdown content
 * Looks for - [ ] (pending) and - [x] (completed) patterns
 */
function extractTasks(content) {
  const tasks = {
    total: 0,
    completed: 0,
    pending: [],
    done: []
  };

  const lines = content.split('\n');
  for (const line of lines) {
    // Match task patterns: - [ ], - [x], - [X], * [ ], * [x]
    const pendingMatch = line.match(/^[\s]*[-*]\s*\[\s*\]\s*(.+)/);
    const completedMatch = line.match(/^[\s]*[-*]\s*\[[xX]\]\s*(.+)/);

    if (pendingMatch) {
      tasks.total++;
      tasks.pending.push(pendingMatch[1].trim());
    } else if (completedMatch) {
      tasks.total++;
      tasks.completed++;
      tasks.done.push(completedMatch[1].trim());
    }
  }

  return tasks;
}

/**
 * Extract project paths from plan content
 * Looks for absolute paths to project directories
 */
function extractProjectPaths(content) {
  const paths = new Set();

  // Match absolute paths like /Users/username/path/to/project
  const absPathMatches = content.matchAll(/\/Users\/[^\/\s`"']+\/[^\/\s`"']+\/([^\/\s`"']+)/g);
  for (const match of absPathMatches) {
    if (match[1] && match[1].length > 2 && !match[1].startsWith('.')) {
      paths.add(match[1]);
    }
  }

  // Match paths in backticks like `src/renderer/` or `onda-electron/src/`
  const backtickPaths = content.matchAll(/`([a-zA-Z0-9_-]+)\/(?:src|lib|app|packages)\//g);
  for (const match of backtickPaths) {
    if (match[1] && match[1].length > 2) {
      paths.add(match[1]);
    }
  }

  // Match "File: path" patterns
  const filePatterns = content.matchAll(/File:\s*`?([a-zA-Z0-9_-]+)\//g);
  for (const match of filePatterns) {
    if (match[1] && match[1].length > 2) {
      paths.add(match[1]);
    }
  }

  // Match project/repo mentions
  const projectMentions = content.matchAll(/(?:project|repo|repository)[:\s]+([a-zA-Z0-9_-]+)/gi);
  for (const match of projectMentions) {
    if (match[1] && match[1].length > 2) {
      paths.add(match[1]);
    }
  }

  return Array.from(paths).slice(0, 5); // Limit to 5 projects
}

/**
 * Extract the full project root path if found
 */
function extractRootPath(content) {
  // Look for common patterns indicating project root
  const patterns = [
    /Working directory:\s*([\/\w\-\.]+)/,
    /Project root:\s*([\/\w\-\.]+)/,
    /cwd:\s*([\/\w\-\.]+)/,
    /(\/Users\/[^\/\s]+\/[^\/\s]+\/[^\/\s`"'\n]+)/
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Calculate progress percentage
 */
function calculateProgress(tasks) {
  if (tasks.total === 0) return 0;
  return Math.round((tasks.completed / tasks.total) * 100);
}

/**
 * Get status badge HTML based on progress
 */
function getStatusBadge(progress) {
  if (progress === 100) {
    return '<span style="background:#10b981;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">Complete</span>';
  } else if (progress > 50) {
    return '<span style="background:#f59e0b;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">In Progress</span>';
  } else if (progress > 0) {
    return '<span style="background:#3b82f6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">Started</span>';
  }
  return '<span style="background:#6b7280;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">Not Started</span>';
}

/**
 * Generate progress bar HTML
 */
function getProgressBar(progress) {
  const color = progress === 100 ? '#10b981' : progress > 50 ? '#f59e0b' : '#3b82f6';
  return `
    <div style="background:#27272a;border-radius:4px;height:6px;width:100%;margin:4px 0;">
      <div style="background:${color};height:100%;border-radius:4px;width:${progress}%;transition:width 0.3s;"></div>
    </div>
  `;
}

/**
 * Format date for display
 */
function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert markdown to simple HTML
 */
function markdownToHtml(content) {
  let html = escapeHtml(content);

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 style="color:#fafafa;font-size:13px;margin:12px 0 8px 0;">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="color:#fafafa;font-size:14px;margin:16px 0 8px 0;">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="color:#fafafa;font-size:16px;margin:16px 0 8px 0;">$1</h2>');

  // Task lists
  html = html.replace(/^(\s*)- \[x\] (.+)$/gm, '$1<div style="color:#10b981;font-size:12px;margin:2px 0;padding-left:16px;">&#x2713; $2</div>');
  html = html.replace(/^(\s*)- \[ \] (.+)$/gm, '$1<div style="color:#a1a1aa;font-size:12px;margin:2px 0;padding-left:16px;">&#x25CB; $2</div>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fafafa;">$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Code blocks
  html = html.replace(/`([^`]+)`/g, '<code style="background:#3f3f46;padding:1px 4px;border-radius:3px;font-size:11px;">$1</code>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

/**
 * Generate HTML for plan detail view
 */
function generateDetailHTML(plan) {
  const projectTags = plan.projects.map(p =>
    `<span style="background:#3f3f46;padding:2px 8px;border-radius:4px;font-size:11px;color:#a1a1aa;">${escapeHtml(p)}</span>`
  ).join(' ');

  return `
    <div style="padding:0;">
      <!-- Header with back button -->
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #3f3f46;">
        <button data-action="back" style="background:#3f3f46;border:none;color:#fafafa;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;">
          ← Back
        </button>
        <span style="color:#71717a;font-size:11px;flex:1;text-align:right;">${escapeHtml(plan.filename)}</span>
        <button data-action="delete" data-payload='{"planId":"${plan.id}"}' style="background:#7f1d1d;border:none;color:#fca5a5;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;" title="Move to trash">
          &#x1F5D1;
        </button>
      </div>

      <!-- Title and status -->
      <div style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <h2 style="color:#fafafa;font-size:16px;margin:0;flex:1;">${escapeHtml(plan.title)}</h2>
          ${getStatusBadge(plan.progress)}
        </div>
        ${getProgressBar(plan.progress)}
        <div style="color:#71717a;font-size:11px;margin-top:4px;">
          ${plan.tasks.completed}/${plan.tasks.total} tasks completed
        </div>
      </div>

      <!-- Project info -->
      ${plan.projects.length > 0 || plan.rootPath ? `
        <div style="background:#27272a;border-radius:8px;padding:12px;margin-bottom:16px;border:1px solid #3f3f46;">
          <div style="color:#a1a1aa;font-size:10px;margin-bottom:6px;text-transform:uppercase;">Project</div>
          ${plan.rootPath ? `
            <div style="color:#d4d4d8;font-size:12px;margin-bottom:8px;font-family:monospace;word-break:break-all;">
              ${escapeHtml(plan.rootPath)}
            </div>
          ` : ''}
          ${plan.projects.length > 0 ? `
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${projectTags}
            </div>
          ` : ''}
        </div>
      ` : ''}

      <!-- Tasks sections -->
      ${plan.tasks.pending.length > 0 ? `
        <div style="margin-bottom:16px;">
          <div style="color:#f59e0b;font-size:11px;margin-bottom:8px;text-transform:uppercase;">
            Pending Tasks (${plan.tasks.pending.length})
          </div>
          ${plan.tasks.pending.map(task => `
            <div style="color:#d4d4d8;font-size:12px;padding:6px 0 6px 16px;position:relative;border-bottom:1px solid #27272a;">
              <span style="position:absolute;left:0;color:#71717a;">○</span>
              ${escapeHtml(task)}
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${plan.tasks.done.length > 0 ? `
        <div style="margin-bottom:16px;">
          <div style="color:#10b981;font-size:11px;margin-bottom:8px;text-transform:uppercase;">
            Completed Tasks (${plan.tasks.done.length})
          </div>
          ${plan.tasks.done.map(task => `
            <div style="color:#71717a;font-size:12px;padding:6px 0 6px 16px;position:relative;border-bottom:1px solid #27272a;text-decoration:line-through;">
              <span style="position:absolute;left:0;color:#10b981;">✓</span>
              ${escapeHtml(task)}
            </div>
          `).join('')}
        </div>
      ` : ''}

      <!-- Full content -->
      <div style="margin-top:16px;padding-top:16px;border-top:1px solid #3f3f46;">
        <div style="color:#a1a1aa;font-size:10px;margin-bottom:8px;text-transform:uppercase;">Full Plan</div>
        <div style="color:#d4d4d8;font-size:12px;line-height:1.5;max-height:400px;overflow-y:auto;padding:8px;background:#18181b;border-radius:4px;">
          ${markdownToHtml(plan.content)}
        </div>
      </div>

      <!-- Meta -->
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid #3f3f46;color:#71717a;font-size:10px;">
        <div>Modified: ${formatDate(plan.modifiedAt)}</div>
        <div>Size: ${Math.round(plan.size / 1024 * 10) / 10} KB</div>
      </div>
    </div>
  `;
}

/**
 * Generate HTML for plans list
 */
function generateListHTML(plans, filter = null) {
  if (plans.length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:#71717a;">
        <div style="font-size:32px;margin-bottom:12px;">&#x1F4CB;</div>
        <div style="font-size:14px;margin-bottom:8px;">No plans found</div>
        <div style="font-size:12px;">Claude Code plans will appear here</div>
      </div>
    `;
  }

  // Filter plans if workspace filter provided
  let filteredPlans = plans;
  if (filter) {
    filteredPlans = plans.filter(p =>
      p.projects.some(proj => proj.toLowerCase().includes(filter.toLowerCase()))
    );
  }

  // Sort by modification date (newest first)
  filteredPlans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

  // Stats
  const totalPlans = filteredPlans.length;
  const completedPlans = filteredPlans.filter(p => p.progress === 100).length;
  const inProgressPlans = filteredPlans.filter(p => p.progress > 0 && p.progress < 100).length;

  let html = `
    <div style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="color:#a1a1aa;font-size:12px;">${totalPlans} plans</span>
        <div style="display:flex;gap:8px;font-size:11px;">
          <span style="color:#10b981;">&#x2713; ${completedPlans}</span>
          <span style="color:#f59e0b;">&#x25D0; ${inProgressPlans}</span>
        </div>
      </div>
    </div>
  `;

  for (const plan of filteredPlans) {
    const progress = plan.progress;
    const projectTags = plan.projects.slice(0, 2).map(p =>
      `<span style="background:#3f3f46;padding:2px 6px;border-radius:3px;font-size:10px;color:#a1a1aa;">${escapeHtml(p)}</span>`
    ).join(' ');

    html += `
      <div data-action="select" data-payload='{"planId":"${plan.id}"}' style="background:#27272a;border-radius:8px;padding:12px;margin-bottom:8px;border:1px solid #3f3f46;cursor:pointer;transition:border-color 0.2s;" onmouseover="this.style.borderColor='#52525b'" onmouseout="this.style.borderColor='#3f3f46'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;color:#fafafa;font-size:13px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(plan.title)}">
              ${escapeHtml(plan.title)}
            </div>
            ${plan.rootPath ? `
              <div style="color:#71717a;font-size:10px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;" title="${escapeHtml(plan.rootPath)}">
                ${escapeHtml(plan.rootPath)}
              </div>
            ` : ''}
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${projectTags}
            </div>
          </div>
          ${getStatusBadge(progress)}
        </div>
        ${getProgressBar(progress)}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <span style="color:#71717a;font-size:11px;">${plan.tasks.completed}/${plan.tasks.total} tasks</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="color:#71717a;font-size:11px;">${formatDate(plan.modifiedAt)}</span>
            <button data-action="delete" data-payload='{"planId":"${plan.id}"}' onclick="event.stopPropagation()" style="background:transparent;border:none;color:#71717a;padding:2px 4px;cursor:pointer;font-size:12px;opacity:0.6;transition:opacity 0.2s;" onmouseover="this.style.opacity='1';this.style.color='#ef4444'" onmouseout="this.style.opacity='0.6';this.style.color='#71717a'" title="Move to trash">&#x1F5D1;</button>
          </div>
        </div>
        ${plan.tasks.pending.length > 0 ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #3f3f46;">
            <div style="color:#a1a1aa;font-size:10px;margin-bottom:4px;">Next tasks:</div>
            ${plan.tasks.pending.slice(0, 2).map(task => `
              <div style="color:#d4d4d8;font-size:11px;padding-left:12px;position:relative;margin-bottom:2px;">
                <span style="position:absolute;left:0;">&#x25CB;</span>
                <span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(task)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  return html;
}

/**
 * Generate panel HTML based on current view
 */
function generatePanelHTML(plans, filter = null) {
  if (currentView === 'detail' && selectedPlanId) {
    const plan = plans.find(p => p.id === selectedPlanId);
    if (plan) {
      return generateDetailHTML(plan);
    }
  }

  return generateListHTML(plans, filter);
}

/**
 * Scan plans directory and parse all plans
 */
async function scanPlans(onda) {
  console.log('[Claude Plans] Scanning plans directory...');

  try {
    const homePath = await getHomePath(onda);
    const plansPath = `${homePath}/.claude/plans`;

    let entries;
    try {
      entries = await onda.filesystem.readDir(plansPath);
    } catch (e) {
      console.log('[Claude Plans] Plans directory not found or not accessible');
      return [];
    }

    const plans = [];

    for (const entry of entries) {
      if (entry.name.endsWith('.md') && !entry.isDirectory) {
        try {
          const filePath = `${plansPath}/${entry.name}`;
          const result = await onda.filesystem.readFile(filePath);
          const content = result.content || '';

          const title = extractTitle(content, entry.name);
          const tasks = extractTasks(content);
          const projects = extractProjectPaths(content);
          const rootPath = extractRootPath(content);
          const progress = calculateProgress(tasks);

          plans.push({
            id: entry.name,
            filename: entry.name,
            path: filePath,
            title,
            content, // Store raw content for detail view
            tasks,
            projects,
            rootPath,
            progress,
            modifiedAt: entry.modifiedAt || new Date().toISOString(),
            size: content.length
          });
        } catch (e) {
          console.warn(`[Claude Plans] Failed to read plan ${entry.name}:`, e);
        }
      }
    }

    console.log(`[Claude Plans] Found ${plans.length} plans`);
    plansCache = plans;
    lastScanTime = new Date();

    return plans;
  } catch (e) {
    console.error('[Claude Plans] Error scanning plans:', e);
    return [];
  }
}

/**
 * Get home directory path via filesystem API
 */
async function getHomePath(onda) {
  try {
    const stored = await onda.storage.get('homePath');
    if (stored) return stored;
  } catch (e) {}

  try {
    const homePath = await onda.filesystem.getHome();
    await onda.storage.set('homePath', homePath);
    return homePath;
  } catch (e) {
    console.error('[Claude Plans] Failed to get home path:', e);
    throw new Error('Could not determine home directory');
  }
}

/**
 * Update panel content
 */
async function updatePanel(onda, filter = null) {
  const plans = plansCache.length > 0 ? plansCache : await scanPlans(onda);
  const html = generatePanelHTML(plans, filter);
  await onda.panel.setContent('plans', html);
}

/**
 * Handle plan selection
 */
async function selectPlan(planId) {
  if (!ondaRef) return;

  currentView = 'detail';
  selectedPlanId = planId;
  await updatePanel(ondaRef);
}

/**
 * Handle back to list
 */
async function goBack() {
  if (!ondaRef) return;

  currentView = 'list';
  selectedPlanId = null;
  await updatePanel(ondaRef);
}

/**
 * Handle plan deletion
 */
async function deletePlan(planId) {
  if (!ondaRef) return;

  const plan = plansCache.find(p => p.id === planId);
  if (!plan) return;

  try {
    // Delete the file (moves to trash)
    await ondaRef.filesystem.deleteFile(plan.path);

    // Remove from cache
    plansCache = plansCache.filter(p => p.id !== planId);

    // If we're in detail view of the deleted plan, go back to list
    if (currentView === 'detail' && selectedPlanId === planId) {
      currentView = 'list';
      selectedPlanId = null;
    }

    // Update panel
    await updatePanel(ondaRef);

    // Show notification
    await ondaRef.notifications.show({
      message: 'Plan moved to trash',
      type: 'info',
      duration: 2000
    });
  } catch (e) {
    console.error('[Claude Plans] Failed to delete plan:', e);
    await ondaRef.notifications.show({
      message: 'Failed to delete plan',
      type: 'error',
      duration: 3000
    });
  }
}

// Plugin entry point
self.__ondaPlugin = {
  onActivate: async function(onda) {
    console.log('[Claude Plans] Activating...');
    ondaRef = onda;

    // Register panel action handlers
    onda.panel.onAction('select', (payload) => {
      if (payload?.planId) {
        selectPlan(payload.planId);
      }
    });

    onda.panel.onAction('back', () => {
      goBack();
    });

    onda.panel.onAction('delete', (payload) => {
      if (payload?.planId) {
        deletePlan(payload.planId);
      }
    });

    // Register panel
    await onda.panel.register({
      id: 'plans',
      title: 'Claude Plans',
      icon: '&#x1F4CB;',
      position: 'right',
      width: 320,
      minWidth: 280,
      maxWidth: 500
    });

    // Initial scan
    await scanPlans(onda);

    // Set initial panel content
    await updatePanel(onda);

    // Register commands
    await onda.commands.register('claude-plans-viewer.show-panel', {
      title: 'Show Claude Plans',
      handler: async () => {
        await updatePanel(onda);
        await onda.panel.show('plans');
      }
    });

    await onda.commands.register('claude-plans-viewer.refresh', {
      title: 'Refresh Plans',
      handler: async () => {
        plansCache = [];
        currentView = 'list';
        selectedPlanId = null;
        await scanPlans(onda);
        await updatePanel(onda);
        await onda.notifications.show({
          message: `Found ${plansCache.length} plans`,
          type: 'info',
          duration: 2000
        });
      }
    });

    console.log('[Claude Plans] Activated successfully');
  }
};
