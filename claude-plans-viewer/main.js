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

/**
 * Expand ~ to home directory path
 */
function expandPath(path) {
  // In the browser/worker context, we'll need to handle this via the filesystem API
  // The home dir will be resolved by the main process
  return path;
}

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
 * Try to infer project from plan content
 * Looks for common patterns like file paths, project names
 */
function inferProject(content) {
  const projects = new Set();

  // Look for file paths like src/renderer/, src/main/, etc.
  const pathPatterns = [
    /`([a-zA-Z0-9_-]+)\/src\//g,
    /File:\s*`?([a-zA-Z0-9_-]+)\//g,
    /project[:\s]+([a-zA-Z0-9_-]+)/gi,
    /repo[:\s]+([a-zA-Z0-9_-]+)/gi,
  ];

  for (const pattern of pathPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && match[1].length > 2) {
        projects.add(match[1]);
      }
    }
  }

  // Look for common project directory patterns
  const dirPatterns = content.match(/\/Users\/[^/]+\/[^/]+\/([^/\s`"']+)/g);
  if (dirPatterns) {
    for (const path of dirPatterns) {
      const parts = path.split('/');
      if (parts.length > 3) {
        projects.add(parts[parts.length - 1]);
      }
    }
  }

  return Array.from(projects);
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
 * Generate HTML for plans panel
 */
function generatePanelHTML(plans, filter = null) {
  if (plans.length === 0) {
    return `
      <div style="text-align:center;padding:40px 20px;color:#71717a;">
        <div style="font-size:32px;margin-bottom:12px;">📋</div>
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
          <span style="color:#10b981;">✓ ${completedPlans}</span>
          <span style="color:#f59e0b;">◐ ${inProgressPlans}</span>
        </div>
      </div>
    </div>
  `;

  for (const plan of filteredPlans) {
    const progress = plan.progress;
    const projectTags = plan.projects.slice(0, 2).map(p =>
      `<span style="background:#3f3f46;padding:2px 6px;border-radius:3px;font-size:10px;color:#a1a1aa;">${p}</span>`
    ).join(' ');

    html += `
      <div style="background:#27272a;border-radius:8px;padding:12px;margin-bottom:8px;border:1px solid #3f3f46;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:500;color:#fafafa;font-size:13px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${plan.title}">
              ${plan.title}
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${projectTags}
            </div>
          </div>
          ${getStatusBadge(progress)}
        </div>
        ${getProgressBar(progress)}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <span style="color:#71717a;font-size:11px;">${plan.tasks.completed}/${plan.tasks.total} tasks</span>
          <span style="color:#71717a;font-size:11px;">${formatDate(plan.modifiedAt)}</span>
        </div>
        ${plan.tasks.pending.length > 0 ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid #3f3f46;">
            <div style="color:#a1a1aa;font-size:10px;margin-bottom:4px;">Next tasks:</div>
            ${plan.tasks.pending.slice(0, 2).map(task => `
              <div style="color:#d4d4d8;font-size:11px;padding-left:12px;position:relative;margin-bottom:2px;">
                <span style="position:absolute;left:0;">○</span>
                <span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${task}</span>
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
 * Scan plans directory and parse all plans
 */
async function scanPlans(onda) {
  console.log('[Claude Plans] Scanning plans directory...');

  try {
    // Read plans directory
    // Note: ~ expansion happens in the main process
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
          const projects = inferProject(content);
          const progress = calculateProgress(tasks);

          plans.push({
            id: entry.name,
            filename: entry.name,
            path: filePath,
            title,
            tasks,
            projects,
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
  // Try to get cached home path first
  try {
    const stored = await onda.storage.get('homePath');
    if (stored) return stored;
  } catch (e) {}

  // Use filesystem API to get home directory
  try {
    const homePath = await onda.filesystem.getHome();
    // Cache for future use
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

// Plugin entry point
self.__ondaPlugin = {
  onActivate: async function(onda) {
    console.log('[Claude Plans] Activating...');

    // Register panel
    await onda.panel.register({
      id: 'plans',
      title: 'Claude Plans',
      icon: '📋',
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
        plansCache = []; // Clear cache
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
