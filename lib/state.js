/**
 * @module @dsh-external/dsh-notch-win/state
 *
 * 状态机。**零 I/O、零 DSH 依赖、纯数据进出** —— 因此可以脱离宿主单测
 * （`test/state.test.mjs` 直接喂合成事件）。
 *
 * 这是「方案 A」的核心：状态在宿主进程**内存里**累加，不再去磁盘上解压会话
 * 日志、读投影缓存、比 mtime。
 *
 * ## 关键设计点
 *
 * 1. `执行中 / 执行完成` 的翻转**只由 `agent/status` 驱动**。`turn/end` 不等于
 *    agent 结束（agent 可能继续下一轮），所以它不参与状态判定。
 * 2. `thinking ↔ tool` 由 `tool/call` 与 `tool/result` 的配对决定（`inFlight`）。
 * 3. 会话事件负载在 `event.data` 下 —— `SessionEvent = { type, seq, time, data }`，
 *    不是平铺的。这一点在 DESIGN.md 早期草稿里写错过，此处为准。
 */
import {
  DETAIL_MAX,
  EVICT_IDLE_MS,
  MAX_ENTRIES,
  PROTOCOL_VERSION,
  SESSION_MAP_MAX,
  STATUS_COLOR,
  STATUS_RANK,
} from './protocol.js';

/** 只有这些事件类型会改变展示；其余的连条目都不建。 */
const HANDLED = new Set([
  'turn/start',
  'step/start',
  'tool/call',
  'tool/result',
  'todo/write',
  'assistant/message',
  'request/context',
  'turn/end',
  'user/message',
  'session/title',
]);

const LABEL_MAX = 40;
const SUBAGENT_LABEL_MAX = 80;
const WORKSPACE_MAX = 32;
const PATH_MAX = 260;
const TODO_MAX = 200;
const SUBAGENT_RETENTION_MS = 300000;
const ARG_PARSE_MAX = 4096;
const HINT_MAX = 80;

/** `onMeta` 接收的累计 token 字段（值都是整数 token 数）。 */
const TOKEN_KEYS = ['tokenTotal', 'tokenInput', 'tokenOutput', 'tokenCacheRead', 'tokenCacheWrite'];

const SUBAGENT_STATES = new Set(['running', 'finished', 'stopped', 'failed']);

/** 参数里最像"人类想看的那个东西"的键，按优先级排列。 */
const HINT_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'cmd',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'name',
];

export function createState() {
  return { sessions: new Map(), primaryId: null };
}

export function shortId(id) {
  const s = String(id ?? '');
  const stripped = s.startsWith('session-') ? s.slice('session-'.length) : s;
  return stripped.slice(0, 8);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 去掉控制字符、折叠空白、截断。detailText / label 都必须过这一关。 */
export function clip(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function ensure(state, id) {
  let entry = state.sessions.get(id);
  if (entry) return entry;
  // 同一个会话可能以 `session-<uuid>` 或裸 `<uuid>` 两种形式出现（focus / team /
  // subagent catalog）；复用已有条目，避免点击子代理时复制出一个顶级会话。
  const bare = bareId(id);
  for (const existing of state.sessions.values()) {
    if (bareId(existing.id) === bare) return existing;
  }
  entry = {
    id,
    label: null,
    /** 标题来源：`title`（DSH 会话标题）> `message`（首条用户消息）> `cwd`（工作目录名）> null。 */
    labelSource: null,
    /** 会话创建时间：用于固定兄弟子代理的排列顺序。 */
    createdAt: null,
    /** 工作区名（cwd 末段）与完整路径；只用于展示，不参与标题回落。 */
    workspace: null,
    workspacePath: null,
    status: 'idle',
    elapsedFrom: null,
    turn: null,
    step: null,
    inFlight: new Map(),
    toolName: null,
    toolCount: 0,
    subagentRunning: 0,
    /** 子代理层级：父会话 id / 是否子代理 / 名称 / 终态。 */
    parentId: null,
    isSubagent: false,
    subagentName: null,
    subagentLabel: null,
    subagentState: null,
    retainedUntil: null,
    contextTokens: null,
    contextLimit: null,
    /** 会话累计 token：total = 未缓存输入 + 输出；其余三项供明细展示。 */
    tokenTotal: null,
    tokenInput: null,
    tokenOutput: null,
    tokenCacheRead: null,
    tokenCacheWrite: null,
    todoTotal: 0,
    todoDone: 0,
    todoText: null,
    /** 当前轮次完整待办：{ content, status }[]。 */
    todos: [],
    detailText: null,
    lastSeq: -1,
    updatedAt: 0,
    /** done 状态下是否是用户主动停止（turn/end reason.kind === 'aborted'）。 */
    stopped: false,
    /** 用户点击表头确认后，暂时抑制投影回填的待办/子代理，直到下一轮或新事件。 */
    acked: false,
  };
  state.sessions.set(id, entry);
  return entry;
}

/** 比较会话 id 时忽略 `session-` 前缀：DSH 的 team/settlement 事件用裸 uuid。 */
function bareId(value) {
  const s = String(value ?? '');
  return s.startsWith('session-') ? s.slice('session-'.length) : s;
}

function findEntry(state, value) {
  if (value === null || value === undefined) return null;
  const id = String(value);
  const direct = state.sessions.get(id);
  if (direct) return direct;
  const bare = bareId(id);
  for (const [key, entry] of state.sessions) {
    if (bareId(key) === bare) return entry;
  }
  return null;
}

function normalizeTodos(input) {
  if (!Array.isArray(input)) return [];
  const todos = [];
  for (const item of input.slice(0, TODO_MAX)) {
    if (!item || typeof item !== 'object') continue;
    const content = clip(item.content, DETAIL_MAX);
    if (content === '') continue;
    const status =
      item.status === 'completed' ? 'completed' : item.status === 'in_progress' ? 'in_progress' : 'pending';
    todos.push({ content, status });
  }
  return todos;
}

function syncTodos(entry) {
  entry.todoTotal = entry.todos.length;
  entry.todoDone = entry.todos.filter((todo) => todo.status === 'completed').length;
  const active = entry.todos.find((todo) => todo.status === 'in_progress') || entry.todos.find((todo) => todo.status === 'pending');
  entry.todoText = active ? active.content : null;
}

/** 父会话是否还挂着子条目（按 bare id 比较，避免 session- 前缀差异）。 */
function hasChildren(state, parentId) {
  const parent = bareId(parentId);
  for (const entry of state.sessions.values()) {
    if (entry.parentId !== null && bareId(entry.parentId) === parent) return true;
  }
  return false;
}

/** 父会话 ack / 新轮次时清掉子代理行；ack 时连未标记终态的子代理一起清。 */
function pruneFinishedChildren(state, parentId, includeAll = false) {
  const parent = bareId(parentId);
  let changed = false;
  for (const [id, entry] of [...state.sessions]) {
    if (entry.parentId === null || bareId(entry.parentId) !== parent) continue;
    if (!includeAll) {
      if (entry.subagentState === null || entry.subagentState === 'running') continue;
      if (entry.status !== 'done' && entry.status !== 'idle') continue;
    }
    state.sessions.delete(id);
    if (state.primaryId === id) state.primaryId = null;
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 摄入
// ---------------------------------------------------------------------------

/**
 * 把一条输入折进状态。
 *
 * @param state `createState()` 的产物（原地修改）
 * @param input 见下方 `kind` 分派；全部来自宿主半边的订阅回调
 * @param now   epoch ms（显式传入以便单测控制时间）
 * @returns 是否真的改变了可发布的内容
 */
export function ingest(state, input, now) {
  if (!input || typeof input !== 'object') return false;
  const at = typeof now === 'number' ? now : Date.now();
  switch (input.kind) {
    case 'status':
      return onStatus(state, input, at);
    case 'created':
      return onCreated(state, input, at);
    case 'disposed':
      return onDisposed(state, input, at);
    case 'event':
      return onEvent(state, input, at);
    case 'meta':
      return onMeta(state, input, at);
    case 'focus':
      return onFocus(state, input, at);
    case 'ack':
      return onAck(state, input, at);
    default:
      return false;
  }
}

function onStatus(state, input, now) {
  const id = String(input.agentId ?? '');
  if (id === '') return false;
  const entry = ensure(state, id);

  if (input.status === 'running') {
    const alreadyLive = entry.status === 'thinking' || entry.status === 'tool';
    if (alreadyLive) {
      // 不碰 updatedAt：它参与排序 → 会影响 rev。既然返回 false（"没有可见变化"），
      // 就不能在暗地里改变排序。
      return false;
    }
    entry.status = entry.inFlight.size > 0 ? 'tool' : 'thinking';
    entry.elapsedFrom = now; // 精确起点：agent/status 的转换时刻
    entry.stopped = false;
    entry.acked = false;
    entry.updatedAt = now;
    return true;
  }

  if (input.status !== 'idle') return false;
  if (entry.status === 'idle' || entry.status === 'done') return false;

  // done 不再定时自动回 idle：保持到用户主动确认（ack）或下一轮开始。
  entry.status = 'done';
  entry.updatedAt = now;
  return true;
}

function onCreated(state, input, now) {
  const id = String(input.agentId ?? '');
  if (id === '') return false;
  const existed = state.sessions.has(id);
  const entry = ensure(state, id);
  entry.updatedAt = now;
  return !existed;
}

function onDisposed(state, input, now) {
  const id = String(input.agentId ?? '');
  if (id === '') return false;
  const entry = findEntry(state, id);
  if (!entry) return false;

  // 子代理不能立即删：停止/完成后仍要保留终态行，等父会话 ack/下一轮或超时回收。
  if (entry.isSubagent) {
    if (entry.status !== 'done' && entry.status !== 'idle') entry.status = 'done';
    if (entry.subagentState === null || entry.subagentState === 'running') {
      entry.subagentState = entry.stopped ? 'stopped' : 'finished';
    }
    entry.retainedUntil = now + SUBAGENT_RETENTION_MS;
    entry.updatedAt = now;
    return true;
  }

  // 父会话即使被 DSH dispose，只要还挂着子代理行就不能直接删，否则子代理会
  // 变成顶级会话。保留为 idle 占位，等子代理先被回收/ack 后再清理。
  if (hasChildren(state, entry.id)) {
    entry.status = 'idle';
    entry.elapsedFrom = null;
    entry.updatedAt = now;
    return true;
  }

  state.sessions.delete(entry.id);
  if (state.primaryId === entry.id) state.primaryId = null;
  return true;
}

function onMeta(state, input, now) {
  const id = String(input.sessionId ?? '');
  if (id === '') return false;
  const entry = ensure(state, id);
  let changed = false;

  if (typeof input.label === 'string') {
    const next = clip(input.label, LABEL_MAX);
    const rank = input.labelSource === 'title' ? 3 : input.labelSource === 'cwd' ? 1 : 2;
    const currentRank =
      entry.labelSource === 'title' ? 3 : entry.labelSource === 'message' ? 2 : entry.labelSource === 'cwd' ? 1 : 0;
    if (next !== '' && rank > currentRank) {
      entry.label = next;
      entry.labelSource = rank === 3 ? 'title' : rank === 2 ? 'message' : 'cwd';
      changed = true;
    } else if (next !== '' && rank === currentRank && entry.label !== next) {
      entry.label = next;
      changed = true;
    }
  }
  if (typeof input.workspace === 'string') {
    const next = clip(input.workspace, WORKSPACE_MAX);
    if (next !== '' && entry.workspace !== next) {
      entry.workspace = next;
      changed = true;
    }
  }
  if (typeof input.workspacePath === 'string') {
    const next = clip(input.workspacePath, PATH_MAX);
    if (next !== '' && entry.workspacePath !== next) {
      entry.workspacePath = next;
      changed = true;
    }
  }
  if (typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt > 0) {
    if (entry.createdAt !== input.createdAt) {
      entry.createdAt = input.createdAt;
      changed = true;
    }
  }
  if (typeof input.parentId === 'string') {
    const next = input.parentId.trim();
    if (next !== '' && entry.parentId !== next) {
      entry.parentId = next;
      changed = true;
    }
  }
  if (typeof input.isSubagent === 'boolean' && entry.isSubagent !== input.isSubagent) {
    entry.isSubagent = input.isSubagent;
    changed = true;
  }
  for (const [key, max] of [
    ['subagentName', LABEL_MAX],
    ['subagentLabel', SUBAGENT_LABEL_MAX],
  ]) {
    if (typeof input[key] === 'string') {
      const next = clip(input[key], max);
      if (next !== '' && entry[key] !== next) {
        entry[key] = next;
        changed = true;
      }
    }
  }
  if (typeof input.subagentState === 'string' && SUBAGENT_STATES.has(input.subagentState)) {
    if (entry.subagentState !== input.subagentState) {
      entry.subagentState = input.subagentState;
      changed = true;
    }
  }
  if (Array.isArray(input.todos)) {
    const next = normalizeTodos(input.todos);
    if (stableStringify(next) !== stableStringify(entry.todos)) {
      entry.todos = next;
      syncTodos(entry);
      changed = true;
    }
  }
  if (typeof input.subagentRunning === 'number' && Number.isFinite(input.subagentRunning)) {
    const next = Math.max(0, Math.trunc(input.subagentRunning));
    if (next !== entry.subagentRunning) {
      entry.subagentRunning = next;
      changed = true;
    }
  }
  if (typeof input.contextLimit === 'number' && Number.isFinite(input.contextLimit) && input.contextLimit > 0) {
    if (entry.contextLimit !== input.contextLimit) {
      entry.contextLimit = input.contextLimit;
      changed = true;
    }
  }
  if (typeof input.contextTokens === 'number' && Number.isFinite(input.contextTokens) && input.contextTokens >= 0) {
    if (entry.contextTokens !== input.contextTokens) {
      entry.contextTokens = input.contextTokens;
      changed = true;
    }
  }
  for (const key of TOKEN_KEYS) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && entry[key] !== value) {
      entry[key] = value;
      changed = true;
    }
  }
  if (changed) entry.updatedAt = now;
  return changed;
}

function onFocus(state, input, now) {
  const next = input.sessionId == null ? null : String(input.sessionId);
  let changed = false;
  let target = null;

  // 焦点会话可能还没有任何事件（插件启动前就存在的空闲会话）。先建条目，
  // 否则 primaryId 指向一个不在 entries 里的 id，岛会回落到第一条旧会话。
  if (next !== null) {
    const existed = findEntry(state, next) !== null;
    const entry = ensure(state, next);
    target = entry.id;
    if (!existed) {
      entry.updatedAt = now;
      changed = true;
    }
  }

  if (state.primaryId === target) return changed;
  state.primaryId = target;
  return true;
}

function onAck(state, input, now) {
  const id = String(input.sessionId ?? '');
  if (id === '') return false;
  const entry = findEntry(state, id);
  if (!entry || entry.status !== 'done') return false;
  const key = entry.id;

  if (entry.isSubagent) {
    state.sessions.delete(key);
    if (state.primaryId === key) state.primaryId = null;
    return true;
  }

  entry.status = 'idle';
  entry.stopped = false;
  entry.acked = true;
  entry.elapsedFrom = null;
  entry.toolName = null;
  entry.inFlight.clear();
  entry.subagentRunning = 0;
  entry.todos = [];
  syncTodos(entry);
  entry.updatedAt = now;
  pruneFinishedChildren(state, key, true);
  return true;
}

function onEvent(state, input, now) {
  const event = input.event;
  if (!event || typeof event !== 'object') return false;
  const type = event.type;
  if (typeof type !== 'string' || !HANDLED.has(type)) return false;

  const id = String(input.sessionId ?? '');
  if (id === '') return false;
  const entry = ensure(state, id);

  // 重放保护：同一会话内 seq 回退即丢弃。
  // 会话恢复会把历史事件按序重放，seq 单调；任何倒退都来自重放或我们订阅晚于
  // 事件本身，两种情况都不允许状态倒退。
  if (typeof event.seq === 'number') {
    if (event.seq <= entry.lastSeq) return false;
    entry.lastSeq = event.seq;
  }

  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const before = fingerprint(entry);

  switch (type) {
    case 'turn/start': {
      entry.turn = numberOrNull(data.turn);
      entry.step = null;
      entry.toolCount = 0;
      entry.toolName = null;
      entry.inFlight.clear();
      entry.stopped = false;
      entry.acked = false;
      entry.todos = [];
      syncTodos(entry);
      if (entry.isSubagent) {
        entry.subagentState = 'running';
        entry.retainedUntil = null;
      } else {
        pruneFinishedChildren(state, entry.id);
      }
      break;
    }
    case 'step/start': {
      entry.turn = numberOrNull(data.turn);
      entry.step = numberOrNull(data.step);
      if (entry.inFlight.size === 0 && (entry.status === 'thinking' || entry.status === 'tool')) {
        entry.status = 'thinking';
      }
      break;
    }
    case 'tool/call': {
      const callId = String(data.callId ?? '');
      const name = clip(data.name, 48) || 'tool';
      if (callId !== '') entry.inFlight.set(callId, name);
      entry.toolName = name;
      entry.toolCount += 1;
      entry.detailText = summarizeCall(name, data.arguments);
      if (entry.status !== 'idle') entry.status = 'tool';
      break;
    }
    case 'tool/result': {
      // tool/result 的负载里**没有** callId —— 配对信息在
      // `data.message.content[0].toolCallId`（ToolResultBlock）。
      const blocks = data.message && Array.isArray(data.message.content) ? data.message.content : [];
      for (const block of blocks) {
        if (block && typeof block === 'object' && typeof block.toolCallId === 'string') {
          entry.inFlight.delete(block.toolCallId);
        }
      }
      if (entry.inFlight.size === 0) {
        entry.toolName = null;
        if (entry.status === 'tool') entry.status = 'thinking';
      }
      break;
    }
    case 'todo/write': {
      entry.acked = false;
      entry.todos = normalizeTodos(data.todos);
      syncTodos(entry);
      break;
    }
    case 'assistant/message': {
      const usage = data.usage;
      if (usage && typeof usage === 'object') {
        // Token-meter 的口径：prompt 侧压力 = 未缓存输入 + 缓存读 + 缓存写。
        const input = numberOrNull(usage.inputTokens);
        const cacheRead = numberOrNull(usage.cacheReadTokens) ?? 0;
        const cacheWrite = numberOrNull(usage.cacheWriteTokens) ?? 0;
        if (input !== null && input >= 0) entry.contextTokens = input + cacheRead + cacheWrite;
      }
      break;
    }
    case 'request/context': {
      // 模型上下文窗口（分母）由 DSH 的 request/context 事件给出；token-meter
      // 的 contextPressure 投影用的也是这个字段。
      const limit = numberOrNull(data.contextWindow);
      if (limit !== null && limit > 0) entry.contextLimit = limit;
      break;
    }
    case 'turn/end': {
      entry.toolName = null;
      entry.inFlight.clear();
      const reason = data.reason;
      const kind = reason && typeof reason === 'object' ? reason.kind : reason;
      // DSH 的停止按钮会让 turn/end 带 reason.kind = 'aborted'。
      entry.stopped = kind === 'aborted';
      if (entry.isSubagent) {
        entry.subagentState =
          kind === 'completed' ? 'finished' : kind === 'aborted' ? 'stopped' : 'failed';
        entry.retainedUntil = now + SUBAGENT_RETENTION_MS;
      }
      break;
    }
    case 'user/message': {
      const source = data.source && typeof data.source === 'object' ? data.source : null;
      if (source && source.kind === 'subagent-settled') {
        const child = findEntry(state, source.senderSessionId);
        if (child) {
          const summary = String(source.summary || firstText(data) || '');
          child.subagentState = /stopped/i.test(summary)
            ? 'stopped'
            : /failed|declined|ran out|abnormally/i.test(summary)
              ? 'failed'
              : 'finished';
          child.status = 'done';
          child.elapsedFrom = null;
          child.retainedUntil = now + SUBAGENT_RETENTION_MS;
          child.updatedAt = now;
        }
        break;
      }
      // 标题的第 2 级回落：首条有正文的用户消息。DSH 自己的会话标题（第 1 级）
      // 一旦到了就不再用消息覆盖它；注入的 AGENTS.md / 文件变更通知通常很长，
      // 用长度上限排掉它们。
      if (entry.labelSource === null || entry.labelSource === 'cwd') {
        const text = firstText(data);
        if (text !== null && text.length <= 200) {
          entry.label = clip(text, LABEL_MAX);
          entry.labelSource = 'message';
        }
      }
      break;
    }
    case 'session/title': {
      // DSH 会话标题是展示层最该用的名字（侧栏看到的就是它）。用最高优先级
      // 记下来，后续 user/message 不会把它覆盖掉。
      const title = clip(data.title, LABEL_MAX);
      if (title !== '') {
        entry.label = title;
        entry.labelSource = 'title';
      }
      break;
    }
    /* c8 ignore next 2 -- HANDLED 已收口，default 仅是防御 */
    default:
      break;
  }

  const after = fingerprint(entry);
  if (before !== after) {
    entry.updatedAt = now;
    return true;
  }
  return false;
}

function firstText(message) {
  if (!message || typeof message !== 'object') return null;
  const content = Array.isArray(message.content) ? message.content : null;
  if (!content) return null;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = clip(block.text, 400);
      if (text !== '') return text;
    }
  }
  return null;
}

/**
 * 参数摘要：**只**取一个键的值，绝不把整个 arguments 搬进 IPC。
 * 模型产出的 arguments 是原始 JSON 字符串，可能很大，所以超过阈值就不解析。
 */
export function summarizeCall(name, argsJson) {
  const tool = clip(name, 48) || 'tool';
  const hint = argumentHint(argsJson);
  return clip(hint ? `${tool} · ${hint}` : tool, DETAIL_MAX);
}

function argumentHint(argsJson) {
  if (typeof argsJson !== 'string' || argsJson.length === 0 || argsJson.length > ARG_PARSE_MAX) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  for (const key of HINT_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(value, HINT_MAX);
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim() !== '') return clip(value, HINT_MAX);
  }
  return null;
}

/** 用于"这次摄入是否改变了可见内容"的比较键：排除 updatedAt / lastSeq 这类内部字段。 */
function fingerprint(entry) {
  return [
    entry.status,
    entry.stopped,
    entry.label,
    entry.elapsedFrom,
    entry.turn,
    entry.step,
    entry.toolName,
    entry.toolCount,
    entry.subagentRunning,
    entry.parentId,
    entry.isSubagent,
    entry.subagentName,
    entry.subagentLabel,
    entry.subagentState,
    entry.retainedUntil,
    stableStringify(entry.todos),
    entry.contextTokens,
    entry.contextLimit,
    entry.todoTotal,
    entry.todoDone,
    entry.todoText,
    entry.detailText,
    entry.inFlight.size,
  ].join('\u0001');
}

// ---------------------------------------------------------------------------
// 时间推进
// ---------------------------------------------------------------------------

/**
 * 推进时间驱动的转换（`done → idle`）并回收陈旧条目。
 * 由发布定时器调用；没有任何活动时宿主不该排队定时器。
 */
export function tick(state, now) {
  const at = typeof now === 'number' ? now : Date.now();
  let changed = false;

  // done/stopped 不再定时清掉：由用户点击确认（ack）或下一轮开始来推进。
  if (evict(state, at)) changed = true;
  return changed;
}

function isIdle(entry) {
  return entry.status === 'idle';
}

function evict(state, now) {
  let changed = false;

  // 先处理终态子代理的保留期；父会话不在这里单独删。
  for (const [id, entry] of state.sessions) {
    if (id === state.primaryId) continue;
    if (entry.retainedUntil !== null && entry.retainedUntil <= now) {
      state.sessions.delete(id);
      changed = true;
    }
  }

  const rebuild = () => {
    const byBare = new Map([...state.sessions.values()].map((entry) => [bareId(entry.id), entry]));
    const children = new Map();
    const roots = [];
    for (const entry of state.sessions.values()) {
      const parentKey = entry.parentId === null ? null : bareId(entry.parentId);
      const parent = parentKey === null ? null : byBare.get(parentKey);
      if (parent && parent.id !== entry.id) {
        if (!children.has(parentKey)) children.set(parentKey, []);
        children.get(parentKey).push(entry);
      } else {
        roots.push(entry);
      }
    }
    return { children, roots };
  };

  const subtreeIds = (root, children) => {
    const ids = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length > 0) {
      const entry = stack.pop();
      const key = bareId(entry.id);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(entry.id);
      for (const child of children.get(key) ?? []) stack.push(child);
    }
    return ids;
  };

  const treeStats = (root, children) => {
    let maxUpdated = 0;
    let protectedTree = false;
    const stack = [root];
    const seen = new Set();
    while (stack.length > 0) {
      const entry = stack.pop();
      const key = bareId(entry.id);
      if (seen.has(key)) continue;
      seen.add(key);
      maxUpdated = Math.max(maxUpdated, entry.updatedAt || 0);
      if (entry.id === state.primaryId || !isIdle(entry)) protectedTree = true;
      for (const child of children.get(key) ?? []) stack.push(child);
    }
    return { maxUpdated, protectedTree };
  };

  let graph = rebuild();
  for (const root of graph.roots) {
    const stats = treeStats(root, graph.children);
    if (stats.protectedTree) continue;
    if (now - stats.maxUpdated <= EVICT_IDLE_MS) continue;
    for (const id of subtreeIds(root, graph.children)) state.sessions.delete(id);
    changed = true;
  }

  if (state.sessions.size > SESSION_MAP_MAX) {
    graph = rebuild();
    const candidates = [];
    for (const root of graph.roots) {
      const stats = treeStats(root, graph.children);
      if (stats.protectedTree) continue;
      candidates.push({ root, stats });
    }
    candidates.sort((a, b) => a.stats.maxUpdated - b.stats.maxUpdated);
    for (const { root } of candidates) {
      if (state.sessions.size <= SESSION_MAP_MAX) break;
      for (const id of subtreeIds(root, graph.children)) state.sessions.delete(id);
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/**
 * 构造快照里"稳定"的那一部分 —— `rev` 就是它的哈希。
 * 只挑**明确列出**的字段：`env` 上多余的键不许渗进来（有条测试专门钉这一点）。
 * 顺序：先按状态权重、再看是否主会话、最后按最近更新倒序，取前 MAX_ENTRIES 条。
 */
export function buildStable(state, env) {
  const list = [...state.sessions.values()];
  list.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const pa = a.id === state.primaryId ? 0 : 1;
    const pb = b.id === state.primaryId ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  return {
    v: PROTOCOL_VERSION,
    runtime: {
      pid: env.pid,
      protocol: PROTOCOL_VERSION,
      port: env.port ?? 0,
      startedAt: env.startedAt ?? 0,
      appExe: env.appExe ?? null,
      appExists: env.appExists === true,
      logFile: env.logFile ?? null,
      settingsError: env.settingsError ?? null,
    },
    config: env.config,
    configSource: env.configSource ?? 'defaults',
    primaryId: state.primaryId,
    entries: list.slice(0, MAX_ENTRIES).map(toDto),
  };
}

function toDto(entry) {
  const stopped = entry.status === 'done' && entry.stopped === true;
  return {
    id: entry.id,
    label: entry.label || shortId(entry.id),
    shortId: shortId(entry.id),
    createdAt: entry.createdAt,
    workspace: entry.workspace,
    workspacePath: entry.workspacePath,
    status: entry.status,
    stopped,
    live: entry.status !== 'idle',
    glow: stopped ? '#E0A800' : STATUS_COLOR[entry.status] || STATUS_COLOR.idle,
    elapsedFrom: entry.elapsedFrom,
    turn: entry.turn,
    step: entry.step,
    toolName: entry.toolName,
    toolCount: entry.toolCount,
    subagentRunning: entry.subagentRunning,
    parentId: entry.parentId,
    isSubagent: entry.isSubagent,
    subagentName: entry.subagentName,
    subagentLabel: entry.subagentLabel,
    subagentState: entry.subagentState,
    retainedUntil: entry.retainedUntil,
    contextTokens: entry.contextTokens,
    contextLimit: entry.contextLimit,
    contextFraction: fraction(entry.contextTokens, entry.contextLimit),
    tokenTotal: entry.tokenTotal,
    tokenInput: entry.tokenInput,
    tokenOutput: entry.tokenOutput,
    tokenCacheRead: entry.tokenCacheRead,
    tokenCacheWrite: entry.tokenCacheWrite,
    todoTotal: entry.todoTotal,
    todoDone: entry.todoDone,
    todoText: entry.todoText,
    todos: entry.todos,
    detailText: entry.detailText,
  };
}

function fraction(tokens, limit) {
  if (typeof tokens !== 'number' || typeof limit !== 'number' || limit <= 0) return null;
  const value = tokens / limit;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

/** 键名排序的 JSON：保证同一个状态永远得到同一个字符串。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function revOf(stable) {
  return fnv1a(stableStringify(stable)).toString(16).padStart(8, '0');
}
