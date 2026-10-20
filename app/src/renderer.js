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
  const todo = el('todo');
  const todoCur = el('todo-cur');
  const todoProg = el('todo-prog');
  const list = el('list');
  const stats = el('stats');
  const link = el('link');
  const hint = el('hint');
  const pin = el('pin');
  const hdr = el('hdr');
  hdr.title = '当前会话';

  const BADGE = { idle: '空闲', thinking: '思考中', tool: '调用工具', done: '已完成', offline: '未连接' };
  const STATUS_LABEL = { idle: '空闲', thinking: '思考中', tool: '调用工具', done: '已完成' };

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

  /** 表头代表当前 DSH 会话：有 primaryId 就显示它（即使 idle）；否则 live/第一条。 */
  function pickFocus(entries) {
    if (entries.length === 0) return null;
    const primaryId = snapshot ? snapshot.primaryId : null;
    if (primaryId) {
      const primary = entries.find((entry) => entry.id === primaryId);
      if (primary) return primary;
    }
    const live = entries.find((entry) => entry.live === true);
    return live || entries[0];
  }

  function elapsedOf(entry, now) {
    if (!entry || entry.live !== true) return '';
    if (!Number.isFinite(entry.elapsedFrom) || entry.elapsedFrom <= 0) return '';
    return formatElapsed(now - entry.elapsedFrom);
  }

  // ── 会话列表：按 id 复用行 ──

  const rows = new Map();

  function createRow() {
    const row = document.createElement('div');
    row.className = 'row';
    // 和表头保持同一套顺序：dot → 状态徽标 → 工作区 → 标题 → 副信息 → 耗时。
    row.innerHTML =
      '<span class="dot"></span><span class="badge row-badge"></span><span class="row-workspace mono"></span><span class="row-label"></span><span class="row-sub"></span><span class="row-meta mono"></span>';
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      void jumpTo(row.dataset.id);
    });
    return row;
  }

  function renderList(entries, now = Date.now()) {
    const seen = new Set();
    entries.forEach((entry, index) => {
      seen.add(entry.id);
      let row = rows.get(entry.id);
      if (!row) {
        row = createRow();
        rows.set(entry.id, row);
      }
      row.dataset.id = entry.id;
      row.dataset.status = entry.stopped ? 'stopped' : entry.status;

      const colour = entry.glow || P.STATUS_COLOR[entry.status] || P.STATUS_COLOR.idle;
      setStyle(row.querySelector('.dot'), 'background', colour);
      const badge = row.querySelector('.row-badge');
      setText(badge, entry.stopped ? '已停止' : STATUS_LABEL[entry.status] || entry.status);
      setStyle(badge, 'color', colour);
      setStyle(badge, 'background', `color-mix(in srgb, ${colour} 22%, transparent)`);

      const workspaceNode = row.querySelector('.row-workspace');
      setText(workspaceNode, entry.workspace ? `${entry.workspace} /` : '');
      const workspaceTitle = entry.workspacePath || entry.workspace || '';
      if (workspaceNode.title !== workspaceTitle) workspaceNode.title = workspaceTitle;

      setText(row.querySelector('.row-label'), entry.label);

      const sub = [];
      if (entry.subagentRunning > 0) sub.push(`子代理 ${entry.subagentRunning}`);
      if (entry.todoTotal > 0) sub.push(`待办 ${entry.todoDone}/${entry.todoTotal}`);
      setText(row.querySelector('.row-sub'), sub.join(' · '));

      setText(row.querySelector('.row-meta'), elapsedOf(entry, now));

      const at = list.children[index] ?? null;
      if (at !== row) list.insertBefore(row, at);
    });

    for (const [id, row] of [...rows]) {
      if (seen.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
  }

  // ── 重画 ──

  function repaint() {
    const now = Date.now();
    const config = snapshot && snapshot.config ? snapshot.config : null;
    const runtime = snapshot && snapshot.runtime ? snapshot.runtime : null;
    const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];

    island.dataset.offline = ui.offline ? '1' : '0';
    island.dataset.pinned = ui.pinned ? '1' : '0';
    island.dataset.expanded = ui.expanded ? '1' : '0';
    island.dataset.glow = config && config.glowEffect === false ? '0' : '1';

    const focus = ui.offline ? null : pickFocus(entries);
    const liveCount = entries.filter((entry) => entry.live === true).length;
    const status = ui.offline ? 'offline' : focus ? (focus.stopped ? 'stopped' : focus.status) : 'idle';
    island.dataset.live = liveCount > 0 ? '1' : '0';
    island.dataset.status = status;
    // 有工作区标签时折叠态需要更宽，否则工作区与标题互相挤成残句。
    island.dataset.workspace = focus && focus.workspace ? '1' : '0';

    const dotColour = ui.offline
      ? P.STATUS_COLOR.idle
      : focus
        ? focus.glow || P.STATUS_COLOR[focus.status]
        : P.STATUS_COLOR.idle;
    setStyle(hDot, 'background', dotColour);

    // 折叠态 → 展开态共用的表头：标题 + 耗时（+ 还有几个在执行）
    setText(
      hBadge,
      ui.offline ? BADGE.offline : focus && focus.stopped ? '已停止' : BADGE[status] || status.toUpperCase(),
    );
    const workspaceText = focus && focus.workspace ? `${focus.workspace} /` : '';
    setText(hWorkspace, workspaceText);
    const workspaceTitle = focus ? focus.workspacePath || focus.workspace || '' : '';
    if (hWorkspace.title !== workspaceTitle) hWorkspace.title = workspaceTitle;

    setText(hTitle, ui.offline ? '未连接宿主' : focus ? focus.label : 'DSH 待命');
    const elapsed = ui.offline ? '' : elapsedOf(focus, now);
    setText(
      hElapsed,
      elapsed === '' ? '' : liveCount > 1 ? `${elapsed} · +${liveCount - 1}` : elapsed,
    );

    const fraction =
      focus && Number.isFinite(focus.contextFraction) ? Math.max(0, Math.min(1, focus.contextFraction)) : null;

    // 具体过程只在会话行显示（`STATUS_LABEL`），展开态不再单独占一行。

    // 待办
    const todoText = ui.offline ? '' : focus && focus.todoText ? focus.todoText : '';
    toggleClass(todo, 'is-off', todoText === '');
    setText(todoCur, todoText);
    setText(
      todoProg,
      focus && focus.todoTotal > 0 ? `${focus.todoDone}/${focus.todoTotal}` : '',
    );

    if (ui.offline) {
      for (const [, row] of rows) row.remove();
      rows.clear();
      setText(stats, '');
    } else {
      // 表头已经代表当前会话；列表只列“其他会话”，避免同一行状态出现两遍。
      const focusId = focus ? focus.id : null;
      const otherEntries = focusId === null ? entries : entries.filter((entry) => entry.id !== focusId);
      renderList(otherEntries, now);

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
      if (liveCount > 1) parts.push(`执行中 ${liveCount}`);
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
