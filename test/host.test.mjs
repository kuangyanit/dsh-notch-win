/**
 * 宿主半边的**端到端**测试：用假的 cordis ctx 跑 `lib/index.js`，然后走真的
 * 回环 HTTP 读状态、写配置、发跳转。
 *
 * 这是 P1/P2 的集成验收：单测覆盖状态机与 HTTP 各自的内部逻辑，这里覆盖的是
 * 「接线」—— 订阅是否挂上、采纳扫描是否跑、端点文件是否写、`ctx.inject` 的
 * settings 注册路径是否真的走通、卸载是否收干净。
 *
 * ## 它跑的是真实的 `apply()`，所以必须被关进笼子
 *
 * 数据目录用 `DSH_NOTCH_DATA_DIR` 指到系统临时目录，`DSH_NOTCH_NO_LAUNCH=1`
 * 让它不要真的拉起岛 app 窗口。**这两条都不是可选的**：早先没隔离时，测试会把
 * 诊断日志写进用户真实的 `%LOCALAPPDATA%\dsh-notch-win\host.log`，里面还留着
 * `DSH_NOTCH_NO_LAUNCH=1，跳过拉起岛 app` 这种一看就像真实行为的行 ——
 * 于是"为什么默认不拉起岛"成了完全合理的误解（它就是被这么问出来的）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import * as P from '../lib/protocol.js';
import { apply, name as pluginName } from '../lib/index.js';
import { dataDir, endpointFilePath } from '../lib/paths.js';

// 必须在任何 test() 之前设置。（这些值都是惰性读的，所以 import 顺序无所谓。）
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-host-test-'));
process.env.DSH_NOTCH_DATA_DIR = SANDBOX;
process.env.DSH_NOTCH_NO_LAUNCH = '1';

// 兜底：万一将来有人把 DSH_NOTCH_DATA_DIR 的支持从 paths.js 里删掉，
// 这条会立刻红，而不是又悄悄去写用户真实的 host.log。
assert.equal(
  dataDir(),
  path.resolve(SANDBOX),
  'host.test.mjs 没有把数据目录关进临时目录 —— 它会去写用户真实的 %LOCALAPPDATA%\\dsh-notch-win',
);

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await wait(step);
  }
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 把 settings 服务做成一个可记录调用的假实现。 */
function fakeSettings() {
  const registrations = [];
  let value = {};
  const watchers = new Set();

  const service = {
    documentPath: 'C:\\fake\\settings.yaml',
    register(namespace, schema, options) {
      registrations.push({ namespace, schema, options });
      return {
        get: () => value,
        watch(fn) {
          watchers.add(fn);
          return () => watchers.delete(fn);
        },
        async update(patch) {
          value = { ...value, ...patch };
          for (const fn of watchers) fn(value, value);
        },
      };
    },
  };

  return {
    service,
    registrations,
    stored: () => value,
  };
}

function fakeContext({ agents = [], sessions = [], settings = null, projections = null } = {}) {
  const listeners = new Map();
  const disposers = [];
  const injections = [];

  // cordis 的 `ctx.effect(cb)` **立即执行** cb，并把它的返回值当作清理函数。
  // 必须照这个语义建模，否则「起服务器」这段根本不会跑。
  const effect = (callback) => {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return () => {};
  };

  const context = {
    // 真 cordis 4.0.5 的 `ctx.get(name)` 是“无 inject 读取服务”的官方入口；
    // 这里的假 ctx 也照这个语义实现（sweep/enrich 依赖它，而不是 ctx.agents 属性）。
    get(name) {
      if (name === 'agents') return context.agents;
      if (name === 'sessions') return context.sessions;
      if (name === 'settings') return settings ? settings.service : undefined;
      if (name === 'sessionProjections') return projections ?? undefined;
      return undefined;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {};
    },
    inject(names, callback) {
      injections.push(names.join(','));
      if (settings && names.includes('settings')) {
        callback({ settings: settings.service, effect });
      }
    },
    effect,
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
    },
    sessions: {
      list: () => sessions,
    },
  };

  return {
    context,
    injections,
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    emit(event, ...args) {
      // 同步派发：和 DSH 的 emit 模式一致，也顺带验证处理器是同步且不抛的。
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer();
      disposers.length = 0;
    },
  };
}

/** 起一个真的宿主实例；返回控制句柄。 */
async function startHost({ agents = [], sessions = [], settings = null, projections = null, config = {} } = {}) {
  const fake = fakeContext({ agents, sessions, settings, projections });
  apply(fake.context, config);

  const file = endpointFilePath(process.pid);
  const endpoint = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  });

  const teardown = () => fake.dispose();

  return { fake, endpoint, port: endpoint.port, file, teardown };
}

test('插件导出名与 id 一致，apply 是函数', () => {
  assert.equal(pluginName, '@dsh-external/dsh-notch-win');
  assert.equal(typeof apply, 'function');
});

test('启动会写端点文件、监听回环端口、注册 settings', async (t) => {
  const settings = fakeSettings();
  const host = await startHost({ settings });
  t.after(host.teardown);

  assert.equal(host.endpoint.protocol, P.PROTOCOL_VERSION);
  assert.equal(host.endpoint.pid, process.pid);
  assert.ok(host.endpoint.port >= P.PORT_BASE, `端口应是 47411 段，实际 ${host.endpoint.port}`);
  assert.ok(fs.existsSync(host.file), '端点文件应存在');

  const health = await request(host.port, 'GET', P.ROUTE.health);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.pid, process.pid);
  assert.equal(health.body.settings, 'settings', 'settings 已可用时不能报 unavailable');

  // settings 注册：namespace 正确、base 来自 cordis 条目配置
  assert.equal(settings.registrations.length, 1);
  assert.equal(String(settings.registrations[0].namespace), P.PLUGIN_ID);
  assert.deepEqual(settings.registrations[0].options, { base: {} });
});

test('真事件流会在 HTTP 上看到对应的条目', async (t) => {
  const host = await startHost();
  t.after(host.teardown);

  // 1. 采纳扫描之后到来的 agent 状态
  host.fake.emit('agent/status', { agent: { id: 'session-agent01' }, status: 'running' });

  // 2. 会话事件（注意负载在 event.data 下）
  host.fake.emit('session/event', { id: 'session-agent01' }, {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: [{ type: 'text', text: '修一下设置页' }] },
  });
  host.fake.emit('session/event', { id: 'session-agent01' }, {
    type: 'tool/call',
    seq: 2,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' },
  });

  const state = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    return res.body.entries?.length ? res.body : null;
  });

  const [entry] = state.entries;
  assert.equal(entry.id, 'session-agent01');
  assert.equal(entry.shortId, 'agent01');
  assert.equal(entry.label, '修一下设置页', '首条用户消息成为标题');
  assert.equal(entry.status, 'tool');
  assert.equal(entry.toolName, 'bash');
  assert.equal(entry.detailText, 'bash · npm test');
  assert.equal(entry.live, true);
  assert.ok(state.runtime.pid === process.pid);
  assert.ok(state.runtime.port === host.port);
  assert.equal(state.serverNow, undefined, '宿主与岛同一台机器同一个时钟：不发多余的时间字段');

  // rev 短路：把 rev 带回来应该只拿到 unchanged
  const same = await request(host.port, 'GET', `${P.ROUTE.state}?rev=${state.rev}`);
  assert.deepEqual(same.body, { unchanged: true, rev: state.rev });

  // agent 结束 → done
  host.fake.emit('agent/status', { agent: { id: 'session-agent01' }, status: 'idle' });
  const done = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    return res.body.entries?.[0]?.status === 'done' ? res.body : null;
  });
  assert.equal(done.entries[0].live, true, 'done 的微光期仍算 live');
});

test('采纳扫描会把加载时就存在的 agent 收进来', async (t) => {
  const host = await startHost({
    agents: [
      { id: 'session-running1', status: 'running' },
      { id: 'session-idleone2', status: 'idle' },
    ],
  });
  t.after(host.teardown);

  const state = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    return res.body.entries?.length >= 2 ? res.body : null;
  });

  const running = state.entries.find((entry) => entry.id === 'session-running1');
  const idle = state.entries.find((entry) => entry.id === 'session-idleone2');
  assert.equal(running.status, 'thinking');
  assert.equal(running.live, true);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.live, false);
  assert.equal(state.entries[0].id, 'session-running1', '正在执行的排前面');
});

test('子代理计数与 cwd 兜底标题来自 ctx.sessions', async (t) => {
  const host = await startHost({
    agents: [
      { id: 'session-parent', status: 'running' },
      { id: 'session-child', status: 'running' },
    ],
    sessions: [
      { id: 'session-parent', header: { id: 'session-parent', createdAt: 0, cwd: 'D:\\work\\demo' } },
      {
        id: 'session-child',
        header: { id: 'session-child', createdAt: 0, origin: 'subagent', parentSession: 'session-parent' },
      },
    ],
  });
  t.after(host.teardown);

  const state = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    const parent = res.body.entries?.find((entry) => entry.id === 'session-parent');
    return parent?.subagentRunning === 1 && parent.label === 'demo' ? res.body : null;
  });

  const parent = state.entries.find((entry) => entry.id === 'session-parent');
  assert.equal(parent.subagentRunning, 1);
  assert.equal(parent.label, 'demo', '没有用户消息时用 cwd 名兜底');
});

test('累计 token 主数字含缓存读写，工作区来自 cwd 末段', async (t) => {
  const projections = {
    snapshot: () => ({
      values: {
        tokenUsage: {
          uncachedInputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 2000,
          cacheWriteTokens: 300,
        },
      },
    }),
  };
  const host = await startHost({
    agents: [{ id: 'session-token01', status: 'running' }],
    sessions: [{ id: 'session-token01', header: { cwd: 'D:\\work\\demo' } }],
    projections,
  });
  t.after(host.teardown);

  const state = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    const entry = res.body.entries?.find((item) => item.id === 'session-token01');
    return entry?.tokenTotal === 3800 ? res.body : null;
  });

  const entry = state.entries.find((item) => item.id === 'session-token01');
  assert.equal(entry.tokenTotal, 3800, '未缓存输入 + 输出 + 缓存读 + 缓存写');
  assert.equal(entry.tokenInput, 1000);
  assert.equal(entry.tokenOutput, 500);
  assert.equal(entry.tokenCacheRead, 2000);
  assert.equal(entry.tokenCacheWrite, 300);
  assert.equal(entry.workspace, 'demo');
  assert.equal(entry.workspacePath, 'D:\\work\\demo');
});

test('配置写入走 settings，并出现在状态与 commands 里', async (t) => {
  const settings = fakeSettings();
  const host = await startHost({ settings });
  t.after(host.teardown);

  const headers = { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE };
  const res = await request(host.port, 'POST', P.ROUTE.config, {
    body: { patch: { hideWhenIdle: true, junk: 'drop-me' } },
    headers,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.configSource, 'settings');
  assert.equal(res.body.config.hideWhenIdle, true);
  assert.deepEqual(settings.stored(), { hideWhenIdle: true }, '脏键不落盘');

  const commands = await request(host.port, 'GET', P.ROUTE.commands);
  assert.equal(commands.body.config.hideWhenIdle, true);
  assert.equal(commands.body.configSource, 'settings');

  const state = await request(host.port, 'GET', P.ROUTE.state);
  assert.equal(state.body.config.hideWhenIdle, true);
  assert.equal(state.body.config.scale, 1, '未提供的键保持默认');
});

test('非法配置是 400，而不是把坏值写进 settings.yaml', async (t) => {
  const settings = fakeSettings();
  const host = await startHost({ settings });
  t.after(host.teardown);

  const res = await request(host.port, 'POST', P.ROUTE.config, {
    body: { patch: { scale: 9 } },
    headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, P.ERR.configRejected);
  assert.deepEqual(settings.stored(), {});
});

test('跳转：app POST 入队，渲染半边从 commands 取走', async (t) => {
  const host = await startHost();
  t.after(host.teardown);

  const headers = { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE };

  // 渲染半边先问一次基线
  const base = await request(host.port, 'GET', P.ROUTE.commands);
  assert.equal(base.body.seq, 0);
  assert.deepEqual(base.body.jumps, []);

  const jump = await request(host.port, 'POST', P.ROUTE.jump, {
    body: { sessionId: 'session-jumpme1' },
    headers,
  });
  assert.equal(jump.status, 200);
  assert.equal(jump.body.seq, 1);

  const after = await request(host.port, 'GET', `${P.ROUTE.commands}?since=${base.body.seq}`);
  assert.equal(after.body.seq, 1);
  assert.deepEqual(after.body.jumps, [{ seq: 1, sessionId: 'session-jumpme1' }]);

  // 同一个会话的重复点击在 500ms 内去重（不会连按刷出一串）
  const again = await request(host.port, 'POST', P.ROUTE.jump, {
    body: { sessionId: 'session-jumpme1' },
    headers,
  });
  assert.equal(again.body.seq, 1, '去重：不复用新的 seq');

  // 缺少 sessionId 是 400
  const bad = await request(host.port, 'POST', P.ROUTE.jump, { body: {}, headers });
  assert.equal(bad.status, 400);
});

test('关闭跳转开关后，跳转请求被拒', async (t) => {
  const settings = fakeSettings();
  const host = await startHost({ settings });
  t.after(host.teardown);

  const headers = { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE };
  await request(host.port, 'POST', P.ROUTE.config, { body: { patch: { jumpEnabled: false } }, headers });

  const jump = await request(host.port, 'POST', P.ROUTE.jump, {
    body: { sessionId: 'session-x1' },
    headers,
  });
  assert.equal(jump.status, 409);
  assert.equal(jump.body.code, P.ERR.featureDisabled);
});

test('focus 会把该会话顶到主位', async (t) => {
  const host = await startHost({
    agents: [
      { id: 'session-aaa', status: 'running' },
      { id: 'session-bbb', status: 'running' },
    ],
  });
  t.after(host.teardown);

  await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    return res.body.entries?.length >= 2;
  });

  await request(host.port, 'POST', P.ROUTE.focus, {
    body: { sessionId: 'session-bbb' },
    headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
  });

  const state = await waitFor(async () => {
    const res = await request(host.port, 'GET', P.ROUTE.state);
    return res.body.primaryId === 'session-bbb' ? res.body : null;
  });
  assert.equal(state.entries[0].id, 'session-bbb', '主会话排最前');
});

test('卸载会删掉端点文件并关掉端口', async () => {
  const host = await startHost();
  assert.ok(fs.existsSync(host.file));

  // 模拟 cordis 卸载（调用 effect 的清理函数），再确认服务真的没了
  await host.fake.dispose();
  await waitFor(() => !fs.existsSync(host.file), { timeout: 3000 });

  await waitFor(async () => {
    try {
      await request(host.port, 'GET', P.ROUTE.health);
      return false;
    } catch {
      return true;
    }
  }, { timeout: 3000 });
});

test('settings 缺席时插件照常工作，只把配置降级为内存态', async (t) => {
  const host = await startHost(); // settings = null
  t.after(host.teardown);

  const health = await request(host.port, 'GET', P.ROUTE.health);
  assert.equal(health.status, 200);
  assert.equal(health.body.settings, 'unavailable');

  const res = await request(host.port, 'POST', P.ROUTE.config, {
    body: { patch: { scale: 1.1 } },
    headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.configSource, 'memory', '要如实告诉设置页"不可持久化"');
  assert.equal(res.body.config.scale, 1.1);

  // 但这必须是非致命的：状态读取不受影响
  const state = await request(host.port, 'GET', P.ROUTE.state);
  assert.equal(state.status, 200);
  assert.equal(state.body.configSource, 'memory');
});

test('DSH 0.2.x：settings 服务没有 register 时插件照常加载，配置来自 apply 第二参数', async (t) => {
  // 0.2.x 的 settings 服务是 SettingsForms：只有 configure/update，没有 register，
  // 表单由 DSH 依据导出的 Config 自动生成。宿主仍在 apply 时把配置交进来。
  const settings02 = { service: { documentPath: 'C:\\fake\\cordis.patch.yml' } };
  const host = await startHost({
    settings: settings02,
    config: { scale: 1.2, autoLaunchApp: false },
  });
  t.after(host.teardown);

  const health = await request(host.port, 'GET', P.ROUTE.health);
  assert.equal(health.status, 200);
  assert.equal(health.body.settings, 'settings', '配置来自 profile 条目时不能报告 unavailable');

  const state = await request(host.port, 'GET', P.ROUTE.state);
  assert.equal(state.body.config.scale, 1.2);
  assert.equal(state.body.config.autoLaunchApp, false);
});

test('数据目录默认是 %LOCALAPPDATA%\\dsh-notch-win，端点文件带 pid', () => {
  // 本文件整体把数据目录指到了临时目录（见文件顶部），所以这里临时摘掉覆盖，
  // 单独验证**默认规则**本身没有被改坏。
  const override = process.env.DSH_NOTCH_DATA_DIR;
  const previousLocal = process.env.LOCALAPPDATA;
  const fakeLocal = path.join(os.tmpdir(), 'dsh-notch-fake-local');
  delete process.env.DSH_NOTCH_DATA_DIR;
  process.env.LOCALAPPDATA = fakeLocal;
  try {
    assert.equal(dataDir(), path.join(fakeLocal, P.PLUGIN_ID), '默认落点必须是 %LOCALAPPDATA%\\<插件 id>');
    assert.equal(
      endpointFilePath(1234),
      path.join(dataDir(), `${P.ENDPOINT_PREFIX}1234${P.ENDPOINT_SUFFIX}`),
    );
  } finally {
    process.env.DSH_NOTCH_DATA_DIR = override;
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocal;
  }
});
