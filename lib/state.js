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
const WORKSPACE_MAX = 32;
const PATH_MAX = 260;
const ARG_PARSE_MAX = 4096;
const HINT_MAX = 80;

/** `onMeta` 接收的累计 token 字段（值都是整数 token 数）。 */
const TOKEN_KEYS = ['tokenTotal', 'tokenInput', 'tokenOutput', 'tokenCacheRead', 'tokenCacheWrite'];

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
  entry = {
    id,
    label: null,
    /** 标题来源：`title`（DSH 会话标题）> `message`（首条用户消息）> `cwd`（工作目录名）> null。 */
    labelSource: null,
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
    detailText: null,
    lastSeq: -1,
    updatedAt: 0,
    /** done 状态下是否是用户主动停止（turn/end reason.kind === 'aborted'）。 */
    stopped: false,
  };
  state.sessions.set(id, entry);
  return entry;
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
      return onDisposed(state, input);
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

function onDisposed(state, input) {
  const id = String(input.agentId ?? '');
  if (id === '' || !state.sessions.has(id)) return false;
  state.sessions.delete(id);
  if (state.primaryId === id) state.primaryId = null;
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

  // 焦点会话可能还没有任何事件（插件启动前就存在的空闲会话）。先建条目，
  // 否则 primaryId 指向一个不在 entries 里的 id，岛会回落到第一条旧会话。
  if (next !== null && !state.sessions.has(next)) {
    const entry = ensure(state, next);
    entry.updatedAt = now;
    changed = true;
  }

  if (state.primaryId === next) return changed;
  state.primaryId = next;
  return true;
}

function onAck(state, input, now) {
  const id = String(input.sessionId ?? '');
  if (id === '') return false;
  const entry = state.sessions.get(id);
  if (!entry || entry.status !== 'done') return false;

  entry.status = 'idle';
  entry.stopped = false;
  entry.elapsedFrom = null;
  entry.toolName = null;
  entry.inFlight.clear();
  entry.updatedAt = now;
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
      const todos = Array.isArray(data.todos) ? data.todos : [];
      entry.todoTotal = todos.length;
      entry.todoDone = todos.filter((t) => t && t.status === 'completed').length;
      const active =
        todos.find((t) => t && t.status === 'in_progress') ||
        todos.find((t) => t && t.status === 'pending');
      entry.todoText = active ? clip(active.content, DETAIL_MAX) : null;
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
      break;
    }
    case 'user/message': {
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

  for (const [id, entry] of state.sessions) {
    if (id === state.primaryId) continue;
    if (!isIdle(entry)) continue;
    if (now - entry.updatedAt <= EVICT_IDLE_MS) continue;
    state.sessions.delete(id);
    changed = true;
  }

  if (state.sessions.size > SESSION_MAP_MAX) {
    const idle = [...state.sessions.values()]
      .filter((entry) => isIdle(entry) && entry.id !== state.primaryId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of idle) {
      if (state.sessions.size <= SESSION_MAP_MAX) break;
      state.sessions.delete(entry.id);
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
