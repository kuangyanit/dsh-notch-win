/**
 * ⚠️ 本文件由 `npm run gen-protocol` 从 `lib/protocol.js` **生成**，请不要手改。
 * `test/protocol.test.mjs` 会断言它没有过期。
 *
 * 生成原因：Electron 主进程是 CJS，不能直接 import ESM 的 `lib/protocol.js`。
 * 两者必须逐字等价，因此用机械变换而不是手抄。
 */
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

const PROTOCOL_VERSION = exports.PROTOCOL_VERSION = 1;

/** 插件版本。必须与 package.json / dsh.plugin.json 的 version 一致（test/protocol.test.mjs 会断言）。 */
const PLUGIN_VERSION = exports.PLUGIN_VERSION = '0.1.0';

/**
 * 插件 id：同时用作 settings namespace 与 app 数据目录名。
 * 刻意只保留一套命名 —— 早期版本里插件名、app 名、端点文件与配置文件名
 * 互不相同，是排查困难的来源之一。
 */
const PLUGIN_ID = exports.PLUGIN_ID = 'dsh-notch-win';

/** 岛 app 的可执行文件名。 */
const APP_EXE_NAME = exports.APP_EXE_NAME = 'DSHNotch.exe';

/** 回环 HTTP 端口段：47411 起顺延。与旧实现的 47311 刻意错开，避免互相撞。 */
const PORT_BASE = exports.PORT_BASE = 47411;
const PORT_TRIES = exports.PORT_TRIES = 12;

/** 端点文件名：`endpoint-<pid>.json`。每实例一份，**永不复用别人的端口**。 */
const ENDPOINT_PREFIX = exports.ENDPOINT_PREFIX = 'endpoint-';
const ENDPOINT_SUFFIX = exports.ENDPOINT_SUFFIX = '.json';

const ROUTE = exports.ROUTE = {
  health: '/v1/health',
  state: '/v1/state',
  jump: '/v1/jump',
  commands: '/v1/commands',
  config: '/v1/config',
  focus: '/v1/focus',
  ack: '/v1/ack',
};

/** 会改状态的路由：必须带 `X-Notch` 头（强制预检，挡住跨站写入）。 */
const MUTATING_ROUTES = exports.MUTATING_ROUTES = [ROUTE.jump, ROUTE.config, ROUTE.focus, ROUTE.ack];

const NOTCH_HEADER = exports.NOTCH_HEADER = 'x-notch';
const NOTCH_HEADER_VALUE = exports.NOTCH_HEADER_VALUE = '1';

/** 岛的状态取值：4 值。`waiting`（等待用户确认）已被刻意移除，见 DESIGN.md §9.3。 */
const STATUS = exports.STATUS = {
  idle: 'idle',
  thinking: 'thinking',
  tool: 'tool',
  done: 'done',
};

/** 状态色。app 只消费，不重新解释语义。 */
const STATUS_COLOR = exports.STATUS_COLOR = {
  idle: '#6B7280',
  thinking: '#4E7CFF',
  tool: '#22C55E',
  done: '#8B5CF6',
};

/** 排序权重：小的排前面。0=正在干活，1=刚干完，2=空闲。 */
const STATUS_RANK = exports.STATUS_RANK = {
  thinking: 0,
  tool: 0,
  done: 1,
  idle: 2,
};

/** HUD 一次最多发送的条目数。与 SESSION_MAP_MAX 对齐，避免截断出“半棵树”。 */
const MAX_ENTRIES = exports.MAX_ENTRIES = 64;
const DONE_HOLD_MS = exports.DONE_HOLD_MS = 6000;
const PUBLISH_THROTTLE_MS = exports.PUBLISH_THROTTLE_MS = 150;
const DETAIL_MAX = exports.DETAIL_MAX = 120;
const EVICT_IDLE_MS = exports.EVICT_IDLE_MS = 600000;
const SESSION_MAP_MAX = exports.SESSION_MAP_MAX = 64;

const JUMP_RING_CAP = exports.JUMP_RING_CAP = 32;
const JUMP_TTL_MS = exports.JUMP_TTL_MS = 45000;
const JUMP_DEDUPE_MS = exports.JUMP_DEDUPE_MS = 500;

const STATE_POLL_ACTIVE_MS = exports.STATE_POLL_ACTIVE_MS = 250;
const STATE_POLL_IDLE_MS = exports.STATE_POLL_IDLE_MS = 1000;
const COMMAND_POLL_MS = exports.COMMAND_POLL_MS = 500;
const COMMAND_POLL_BACKOFF_MS = exports.COMMAND_POLL_BACKOFF_MS = 3000;
const FOCUS_DEBOUNCE_MS = exports.FOCUS_DEBOUNCE_MS = 300;

/** 只绑回环。 */
const LISTEN_HOST = exports.LISTEN_HOST = '127.0.0.1';

/** Host 栅栏白名单（去端口后比较）。这是挡 DNS rebinding 的唯一有效手段。 */
const ALLOWED_HOSTS = exports.ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

const ERR = exports.ERR = {
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

const MAX_BODY_BYTES = exports.MAX_BODY_BYTES = 65536;
