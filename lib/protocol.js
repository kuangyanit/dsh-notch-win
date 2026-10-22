/**
 * @module @dsh-external/dsh-notch-win/protocol
 *
 * 协议常量：宿主半边 / 渲染半边 / 岛 app 三方共用的唯一出处。
 *
 * ⚠️ 本文件刻意**只**包含 `export const NAME = <字面量>;` 形式的声明。
 * `scripts/gen-app-protocol.mjs` 靠这条约束把本文件机械转换成
 * `app/src/protocol.cjs`（Electron 主进程是 CJS，不能直接 import ESM）。
 * 请不要在这里写函数、class、import 或任何有副作用的语句 —— 生成器会静默
 * 漏掉它们，而 `test/protocol.test.mjs` 会因此失败。
 */

export const PROTOCOL_VERSION = 1;

/** 插件版本。必须与 package.json / dsh.plugin.json 的 version 一致（test/protocol.test.mjs 会断言）。 */
export const PLUGIN_VERSION = '0.1.0';

/**
 * 插件 id：同时用作 settings namespace 与 app 数据目录名。
 * 刻意只保留一套命名 —— 早期版本里插件名、app 名、端点文件与配置文件名
 * 互不相同，是排查困难的来源之一。
 */
export const PLUGIN_ID = 'dsh-notch-win';

/** 岛 app 的可执行文件名。 */
export const APP_EXE_NAME = 'DSHNotch.exe';

/** 回环 HTTP 端口段：47411 起顺延。与旧实现的 47311 刻意错开，避免互相撞。 */
export const PORT_BASE = 47411;
export const PORT_TRIES = 12;

/** 端点文件名：`endpoint-<pid>.json`。每实例一份，**永不复用别人的端口**。 */
export const ENDPOINT_PREFIX = 'endpoint-';
export const ENDPOINT_SUFFIX = '.json';

export const ROUTE = {
  health: '/v1/health',
  state: '/v1/state',
  jump: '/v1/jump',
  commands: '/v1/commands',
  config: '/v1/config',
  focus: '/v1/focus',
  ack: '/v1/ack',
};

/** 会改状态的路由：必须带 `X-Notch` 头（强制预检，挡住跨站写入）。 */
export const MUTATING_ROUTES = [ROUTE.jump, ROUTE.config, ROUTE.focus, ROUTE.ack];

export const NOTCH_HEADER = 'x-notch';
export const NOTCH_HEADER_VALUE = '1';

/** 岛的状态取值：4 值。`waiting`（等待用户确认）已被刻意移除，见 DESIGN.md §9.3。 */
export const STATUS = {
  idle: 'idle',
  thinking: 'thinking',
  tool: 'tool',
  done: 'done',
};

/** 状态色。app 只消费，不重新解释语义。 */
export const STATUS_COLOR = {
  idle: '#6B7280',
  thinking: '#4E7CFF',
  tool: '#22C55E',
  done: '#8B5CF6',
};

/** 排序权重：小的排前面。0=正在干活，1=刚干完，2=空闲。 */
export const STATUS_RANK = {
  thinking: 0,
  tool: 0,
  done: 1,
  idle: 2,
};

/** HUD 一次最多发送的条目数。与 SESSION_MAP_MAX 对齐，避免截断出“半棵树”。 */
export const MAX_ENTRIES = 64;
export const DONE_HOLD_MS = 6000;
export const PUBLISH_THROTTLE_MS = 150;
export const DETAIL_MAX = 120;
export const EVICT_IDLE_MS = 600000;
export const SESSION_MAP_MAX = 64;

export const JUMP_RING_CAP = 32;
export const JUMP_TTL_MS = 45000;
export const JUMP_DEDUPE_MS = 500;

export const STATE_POLL_ACTIVE_MS = 250;
export const STATE_POLL_IDLE_MS = 1000;
export const COMMAND_POLL_MS = 500;
export const COMMAND_POLL_BACKOFF_MS = 3000;
export const FOCUS_DEBOUNCE_MS = 300;

/** 只绑回环。 */
export const LISTEN_HOST = '127.0.0.1';

/** Host 栅栏白名单（去端口后比较）。这是挡 DNS rebinding 的唯一有效手段。 */
export const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

export const ERR = {
  badJson: 'bad-json',
  badRequest: 'bad-request',
  forbiddenHost: 'forbidden-host',
  forbiddenOrigin: 'forbidden-origin',
  unknownRoute: 'unknown-route',
  configRejected: 'config-rejected',
  /** 功能被配置关掉了（例如 jumpEnabled=false）—— 与"请求畸形"区分开。 */
  featureDisabled: 'feature-disabled',
  tooLarge: 'too-large',
};

export const MAX_BODY_BYTES = 65536;
