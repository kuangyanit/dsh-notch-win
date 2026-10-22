'use strict';

/**
 * 渲染层：把宿主的那份快照画出来，把点击变成跳转请求。
 *
 * 两条纪律：
 *
 * 1. **只改文本与属性**。骨架在 index.html 里写死，会话行按 id 复用 DOM 节点。
 *    旧实现每拍 `innerHTML` 重建整块界面 —— 展开动画每拍被打断，点过的行被
 *    销毁重建，悬停态一直闪。
 * 2. **命中判定不强制同步布局**。`getBoundingClientRect()` 结果缓存，只在
 *    ResizeObserver 报尺寸变化时失效；否则每次 mousemove 都会触发一次布局。
 */
(() => {
  const I = window.island;
  const P = I.protocol;

  const el = (id) => document.getElementById(id);
  const island = el('island');
  const hDot = el('h-dot');
  const hBadge = el('h-badge');
  const hWorkspace = el('h-workspace');
  const hTitle = el('h-title');
  const hElapsed = el('h-elapsed');
  const todosPanel = el('todos');
  const todoList = el('todo-list');
  const todoProg = el('todo-prog');
  const todoMore = el('todo-more');
  const subagentsPanel = el('subagents');
  const subagentList = el('subagent-list');
  const subagentCount = el('subagent-count');
  const list = el('list');
  const stats = el('stats');
  const link = el('link');
  const hint = el('hint');
  const pin = el('pin');
  const hdr = el('hdr');
  hdr.title = '当前会话';

  const BADGE = { idle: '空闲', thinking: '思考中', tool: '调用工具', done: '已完成', offline: '未连接' };
  const STATUS_LABEL = { idle: '空闲', thinking: '思考中', tool: '调用工具', done: '已完成' };
  const TODO_STATUS = {
    completed: { label: '已完成', color: '#22C55E' },
    in_progress: { label: '进行中', color: '#4E7CFF' },
    pending: { label: '待处理', color: '#E0A800' },
  };

  /** 宿主快照。`null` 表示还没拿到第一拍。 */
  let snapshot = null;

  const ui = { expanded: false, pinned: false, offline: true, error: null, flash: null, flashAt: 0 };

  // ── 只写变化的值：避免每拍都碰 DOM ──
  function setText(node, text) {
    const next = text === null || text === undefined ? '' : String(text);
    if (node.textContent !== next) node.textContent = next;
  }
  function toggleClass(node, name, on) {
    if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
  }
  function setStyle(node, name, value) {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  }

  function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const total = Math.floor(ms / 1000);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  }

  function formatTokens(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
    if (value >= 10000) return `${Math.round(value / 1000)}k`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
  }

  /** 明细里的完整数字：千分位，不做量级缩写。 */
  function formatCount(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '—';
  }

  /**
   * 统计行的悬浮明细。主数字是 provider 口径的全部处理量：
   * 未缓存输入 + 输出 + 缓存读写。
   *
   * 缓存写入只有 Anthropic 这类显式缓存计费的 provider 才会上报；DeepSeek 的
   * 上下文缓存是自动的、不报 cache creation，所以这一项恒为 0，为 0 时不显示。
   */
  function tokenTitle(entry) {
    if (!entry || entry.tokenTotal === null || entry.tokenTotal === undefined) return '';
    if (!Number.isFinite(entry.tokenTotal) || entry.tokenTotal <= 0) return '';
    const lines = [
      `累计 token（输入 + 输出 + 缓存读写）：${formatCount(entry.tokenTotal)}`,
      `未缓存输入：${formatCount(entry.tokenInput)}`,
      `输出：${formatCount(entry.tokenOutput)}`,
      `缓存命中（读取）：${formatCount(entry.tokenCacheRead)}`,
    ];
    if (Number.isFinite(entry.tokenCacheWrite) && entry.tokenCacheWrite > 0) {
      lines.push(`缓存写入：${formatCount(entry.tokenCacheWrite)}`);
    }
    return lines.join('\n');
  }

  /** 当前被 DSH 选中的会话（可能是子代理）。 */
  function pickSelected(entries) {
    if (entries.length === 0) return null;
    const primaryId = snapshot ? snapshot.primaryId : null;
    if (primaryId) {
      const primary = findEntry(entries, primaryId);
      if (primary) return primary;
    }
    const live = entries.find((entry) => entry.live === true);
    return live || entries[0];
  }

  /** 表头始终代表当前会话所在树的根，点击子代理不会改变主会话文案。 */
  function pickFocus(entries) {
    const selected = pickSelected(entries);
    return selected ? rootOf(entries, selected) || selected : null;
  }

  function elapsedOf(entry, now) {
    if (!entry || entry.live !== true) return '';
    if (!Number.isFinite(entry.elapsedFrom) || entry.elapsedFrom <= 0) return '';
    return formatElapsed(now - entry.elapsedFrom);
  }

  function bareId(value) {
    const s = String(value ?? '');
    return s.startsWith('session-') ? s.slice('session-'.length) : s;
  }

  function findEntry(entries, id) {
    if (id === null || id === undefined) return null;
    const bare = bareId(id);
    return entries.find((entry) => bareId(entry.id) === bare) || null;
  }

  function displayName(entry) {
    if (!entry) return '';
    if (entry.isSubagent) return entry.subagentName || entry.subagentLabel || entry.label;
    return entry.label;
  }

  /** 行/表头共用的状态映射：子代理有独立终态，不能只看 status。 */
  function stateOf(entry) {
    if (entry.subagentState === 'finished') return { status: 'done', text: '已完成', color: P.STATUS_COLOR.done };
    if (entry.subagentState === 'stopped') return { status: 'stopped', text: '已停止', color: '#E0A800' };
    if (entry.subagentState === 'failed') return { status: 'stopped', text: '失败', color: '#EF4444' };
    if (entry.stopped) return { status: 'stopped', text: '已停止', color: '#E0A800' };
    return {
      status: entry.status,
      text: STATUS_LABEL[entry.status] || entry.status,
      color: entry.glow || P.STATUS_COLOR[entry.status] || P.STATUS_COLOR.idle,
    };
  }

  function compareSiblings(a, b) {
    const ca = Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
    const cb = Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return String(a.shortId || a.id).localeCompare(String(b.shortId || b.id));
  }

  function childrenOf(entries, parent) {
    if (!parent) return [];
    const key = bareId(parent.id);
    return entries
      .filter((entry) => entry.parentId && bareId(entry.parentId) === key)
      .sort(compareSiblings);
  }

  /** 父条目不在快照里的子代理归到这一组：宁可集中标注，也不能冒充顶级会话。 */
  const ORPHAN_GROUP = {
    id: '',
    label: '父会话未加载',
    isSubagent: false,
    isOrphanGroup: true,
    status: 'idle',
    workspace: null,
  };

  /** 把平铺条目组成父子行；focus 根由表头承担，selected 子代理在行上高亮。 */
  function buildTreeRows(entries, focus, selectedId, skipChildrenOfFocus = false) {
    const skipId = focus ? focus.id : null;
    const byBare = new Map(entries.map((entry) => [bareId(entry.id), entry]));
    const children = new Map();
    const roots = [];
    const orphans = [];
    for (const entry of entries) {
      const parent = entry.parentId ? byBare.get(bareId(entry.parentId)) : null;
      if (parent && parent.id !== entry.id) {
        const key = bareId(parent.id);
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(entry);
      } else if (entry.isSubagent) {
        // 父会话条目缺失（被回收 / 宿主还没补出来）：不能落进 roots，否则子代理
        // 会顶着「已完成/已停止」出现在顶级会话里，层级和缩进全丢。
        orphans.push(entry);
      } else {
        roots.push(entry);
      }
    }
    const out = [];
    for (const kids of children.values()) kids.sort(compareSiblings);

    const activeRoot = focus ? rootOf(entries, focus) : null;
    if (activeRoot) {
      const index = roots.findIndex((root) => root.id === activeRoot.id);
      if (index > 0) roots.unshift(roots.splice(index, 1)[0]);
    }

    const emit = (entry, depth, isLast) => {
      if (entry.id !== skipId) {
        out.push({
          entry,
          depth,
          branch: depth > 0 ? (isLast ? '└' : '├') : '',
          current: entry.id === selectedId,
        });
      }
      if (skipChildrenOfFocus && entry.id === skipId) return;
      const kids = (children.get(bareId(entry.id)) || []).filter((kid) => kid.id !== skipId);
      kids.forEach((kid, index) => emit(kid, depth + 1, index === kids.length - 1));
    };
    roots.forEach((root, index) => emit(root, 0, index === roots.length - 1));
    if (orphans.length > 0) {
      orphans.sort(compareSiblings);
      out.push({ entry: ORPHAN_GROUP, depth: 0, branch: '', current: false });
      orphans.forEach((entry, index) => {
        out.push({
          entry,
          depth: 1,
          branch: index === orphans.length - 1 ? '└' : '├',
          current: entry.id === selectedId,
        });
      });
    }
    return out;
  }

  /** 找到条目所在树的根（根会话或最早可见的祖先）。 */
  function rootOf(entries, entry) {
    if (!entry) return null;
    const byBare = new Map(entries.map((item) => [bareId(item.id), item]));
    let root = entry;
    const seen = new Set();
    while (root.parentId) {
      const key = bareId(root.id);
      if (seen.has(key)) break;
      seen.add(key);
      const parent = byBare.get(bareId(root.parentId));
      if (!parent) break;
      root = parent;
    }
    return root;
  }

  /** focus 所在的整棵树：根 + 所有后代，用于聚合待办。 */
  function focusTree(entries, focus) {
    if (!focus) return entries;
    const byBare = new Map(entries.map((entry) => [bareId(entry.id), entry]));
    const root = rootOf(entries, focus);
    const out = [];
    const visiting = new Set();
    const walk = (entry) => {
      const key = bareId(entry.id);
      if (visiting.has(key) || out.includes(entry)) return;
      visiting.add(key);
      out.push(entry);
      for (const candidate of entries) {
        if (candidate.parentId && bareId(candidate.parentId) === key) walk(candidate);
      }
    };
    walk(root);
    return out;
  }

  // ── 会话列表：按 id 复用行 ──

  const rows = new Map();
  const subagentRows = new Map();

  function createRow() {
    const row = document.createElement('div');
    row.className = 'row';
    // 顺序：层级枝 → 状态点 → 状态徽标 → 工作区 → 标题 → 副信息 → 当前 → 耗时。
    row.innerHTML =
      '<span class="row-branch mono"></span><span class="dot"></span><span class="badge row-badge"></span><span class="row-workspace mono"></span><span class="row-label"></span><span class="row-sub"></span><span class="row-current"></span><span class="row-meta mono"></span>';
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      void jumpTo(row.dataset.id);
    });
    return row;
  }

  function renderRows(container, store, items, now) {
    const seen = new Set();
    items.forEach(({ entry, depth, branch, current }, index) => {
      seen.add(entry.id);
      let row = store.get(entry.id);
      if (!row) {
        row = createRow();
        store.set(entry.id, row);
      }
      row.dataset.id = entry.id;
      row.dataset.depth = String(depth);
      row.dataset.subagent = entry.isSubagent ? '1' : '0';
      row.dataset.current = current ? '1' : '0';
      row.dataset.group = entry.isOrphanGroup ? '1' : '0';
      const state = stateOf(entry);
      row.dataset.status = state.status;

      setText(row.querySelector('.row-branch'), branch);
      // 组标题不是会话：不挂状态点/徽标（`id` 为空，点击也不会跳转）。
      setStyle(row.querySelector('.dot'), 'background', entry.isOrphanGroup ? P.STATUS_COLOR.idle : state.color);
      const badge = row.querySelector('.row-badge');
      setText(badge, entry.isOrphanGroup ? '' : state.text);
      setStyle(badge, 'color', state.color);
      setStyle(badge, 'background', entry.isOrphanGroup ? 'transparent' : `color-mix(in srgb, ${state.color} 22%, transparent)`);
      toggleClass(badge, 'is-off', false);

      const workspaceNode = row.querySelector('.row-workspace');
      setText(workspaceNode, entry.workspace ? `${entry.workspace} /` : '');
      const workspaceTitle = entry.workspacePath || entry.workspace || '';
      if (workspaceNode.title !== workspaceTitle) workspaceNode.title = workspaceTitle;

      const labelNode = row.querySelector('.row-label');
      setText(labelNode, displayName(entry));
      const labelTitle = entry.isSubagent
        ? entry.subagentLabel || entry.subagentName || entry.label
        : entry.label;
      if (labelNode.title !== labelTitle) labelNode.title = labelTitle;

      const sub = [];
      if (!entry.isSubagent && entry.subagentRunning > 0) sub.push(`子代理 ${entry.subagentRunning}`);
      setText(row.querySelector('.row-sub'), sub.join(' · '));

      const currentNode = row.querySelector('.row-current');
      setText(currentNode, '当前');
      toggleClass(currentNode, 'is-off', !current);

      setText(row.querySelector('.row-meta'), elapsedOf(entry, now));

      const at = container.children[index] ?? null;
      if (at !== row) container.insertBefore(row, at);
    });

    for (const [id, row] of [...store]) {
      if (seen.has(id)) continue;
      row.remove();
      store.delete(id);
    }
  }

  function renderList(items, now = Date.now()) {
    renderRows(list, rows, items, now);
  }

  function renderSubagents(entries, focus, selectedId, offline, now = Date.now()) {
    if (offline || !focus) {
      toggleClass(subagentsPanel, 'is-off', true);
      setText(subagentCount, '');
      renderRows(subagentList, subagentRows, [], now);
      return;
    }
    const children = childrenOf(entries, focus);
    toggleClass(subagentsPanel, 'is-off', children.length === 0);
    setText(subagentCount, children.length > 0 ? `${children.length}` : '');
    const items = children.map((entry, index) => ({
      entry,
      depth: 1,
      branch: index === children.length - 1 ? '└' : '├',
      current: entry.id === selectedId,
    }));
    renderRows(subagentList, subagentRows, items, now);
  }

  // ── 待办：当前树（父 + 子代理）的聚合列表 ──

  const todoRows = [];

  function createTodoRow() {
    const row = document.createElement('div');
    row.className = 'todo-item';
    row.innerHTML =
      '<span class="todo-item-status"></span><span class="todo-item-text"></span><span class="todo-item-owner mono"></span>';
    return row;
  }

  /** 中文/英文混合的轻量 token：ASCII 词 + 中文二元组。 */
  function tokenize(text) {
    const source = String(text ?? '').toLowerCase();
    const tokens = new Set();
    for (const match of source.matchAll(/[a-z0-9_/.-]{3,}/g)) tokens.add(match[0]);
    for (const match of source.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const run = match[0];
      for (let index = 0; index + 2 <= run.length; index += 1) tokens.add(run.slice(index, index + 2));
    }
    return tokens;
  }

  function similarity(left, right) {
    const a = tokenize(left);
    const b = tokenize(right);
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared += 1;
    return shared / Math.sqrt(a.size * b.size);
  }

  function ownerSuffix(child) {
    if (child.subagentState === 'finished') return ' ✓';
    if (child.subagentState === 'stopped') return ' 已停止';
    if (child.subagentState === 'failed') return ' 失败';
    return '';
  }

  /** 父会话 todo 的语义关联：只做提示，不改变 todo 状态。 */
  function inferOwner(content, children) {
    let best = null;
    let bestScore = 0;
    let second = 0;
    for (const child of children) {
      const text = `${child.subagentLabel || ''} ${child.subagentName || ''}`;
      const score = similarity(content, text);
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = child;
      } else if (score > second) {
        second = score;
      }
    }
    if (!best || bestScore < 0.2 || bestScore - second < 0.08) return '';
    const name = best.subagentName || best.subagentLabel || best.shortId;
    return ` [~${name}${ownerSuffix(best)}]`;
  }

  function renderTodos(entries, focus, offline) {
    if (offline) {
      toggleClass(todosPanel, 'is-off', true);
      setText(todoProg, '');
      return;
    }

    const tree = focusTree(entries, focus);
    const children = tree.filter((entry) => entry.isSubagent);
    const items = [];
    for (const entry of tree) {
      if (!Array.isArray(entry.todos)) continue;
      for (const todo of entry.todos) items.push({ entry, todo });
    }

    toggleClass(todosPanel, 'is-off', items.length === 0);
    const doneCount = items.filter((item) => item.todo.status === 'completed').length;
    setText(todoProg, items.length > 0 ? `${doneCount}/${items.length} 已完成` : '');

    const visible = items.slice(0, 8);
    visible.forEach(({ entry, todo }, index) => {
      let row = todoRows[index];
      if (!row) {
        row = createTodoRow();
        todoRows.push(row);
        todoList.appendChild(row);
      }
      const statusNode = row.querySelector('.todo-item-status');
      const statusInfo = TODO_STATUS[todo.status] || TODO_STATUS.pending;
      setText(statusNode, statusInfo.label);
      setStyle(statusNode, 'color', statusInfo.color);
      setStyle(statusNode, 'background', `color-mix(in srgb, ${statusInfo.color} 18%, transparent)`);
      toggleClass(row, 'is-completed', todo.status === 'completed');

      const text = row.querySelector('.todo-item-text');
      setText(text, todo.content);
      if (row.title !== todo.content) row.title = todo.content;

      let owner = '';
      if (entry.isSubagent) {
        const name = entry.subagentName || entry.subagentLabel || entry.shortId;
        owner = `[${name}]${ownerSuffix(entry)}`;
      } else {
        owner = inferOwner(todo.content, children);
      }
      setText(row.querySelector('.todo-item-owner'), owner);
    });

    for (let index = visible.length; index < todoRows.length; index += 1) {
      todoRows[index].remove();
    }
    todoRows.length = visible.length;

    const more = Math.max(0, items.length - visible.length);
    setText(todoMore, more > 0 ? `还有 ${more} 条` : '');
    toggleClass(todoMore, 'is-off', more === 0);
  }

  function repaint() {
    const now = Date.now();
    const config = snapshot && snapshot.config ? snapshot.config : null;
    const runtime = snapshot && snapshot.runtime ? snapshot.runtime : null;
    const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];

    island.dataset.offline = ui.offline ? '1' : '0';
    island.dataset.pinned = ui.pinned ? '1' : '0';
    island.dataset.expanded = ui.expanded ? '1' : '0';
    island.dataset.glow = config && config.glowEffect === false ? '0' : '1';

    const selected = ui.offline ? null : pickSelected(entries);
    const focus = ui.offline ? null : pickFocus(entries);
    const focusState = focus ? stateOf(focus) : null;
    const liveCount = entries.filter((entry) => entry.live === true).length;
    const activeCount = entries.filter((entry) => entry.status === 'thinking' || entry.status === 'tool').length;
    const status = ui.offline ? 'offline' : focusState ? focusState.status : 'idle';
    island.dataset.live = liveCount > 0 ? '1' : '0';
    island.dataset.status = status;
    // 有工作区标签时折叠态需要更宽，否则工作区与标题互相挤成残句。
    island.dataset.workspace = focus && focus.workspace ? '1' : '0';

    const dotColour = ui.offline ? P.STATUS_COLOR.idle : focusState ? focusState.color : P.STATUS_COLOR.idle;
    setStyle(hDot, 'background', dotColour);

    // 折叠态 → 展开态共用的表头：标题 + 耗时（+ 还有几个在执行）
    setText(hBadge, ui.offline ? BADGE.offline : focusState ? focusState.text : BADGE.idle);
    const workspaceText = focus && focus.workspace ? `${focus.workspace} /` : '';
    setText(hWorkspace, workspaceText);
    const workspaceTitle = focus ? focus.workspacePath || focus.workspace || '' : '';
    if (hWorkspace.title !== workspaceTitle) hWorkspace.title = workspaceTitle;

    const title = ui.offline ? '未连接宿主' : focus ? displayName(focus) : 'DSH 待命';
    setText(hTitle, title);
    const titleTip = focus ? focus.subagentLabel || focus.subagentName || focus.label : '';
    if (hTitle.title !== titleTip) hTitle.title = titleTip;
    const elapsed = ui.offline ? '' : elapsedOf(focus, now);
    setText(
      hElapsed,
      elapsed === '' ? '' : activeCount > 1 ? `${elapsed} · +${activeCount - 1}` : elapsed,
    );

    const fraction =
      focus && Number.isFinite(focus.contextFraction) ? Math.max(0, Math.min(1, focus.contextFraction)) : null;

    // 具体过程只在会话行显示（`STATUS_LABEL`），展开态不再单独占一行。
    renderTodos(entries, focus, ui.offline);
    renderSubagents(entries, focus, selected ? selected.id : null, ui.offline, now);

    if (ui.offline) {
      for (const [, row] of rows) row.remove();
      rows.clear();
      renderRows(subagentList, subagentRows, [], now);
      setText(stats, '');
    } else {
      // 表头承担根会话；子代理单独成组，其余根会话留在列表里。
      renderList(buildTreeRows(entries, focus, selected ? selected.id : null, true), now);

      // 统计：轮次 / 工具 / 子代理 / 上下文 / 累计 token
      const parts = [];
      if (focus && focus.turn > 0) parts.push(`轮次 ${focus.turn}`);
      if (focus && focus.toolCount > 0) parts.push(`工具 ${focus.toolCount}`);
      if (focus && focus.subagentRunning > 0) parts.push(`子代理 ${focus.subagentRunning}`);
      if (fraction !== null) {
        parts.push(`上下文 ${Math.round(fraction * 100)}%`);
      } else if (focus && Number.isFinite(focus.contextTokens)) {
        // 分母拿不到时至少给出已用 token 数，而不是完全隐藏。
        parts.push(`上下文 ${formatTokens(focus.contextTokens)}`);
      }
      if (focus && Number.isFinite(focus.tokenTotal) && focus.tokenTotal > 0) {
        parts.push(`Token ${formatTokens(focus.tokenTotal)}`);
      }
      if (activeCount > 1) parts.push(`执行中 ${activeCount}`);
      setText(stats, parts.join(' · '));
    }

    // 累计 token 的明细放悬浮提示：主数字不把缓存读写算进去，明细里给全。
    const detail = ui.offline ? '' : tokenTitle(focus);
    if (stats.title !== detail) stats.title = detail;

    // 页脚
    setText(
      link,
      ui.offline
        ? ui.error
          ? `未连接 · ${ui.error}`
          : '未连接 · 等待 DSH 宿主'
        : runtime
          ? `宿主进程 ${runtime.pid} · 端口 ${runtime.port}`
          : '已连接',
    );
    toggleClass(link, 'is-bad', ui.offline === true);

    setText(hint, hintText(config));
    toggleClass(hint, 'is-bad', ui.flash !== null && ui.flash.ok === false);

    // “保持展开”是面板级开关，放在页脚；不放在表头/会话行上，避免被读成
    // “固定这个会话”。
    // 文案固定为“保持展开”，只靠高亮表示当前状态；不要因为切换而改变
    // 文字长度/控件宽度（会让人误以为字号变了）。
    setText(pin, '保持展开');
    toggleClass(pin, 'is-on', ui.pinned);
    pin.setAttribute('aria-pressed', ui.pinned ? 'true' : 'false');
    pin.title = ui.pinned ? '恢复自动收起' : '鼠标离开后保持展开';
  }

  function hintText(config) {
    if (ui.flash !== null && Date.now() - ui.flashAt < 2000) return ui.flash.message;
    if (config && config.jumpEnabled === false) return '跳转已在设置里关闭';
    return '点会话跳转';
  }

  // ── 交互 ──

  let rect = null;
  const invalidateRect = () => {
    rect = null;
  };

  function contains(x, y) {
    if (rect === null) rect = island.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  let inside = false;
  document.addEventListener(
    'mousemove',
    (event) => {
      const next = contains(event.clientX, event.clientY);
      if (next === inside) return;
      inside = next;
      // 进岛才临时接管点击；出岛立刻还回去。`forward:true` 保证这里一直收得到 mousemove。
      void I.setInteractive(next);
      if (next) {
        const config = snapshot && snapshot.config ? snapshot.config : null;
        if (!config || config.expandOnHover !== false) setExpanded(true);
      } else if (!ui.pinned) {
        setExpanded(false);
      }
    },
    { passive: true },
  );

  document.addEventListener('mouseleave', () => {
    if (!inside) return;
    inside = false;
    void I.setInteractive(false);
    if (!ui.pinned) setExpanded(false);
  });

  // 看门狗在 main 侧强制收回穿透时，这里也要丢掉悬停态，避免"看着还高亮但点不动"。
  I.onPointer((info) => {
    if (info && info.interactive === true) return;
    inside = false;
    if (!ui.pinned) setExpanded(false);
  });

  function setExpanded(value) {
    if (ui.expanded === value) return;
    ui.expanded = value;
    island.dataset.expanded = value ? '1' : '0';
    repaint();
  }

  // 表头点击只用于确认“已完成/已停止”；平时不承担其他点击行为。
  hdr.addEventListener('click', () => {
    const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
    const focus = pickFocus(entries);
    if (focus && (focus.stopped === true || focus.status === 'done')) {
      void I.ack(focus.id);
    }
  });

  // “保持展开”是面板级开关：鼠标移开后也不收起。
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    ui.pinned = !ui.pinned;
    setExpanded(ui.pinned ? true : inside);
    repaint();
  });

  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void I.contextMenu();
  });

  async function jumpTo(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return;
    const config = snapshot && snapshot.config ? snapshot.config : null;
    if (config && config.jumpEnabled === false) {
      ui.flash = { ok: false, message: '跳转已在设置里关闭' };
      ui.flashAt = Date.now();
      repaint();
      return;
    }
    let result = null;
    try {
      result = await I.jump(sessionId);
    } catch (error) {
      result = { ok: false, message: String(error && error.message ? error.message : error) };
    }
    ui.flash = { ok: !!(result && result.ok), message: (result && result.message) || '已请求跳转' };
    ui.flashAt = Date.now();
    repaint();
  }

  // ── 与主进程的数据通道 ──

  I.onSnapshot((message) => {
    if (!message || message.ok !== true) {
      ui.offline = true;
      ui.error = (message && message.error) || null;
      repaint();
      return;
    }
    ui.offline = false;
    ui.error = null;
    snapshot = message.payload;
    repaint();
  });

  new ResizeObserver(invalidateRect).observe(island);

  // 耗时每秒自己走：不必为了刷新一个秒数去求宿主多发一拍。
  setInterval(repaint, 1000);

  repaint();
})();
