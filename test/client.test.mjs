/**
 * 渲染半边的契约测试。
 *
 * 渲染半边是**手写的浏览器 bundle**（`window.__ModuleLoader__.load(...)`），
 * 它既不能 import 项目里的模块，也没有类型检查。所以它的四类"静默走样"
 * 必须由测试钉住：
 *
 * 1. 协议常量与 `lib/protocol.js` 漂移 → 表现是 app 画不出东西，而不是报错；
 * 2. 类名与 CSS 漂移 → 表现是"设置页看着不太对"，没有任何报错；
 * 3. schema 加了键却没有对应控件 → 用户永远改不了那个键；
 * 4. 跳转没接到 `uiWorkspace.openSession` → 点岛没反应。
 *
 * 这里用 `new Function` 在受控作用域里求值 bundle，模拟 ModuleLoader 的加载方式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../lib/config.js';
import * as P from '../lib/protocol.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');

// ───────────────────────────── 加载器 ─────────────────────────────

/** 假的 react：只需要"顶层的解构不炸"，组件本身不在单测里渲染。 */
const fakeReact = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

function fakeRequire(name) {
  if (name === 'react') return fakeReact;
  // 其它一律抛：bundle 里对 `@deepseek-ai/dsh-client-ui-primitives` 的 require
  // 是 try/catch 包着的（图标拿不到就退化成内置 SVG），所以这里抛是"合法输入"。
  throw new Error(`单测未提供模块：${name}`);
}

/** 求值 bundle，返回它交给 `__ModuleLoader__.load` 的定义。 */
function loadBundle() {
  let definition = null;
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate;
      },
    },
  };
  // eslint-disable-next-line no-new-func -- 就是要按浏览器的加载方式求值
  const run = new Function('window', `${SOURCE}\n`);
  run(window);
  assert.ok(definition !== null, 'bundle 必须调用 window.__ModuleLoader__.load({...})');
  return definition;
}

const definition = loadBundle();
const client = definition.factory(fakeRequire);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

async function waitFor(predicate, { timeout = 4000, step = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

/** 用给定的 fetch 实现跑一段代码，结束后恢复全局。 */
async function withFetch(implementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ───────────────────────── bundle 的形状 ─────────────────────────

test('bundle 以 @dsh-external/dsh-notch-win 注册', () => {
  // id 必须与 package.json 的 name 一致：ModuleLoader 按它挂载/去重。
  assert.equal(definition.id, '@dsh-external/dsh-notch-win');
  assert.equal(typeof definition.factory, 'function');
});

test('导出 apply / inject，且 inject 声明核心服务', () => {
  assert.equal(typeof client.apply, 'function');
  assert.deepEqual(client.inject, ['slots', 'sessions', 'uiWorkspace']);
});

test('求值 bundle 不需要任何未声明的模块', () => {
  // fakeRequire 对未知模块抛错；能走到这里就说明顶层没有别的 require。
  assert.equal(typeof client.createChannel, 'function');
  assert.equal(typeof client.createJumpPoller, 'function');
});

// ───────────────────────── 协议常量 ─────────────────────────

test('协议常量块与 lib/protocol.js 逐项一致（防止漂移）', () => {
  const start = SOURCE.indexOf('// #region 协议常量');
  const end = SOURCE.indexOf('// #endregion');
  assert.ok(start >= 0 && end > start, '找不到协议常量块标记，测试本身失效了');

  const region = SOURCE.slice(start, end);
  // eslint-disable-next-line no-new-func -- 就是为了求值这段常量
  const values = new Function(
    `${region}
     return { PROTOCOL_VERSION, PLUGIN_ID, PORT_BASE, PORT_TRIES, ROUTE, NOTCH_HEADER, NOTCH_HEADER_VALUE,
              STATUS_COLOR, STATE_POLL_ACTIVE_MS, STATE_POLL_IDLE_MS, COMMAND_POLL_MS,
              COMMAND_POLL_BACKOFF_MS, FOCUS_DEBOUNCE_MS };`,
  )();

  assert.equal(values.PROTOCOL_VERSION, P.PROTOCOL_VERSION);
  assert.equal(values.PLUGIN_ID, P.PLUGIN_ID);
  assert.equal(values.PORT_BASE, P.PORT_BASE);
  assert.equal(values.PORT_TRIES, P.PORT_TRIES);
  assert.deepEqual(values.ROUTE, P.ROUTE);
  assert.equal(values.NOTCH_HEADER, P.NOTCH_HEADER);
  assert.equal(values.NOTCH_HEADER_VALUE, P.NOTCH_HEADER_VALUE);
  assert.deepEqual(values.STATUS_COLOR, P.STATUS_COLOR);
  assert.equal(values.STATE_POLL_ACTIVE_MS, P.STATE_POLL_ACTIVE_MS);
  assert.equal(values.STATE_POLL_IDLE_MS, P.STATE_POLL_IDLE_MS);
  assert.equal(values.COMMAND_POLL_MS, P.COMMAND_POLL_MS);
  assert.equal(values.COMMAND_POLL_BACKOFF_MS, P.COMMAND_POLL_BACKOFF_MS);
  assert.equal(values.FOCUS_DEBOUNCE_MS, P.FOCUS_DEBOUNCE_MS);
});

// ───────────────────────── 样式与类名 ─────────────────────────

test('类名表与 CSS 完全对应（两个方向都不许有孤儿）', () => {
  const cssMatch = SOURCE.match(/const CSS = `([\s\S]*?)`;/);
  const mapMatch = SOURCE.match(/const s = \{([\s\S]*?)\n {4}\};/);
  assert.ok(cssMatch !== null, '找不到 CSS 模板字面量');
  assert.ok(mapMatch !== null, '找不到类名表 s');

  const inCss = new Set(cssMatch[1].match(/dshnotch_[A-Za-z0-9]+/g) ?? []);
  const inMap = new Set([...mapMatch[1].matchAll(/\w+:\s*'([^']+)'/g)].map((match) => match[1]));

  assert.ok(inCss.size > 20, `CSS 解析结果太少（${inCss.size}），解析规则可能失效了`);
  assert.deepEqual(
    [...inMap].sort(),
    [...inCss].sort(),
    '类名表与 CSS 不一致：只出现在一边的类名会导致静默无样式',
  );
});

test('颜色只用 --dsw-alias-* 主题令牌（否则明暗主题下会与原生卡片打架）', () => {
  const css = SOURCE.match(/const CSS = `([\s\S]*?)`;/)[1];
  for (const declaration of css.matchAll(/(?:background|color|border-color|border):\s*([^;}]+)/g)) {
    const value = declaration[1];
    const colourish = value.match(/#[0-9a-f]{3,8}|rgb\([^)]*\)|rgba\([^)]*\)|\b(?:white|black|red|blue|green)\b/gi);
    if (colourish === null) continue;
    // 唯一允许的硬编码色是开关滑块的白色圆点（品牌色轨道上必须用白色才两头都清楚）
    assert.deepEqual(
      colourish.map((token) => token.toLowerCase()),
      ['#fff'],
      `发现了硬编码颜色（应改用 --dsw-alias-*）：${declaration[0].trim()}`,
    );
  }
});

// ───────────────────────── 字段覆盖 ─────────────────────────

test('每个配置键都有对应控件（schema 加了键就必须加控件）', () => {
  assert.deepEqual(
    client.FIELDS.map((field) => field.key).sort(),
    Object.keys(DEFAULTS).sort(),
    '配置键与界面控件不一致',
  );
});

test('字段元数据能通过宿主的 schema 校验', async () => {
  const { resolveConfig } = await import('../lib/config.js');
  for (const field of client.FIELDS) {
    if (field.kind === 'switch') {
      assert.equal(resolveConfig({ [field.key]: true })[field.key], true);
      assert.equal(resolveConfig({ [field.key]: false })[field.key], false);
    }
    if (field.kind === 'number') {
      const low = resolveConfig({ [field.key]: field.min })[field.key];
      const high = resolveConfig({ [field.key]: field.max })[field.key];
      assert.equal(low, field.min, `${field.key} 的下界与 schema 不一致`);
      assert.equal(high, field.max, `${field.key} 的上界与 schema 不一致`);
    }
    if (field.kind === 'text') {
      assert.equal(resolveConfig({ [field.key]: 'C:\\x\\y.exe' })[field.key], 'C:\\x\\y.exe');
    }
  }
});

// ───────────────────────── 端口探测 ─────────────────────────

test('探测跳过协议版本对不上的端口（不会误连旧实现的 47311 桥）', async () => {
  await withFetch(
    async (url) => {
      const text = String(url);
      if (text.includes(`:${P.PORT_BASE}`)) return jsonResponse({ ok: true, protocol: 99 });
      if (text.includes(`:${P.PORT_BASE + 1}`)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      throw new TypeError('fetch failed');
    },
    async () => {
      const channel = client.createChannel();
      const found = await channel.probe();
      assert.equal(found.port, P.PORT_BASE + 1);
      assert.equal(channel.connected, true);
      assert.equal(channel.port, P.PORT_BASE + 1);
      assert.equal(channel.base, `http://127.0.0.1:${P.PORT_BASE + 1}`);
    },
  );
});

test('什么都探测不到时如实返回 null，而不是随手连一个', async () => {
  await withFetch(
    async () => {
      throw new TypeError('ECONNREFUSED');
    },
    async () => {
      const channel = client.createChannel();
      assert.equal(await channel.probe(), null);
      assert.equal(channel.connected, false);
      await assert.rejects(() => channel.call(P.ROUTE.state), /尚未连接/);
    },
  );
});

test('未连接时的 call 直接抛，不会打到 127.0.0.1:0', async () => {
  const channel = client.createChannel();
  await assert.rejects(() => channel.call(P.ROUTE.state), /尚未连接/);
});

// ───────────────────────── HTTP 细节 ─────────────────────────

test('写请求带 X-Notch 头（强制预检，服务器据它挡跨站写）', async () => {
  await withFetch(
    async () => jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION }),
    async () => {
      const channel = client.createChannel();
      await channel.probe();

      const seen = [];
      globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), init });
        return jsonResponse({ ok: true });
      };

      await channel.call(P.ROUTE.config, { method: 'POST', body: { patch: { scale: 1.1 } } });
      const [request] = seen;
      assert.equal(request.init.method, 'POST');
      assert.equal(request.init.headers[P.NOTCH_HEADER], P.NOTCH_HEADER_VALUE);
      assert.equal(JSON.parse(request.init.body).patch.scale, 1.1);
    },
  );
});

test('服务端错误码被原样带到调用方（设置页据此显示原因）', async () => {
  await withFetch(
    async (url) =>
      String(url).endsWith(P.ROUTE.health)
        ? jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION })
        : jsonResponse({ ok: false, code: P.ERR.configRejected, message: 'scale 超范围' }, 400),
    async () => {
      const channel = client.createChannel();
      await channel.probe();
      await assert.rejects(
        () => channel.call(P.ROUTE.config, { method: 'POST', body: { patch: { scale: 9 } } }),
        (error) => {
          assert.equal(error.code, P.ERR.configRejected);
          assert.equal(error.status, 400);
          assert.match(error.message, /超范围/);
          return true;
        },
      );
    },
  );
});

// ───────────────────────── 跳转轮询 ─────────────────────────

test('跳转轮询拿到命令后调用 sessions.open，并推进游标不重复投递', async () => {
  const opened = [];
  await withFetch(
    async (url) => {
      const text = String(url);
      if (text.endsWith(P.ROUTE.health)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      if (text.includes(P.ROUTE.commands)) {
        return jsonResponse({ seq: 7, jumps: [{ seq: 7, sessionId: 'session-abc' }] });
      }
      throw new TypeError(`未预期的请求 ${text}`);
    },
    async () => {
      const channel = client.createChannel();
      const poller = client.createJumpPoller({
        channel,
        open: (sessionId) => {
          opened.push(sessionId);
          return true;
        },
        pollMs: 10_000,
        backoffMs: 10_000,
      });

      poller.start();
      await waitFor(() => opened.length > 0);
      // 游标已经推到 7：下一次轮询只会请求 since=7，服务端不会再回这条命令。
      assert.deepEqual(opened, ['session-abc']);
      assert.equal(poller.state.seq, 7);
      assert.equal(poller.state.jumped, 1);
      assert.equal(poller.state.failed, 0);
      poller.stop();
    },
  );
});

test('跳转执行失败只记录，不抛出、不中断轮询', async () => {
  await withFetch(
    async (url) =>
      String(url).endsWith(P.ROUTE.health)
        ? jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION })
        : jsonResponse({ seq: 1, jumps: [{ seq: 1, sessionId: 'session-gone' }] }),
    async () => {
      const channel = client.createChannel();
      const poller = client.createJumpPoller({
        channel,
        open: () => {
          throw new Error('会话已不存在');
        },
        pollMs: 10_000,
        backoffMs: 10_000,
      });
      poller.start();
      await waitFor(() => poller.state.lastError !== null);
      assert.match(poller.state.lastError, /session-gone/);
      assert.equal(poller.state.jumped, 0);
      poller.stop();
    },
  );
});

test('宿主消失后重新探测端口（网络层错误才会断开）', async () => {
  let commands = 0;
  const opened = [];
  await withFetch(
    async (url) => {
      const text = String(url);
      if (text.endsWith(P.ROUTE.health)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      commands += 1;
      if (commands === 1) throw new TypeError('socket hang up');
      return jsonResponse({ seq: 2, jumps: [{ seq: 2, sessionId: 'session-back' }] });
    },
    async () => {
      const channel = client.createChannel();
      const poller = client.createJumpPoller({
        channel,
        open: (sessionId) => {
          opened.push(sessionId);
          return true;
        },
        pollMs: 10,
        backoffMs: 10,
      });
      poller.start();
      await waitFor(() => opened.length > 0);
      assert.deepEqual(opened, ['session-back']);
      assert.equal(poller.state.probes >= 2, true, '断开后必须重新探测');
      poller.stop();
    },
  );
});

test('stop() 之后不再发请求', async () => {
  let requests = 0;
  await withFetch(
    async () => {
      requests += 1;
      return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
    },
    async () => {
      const channel = client.createChannel();
      const poller = client.createJumpPoller({
        channel,
        open: () => true,
        pollMs: 10,
        backoffMs: 10,
      });
      poller.start();
      await waitFor(() => requests > 0);
      poller.stop();
      const settled = requests;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(requests, settled, 'stop() 之后还有请求在跑');
    },
  );
});

// ───────────────────────── 焦点上报 ─────────────────────────

test('焦点上报：会话切换后去抖上报一次', async () => {
  const posted = [];
  await withFetch(
    async (url, init) => {
      const text = String(url);
      if (text.endsWith(P.ROUTE.health)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      posted.push({ url: text, body: init && init.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true });
    },
    async () => {
      let current = 'session-one';
      const listeners = new Set();
      const ctx = {
        sessions: {
          list: {
            getSnapshot: () => ({ current }),
            subscribe(fn) {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
          },
        },
      };

      const channel = client.createChannel();
      await channel.probe();

      const reporter = client.createFocusReporter({ ctx, channel, debounceMs: 5 });
      assert.equal(reporter.supported, true);

      // 连续切两次：只有最后一次该被上报（去抖）
      current = 'session-two';
      for (const fn of listeners) fn();
      current = 'session-three';
      for (const fn of listeners) fn();

      await waitFor(() => posted.length > 0);
      assert.equal(posted.length, 1);
      assert.equal(posted[0].url, `http://127.0.0.1:${P.PORT_BASE}${P.ROUTE.focus}`);
      assert.deepEqual(posted[0].body, { sessionId: 'session-three' });

      reporter.stop();
    },
  );
});

test('焦点上报：插件加载时主动补报当前会话，不等用户再切一次', async () => {
  const posted = [];
  await withFetch(
    async (url, init) => {
      const text = String(url);
      if (text.endsWith(P.ROUTE.health)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      posted.push({ url: text, body: init && init.body ? JSON.parse(init.body) : null });
      return jsonResponse({ ok: true });
    },
    async () => {
      const ctx = {
        sessions: {
          list: {
            getSnapshot: () => ({ current: 'session-current' }),
            subscribe() {
              return () => {};
            },
          },
        },
      };

      const channel = client.createChannel();
      await channel.probe();

      const reporter = client.createFocusReporter({ ctx, channel, debounceMs: 5 });
      await waitFor(() => posted.length > 0);
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0].body, { sessionId: 'session-current' });
      reporter.stop();
    },
  );
});

test('没有 sessions 服务时焦点上报安静降级', () => {
  const reporter = client.createFocusReporter({ ctx: {}, channel: client.createChannel() });
  assert.equal(reporter.supported, false);
  reporter.stop(); // 不该抛
});

// ───────────────────────── apply 接线 ─────────────────────────

test('apply 注册设置页 tab 并挂上跳转轮询（卸载时收手）', async () => {
  const injections = [];
  const registrations = [];
  const cleanups = [];
  const opened = [];

  const ctx = {
    slots: {
      inject(name, callback) {
        injections.push(name);
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    uiWorkspace: {
      openSession: (sessionId) => opened.push(sessionId),
    },
    sessions: {
      list: null,
    },
    effect(callback) {
      const cleanup = callback();
      cleanups.push(cleanup);
      return () => {};
    },
  };

  await withFetch(
    async (url) => {
      const text = String(url);
      if (text.endsWith(P.ROUTE.health)) return jsonResponse({ ok: true, protocol: P.PROTOCOL_VERSION });
      if (text.includes(P.ROUTE.commands)) {
        return jsonResponse({ seq: 1, jumps: [{ seq: 1, sessionId: 'session-jump' }] });
      }
      return jsonResponse({ ok: true });
    },
    async () => {
      client.apply(ctx);

      assert.deepEqual(injections, ['settings.plugins.tab']);
      assert.equal(registrations.length, 1);
      const options = registrations[0].options;
      assert.equal(options.name, 'settings.plugins.tab');
      assert.equal(options.id, P.PLUGIN_ID);
      assert.equal(typeof options.order, 'number');
      assert.equal(typeof options.label, 'string');
      assert.ok(options.label.length > 0, 'tab 没有 label 就会是一个无名标签');
      // 复用 DSH 自带 tab 的 id 会替换掉它，而不是并列一个 —— 必须自查。
      assert.ok(
        !['all', 'configurable'].includes(options.id),
        'tab id 与 DSH 自带的 tab 撞车了（会替换掉它）',
      );
      assert.equal(typeof registrations[0].component, 'function', 'tab 必须给一个组件');

      // 端到端：宿主队列里的跳转最终落到 uiWorkspace.openSession
      await waitFor(() => opened.length > 0);
      assert.deepEqual(opened, ['session-jump']);

      assert.equal(cleanups.length, 1);
      assert.equal(typeof cleanups[0], 'function');
      cleanups[0]();
    },
  );
});

test('apply 在没有 slots 的环境里也能跑完（只是不注册设置页）', () => {
  const cleanups = [];
  const ctx = {
    sessions: { open: () => {}, list: null },
    effect(callback) {
      cleanups.push(callback());
      return () => {};
    },
  };
  assert.doesNotThrow(() => client.apply(ctx));
  assert.equal(cleanups.length, 1);
  if (typeof cleanups[0] === 'function') cleanups[0]();
});
