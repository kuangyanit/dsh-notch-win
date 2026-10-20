/**
 * 岛 app 侧的测试。
 *
 * app 是**独立进程**，没法在这里真的开 Electron 窗口；但它最容易出错的两块
 * 是纯逻辑，而且正好是旧实现栽过的地方：
 *
 * 1. `endpoint.js` —— 旧实现"复用已在运行的桥"，日志里能看到它复用了**已经死掉**
 *    的宿主，然后跳转永远失效且没有任何提示。这里把"必须 pid 活着 + health 回的
 *    pid 与文件名一致 + 协议版本对得上"钉住。
 * 2. `host-client.js` —— 写请求必须带 `X-Notch` 头（服务端靠它挡跨站写）。
 *
 * 另外把每个源文件都过一遍语法检查：这些文件在 Electron 里跑，平时不会被
 * 任何工具链碰，语法错了要等到用户双击 exe 才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as P from '../lib/protocol.js';
import * as hostPaths from '../lib/paths.js';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_SRC = path.join(ROOT, 'app', 'src');

const endpoint = require('../app/src/endpoint.js');
const { createHostClient } = require('../app/src/host-client.js');

// ───────────────────────── 语法与元数据 ─────────────────────────

test('app 的每个源文件都能通过语法解析', () => {
  const files = fs
    .readdirSync(APP_SRC)
    .filter((name) => name.endsWith('.js') || name.endsWith('.cjs'));
  assert.ok(files.length >= 5, `app/src 下文件太少（${files.length}），路径可能不对`);
  for (const name of files) {
    const source = fs.readFileSync(path.join(APP_SRC, name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }), `${name} 有语法错误`);
  }
});

test('main.js 在抢单实例锁之前就把 userData 挪到自己的目录', () => {
  // 本 app 的 productName 也叫 `DSHNotch`，打包后默认 userData 是 `%APPDATA%\DSHNotch`
  // —— 与其它同样叫 DSHNotch 的 app **同一个目录**。而 Electron 的单实例锁
  // 就落在 userData 里：共用它 = 谁先启动谁活，后启动的静默退出（连窗口都不建），
  // 表现为"重启了但岛没出现"，且**不报任何错**。这个失败完全无声，所以必须钉住。
  const source = fs.readFileSync(path.join(APP_SRC, 'main.js'), 'utf8');

  const setPath = source.indexOf("app.setPath('userData'");
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  assert.ok(lock !== -1, 'main.js 里找不到 requestSingleInstanceLock');
  assert.ok(setPath !== -1, 'main.js 没有设置 userData，会和旧岛抢单实例锁');
  assert.ok(
    setPath < lock,
    'userData 必须在 requestSingleInstanceLock() **之前**设置，否则锁已经落在旧目录里了',
  );

  // userData 目录名必须能和旧岛的 DSHNotch 区分；目录还必须先 mkdirSync 出来，
  // 否则 Chromium 写不出单实例锁文件，requestSingleInstanceLock() 返回 false → app 静默 quit。
  const mkdir = source.indexOf('fs.mkdirSync(userDataDir');
  assert.ok(mkdir !== -1 && mkdir < setPath, 'setPath 之前必须先 mkdirSync(userDataDir)');
  const declaration = source.slice(source.indexOf('const userDataDir'), setPath);
  assert.ok(
    declaration.includes("'dsh-notch-win'"),
    `userData 目录名要能和旧岛区分：${declaration}`,
  );

  const call = source.slice(setPath, source.indexOf(';', setPath));
  assert.ok(call.includes('userDataDir'), `setPath 应使用已建好的 userDataDir：${call}`);
  assert.ok(
    !/['"]DSHNotch['"]/.test(call),
    `userData 不能落在旧岛的 DSHNotch 目录（单实例锁会互抢）：${call}`,
  );
});

test('app/src/index.html 引用的 id 在 renderer.js 里都取到了', () => {
  const html = fs.readFileSync(path.join(APP_SRC, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(APP_SRC, 'renderer.js'), 'utf8');

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const match of renderer.matchAll(/el\('([^']+)'\)/g)) {
    assert.ok(ids.has(match[1]), `renderer.js 取了不存在的 id：${match[1]}`);
  }
  // 反向：HTML 里的 id 若是死的，多半是改结构时漏了渲染层
  for (const id of ids) {
    if (id === 'island' || id === 'body') continue; // 这两个只被 CSS/结构用到
    assert.ok(
      renderer.includes(`'${id}'`),
      `index.html 里的 #${id} 没有被 renderer.js 使用（改名或删结构时漏了？）`,
    );
  }
});

test('岛只显示粗粒度过程：表头只确认完成，保持展开在页脚', () => {
  const renderer = fs.readFileSync(path.join(APP_SRC, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(APP_SRC, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(APP_SRC, 'styles.css'), 'utf8');

  assert.equal(
    /(?:entry|focus)\.detailText/.test(renderer),
    false,
    '岛渲染层不应直接显示 detailText（具体命令/URL/参数）',
  );
  assert.ok(renderer.includes('STATUS_LABEL[entry.status]'), '会话行应显示粗粒度状态');
  assert.ok(
    renderer.indexOf('row-badge') < renderer.indexOf('row-label'),
    '会话行应与表头一致：状态徽标在标题前',
  );
  assert.ok(renderer.includes('elapsedOf(entry, now)'), '会话行右侧应显示耗时');
  assert.equal(renderer.includes("el('detail')"), false, '展开态不应再有单独的详情行');
  assert.equal(html.includes('id="detail"'), false, 'index.html 不应再有 #detail');
  // 折叠态不能把 badge 一起藏掉，否则不钉住时看不到当前过程。
  assert.equal(
    styles.includes("[data-expanded='0'] .badge"),
    false,
    '折叠态必须保留状态徽标',
  );
  // 面板级“保持展开”在页脚；表头点击只用于确认已完成/已停止。
  assert.ok(html.includes('id="pin"'), '页脚应有保持展开按钮');
  assert.ok(renderer.includes("el('pin')"), 'renderer 应绑定 #pin');
  assert.ok(renderer.includes('保持展开'), '页脚应使用“保持展开”文案');
  assert.ok(/hdr\.addEventListener\('click'/.test(renderer), '表头应承担确认完成的点击');
  assert.ok(renderer.includes('I.ack'), '表头点击应调用 ack');
  // 可见文案统一中文：徽标和宿主信息不再出现 IDLE / pid 这种英文裸词。
  assert.ok(renderer.includes("thinking: '思考中'"), '状态徽标应中文');
  assert.ok(renderer.includes("done: '已完成'"), '完成状态文案应为“已完成”');
  assert.ok(renderer.includes('已停止'), '停止状态文案应为“已停止”');
  assert.ok(renderer.includes('宿主进程'), '页脚宿主信息应中文');
});

test('app 的 package.json 是 CJS 且主入口存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  assert.equal(pkg.type, undefined, 'app 必须是 CJS：protocol.cjs 靠 require 加载');
  assert.ok(fs.existsSync(path.join(ROOT, 'app', pkg.main)));
  assert.equal(pkg.build.win.target[0], 'dir', '只出目录，不做安装器（安装是刻意砍掉的）');
});

// ───────────────────────── 端点发现 ─────────────────────────

function withTempLocalAppData(run) {
  const previous = process.env.LOCALAPPDATA;
  // 显式清掉覆盖变量：app 与宿主两侧的 dataDir() 都是"覆盖优先"，
  // 不清的话下面那条一致性断言就会取决于调用者的环境（调试时很容易踩到）。
  const previousOverride = process.env.DSH_NOTCH_DATA_DIR;
  delete process.env.DSH_NOTCH_DATA_DIR;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-test-'));
  process.env.LOCALAPPDATA = dir;

  const restore = () => {
    process.env.LOCALAPPDATA = previous;
    if (previousOverride === undefined) delete process.env.DSH_NOTCH_DATA_DIR;
    else process.env.DSH_NOTCH_DATA_DIR = previousOverride;
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    const dataDir = path.join(dir, P.PLUGIN_ID);
    fs.mkdirSync(dataDir, { recursive: true });
    const result = run(dataDir);
    // 异步用例必须等它跑完再还原环境，否则断言是在"环境已经被改回去"之后执行的。
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function writeEndpoint(dataDir, pid, payload) {
  const file = path.join(dataDir, `${P.ENDPOINT_PREFIX}${pid}${P.ENDPOINT_SUFFIX}`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

/** 找一个**确定已经死掉**的 pid，用来伪造"残留的端点文件"。 */
function findDeadPid() {
  for (let candidate = 0x7ffffffe; candidate > 0x7ffffff0; candidate -= 1) {
    if (!endpoint.isPidAlive(candidate)) return candidate;
  }
  throw new Error('找不到可用的死 pid，测试前提不成立');
}

test('数据目录与宿主半边一致（都是 %LOCALAPPDATA%\\dsh-notch-win）', () => {
  withTempLocalAppData((dataDir) => {
    assert.equal(endpoint.dataDir(), dataDir);
    // 两个实现（lib/paths.js 与 app/src/endpoint.js）是各自独立的副本，
    // 所以必须**双向**钉住，而不是只信注释里那句"必须一致"。
    assert.equal(hostPaths.dataDir(), dataDir, '宿主半边与 app 算出的数据目录不一致');
  });
});

test('DSH_NOTCH_DATA_DIR 覆盖数据目录，且 app 与宿主两侧规则相同', () => {
  const previous = process.env.DSH_NOTCH_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-test-'));
  process.env.DSH_NOTCH_DATA_DIR = dir;
  try {
    assert.equal(endpoint.dataDir(), path.resolve(dir), 'app 没有认这条覆盖');
    assert.equal(hostPaths.dataDir(), path.resolve(dir), '宿主半边没有认这条覆盖');
    // 覆盖优先于 LOCALAPPDATA：宿主拉起岛 app 时就是靠这个把两者对齐的。
    process.env.LOCALAPPDATA = path.join(dir, 'salt');
    assert.equal(endpoint.dataDir(), path.resolve(dir));
  } finally {
    if (previous === undefined) delete process.env.DSH_NOTCH_DATA_DIR;
    else process.env.DSH_NOTCH_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('挑出还活着并且 health 回的 pid 对得上的那一个', async () => {
  await withTempLocalAppData(async (dataDir) => {
    const deadPid = findDeadPid();
    const deadFile = writeEndpoint(dataDir, deadPid, {
      protocol: P.PROTOCOL_VERSION,
      port: 47411,
      pid: deadPid,
      startedAt: Date.now() + 1000, // 更新：若只看"最新"就会选它
    });
    writeEndpoint(dataDir, process.pid, {
      protocol: P.PROTOCOL_VERSION,
      port: 47413,
      pid: process.pid,
      startedAt: Date.now(),
    });

    const probed = [];
    const found = await endpoint.findLiveHost(async (port) => {
      probed.push(port);
      return { ok: true, pid: process.pid, protocol: P.PROTOCOL_VERSION };
    });

    assert.equal(found.port, 47413);
    assert.equal(found.pid, process.pid);
    assert.deepEqual(probed, [47413], '死掉的那个不该被探测');
    assert.equal(fs.existsSync(deadFile), false, '残留的端点文件应当被顺手清掉');
  });
});

test('health 回的 pid 与文件名不一致时不算命中（挡住 pid 复用 / 端口被抢）', async () => {
  await withTempLocalAppData(async (dataDir) => {
    writeEndpoint(dataDir, process.pid, {
      protocol: P.PROTOCOL_VERSION,
      port: 47411,
      pid: process.pid,
      startedAt: Date.now(),
    });

    const found = await endpoint.findLiveHost(async () => ({
      ok: true,
      pid: process.pid + 1,
      protocol: P.PROTOCOL_VERSION,
    }));
    assert.equal(found, null);
  });
});

test('协议版本对不上的端点文件根本不进候选（挡住旧实现的 47311 桥）', async () => {
  await withTempLocalAppData(async (dataDir) => {
    writeEndpoint(dataDir, process.pid, {
      protocol: P.PROTOCOL_VERSION + 1,
      port: 47311,
      pid: process.pid,
      startedAt: Date.now(),
    });

    const probed = [];
    const found = await endpoint.findLiveHost(async (port) => {
      probed.push(port);
      return { ok: true, pid: process.pid, protocol: P.PROTOCOL_VERSION };
    });
    assert.equal(found, null);
    assert.deepEqual(probed, []);
  });
});

test('坏掉的 / 名字不对的文件一律跳过，不会抛', async () => {
  await withTempLocalAppData(async (dataDir) => {
    fs.writeFileSync(path.join(dataDir, 'endpoint-nope.json'), 'not json', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'endpoint-abc.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dataDir, `${P.ENDPOINT_PREFIX}12${P.ENDPOINT_SUFFIX}`), '{', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'unrelated.txt'), 'x', 'utf8');

    assert.deepEqual(endpoint.readEndpoints(), []);
    assert.equal(await endpoint.findLiveHost(async () => null), null);
  });
});

test('数据目录不存在时安静返回空（DSH 还没启动过）', async () => {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(os.tmpdir(), 'dsh-notch-does-not-exist-at-all');
  try {
    assert.deepEqual(endpoint.readEndpoints(), []);
    assert.equal(await endpoint.findLiveHost(async () => ({ ok: true })), null);
  } finally {
    process.env.LOCALAPPDATA = previous;
  }
});

// ───────────────────────── HTTP 客户端 ─────────────────────────

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  const client = createHostClient({ fetchImpl: impl });
  return { client, calls };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('probe 把"端口没人听"和"形状不对"都归成 null', async () => {
  const throwing = createHostClient({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(await throwing.probe(47411), null);

  const wrong = createHostClient({
    fetchImpl: async () => jsonResponse({ ok: false }),
  });
  assert.equal(await wrong.probe(47411), null);

  const right = createHostClient({
    fetchImpl: async () => jsonResponse({ ok: true, pid: 1, protocol: P.PROTOCOL_VERSION }),
  });
  assert.equal((await right.probe(47411)).pid, 1);
});

test('state 带 rev 时拼进查询串（宿主据此短路序列化）', async () => {
  const { client, calls } = stubFetch(async () => jsonResponse({ rev: 'abc' }));
  client.base = 'http://127.0.0.1:47411';

  await client.state();
  await client.state('deadbeef');
  assert.equal(calls[0].url, `http://127.0.0.1:47411${P.ROUTE.state}`);
  assert.equal(calls[1].url, `http://127.0.0.1:47411${P.ROUTE.state}?rev=deadbeef`);
});

test('写请求带 X-Notch 头与 JSON 体；focus(null) 表示取消聚焦', async () => {
  const { client, calls } = stubFetch(async () => jsonResponse({ ok: true }));
  client.base = 'http://127.0.0.1:47411';

  await client.jump('session-abc');
  assert.equal(calls[0].url, `http://127.0.0.1:47411${P.ROUTE.jump}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers[P.NOTCH_HEADER], P.NOTCH_HEADER_VALUE);
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 'session-abc' });

  await client.focus(null);
  assert.deepEqual(JSON.parse(calls[1].init.body), { sessionId: null });
});

test('未连接时 base 为 null，请求会明确失败而不是打到 localhost:0', async () => {
  const { client } = stubFetch(async () => jsonResponse({}));
  assert.equal(client.connected, false);
  assert.equal(client.base, null);
  await assert.rejects(() => client.state(), /尚未连接/);
  client.base = 'http://127.0.0.1:47411';
  assert.equal(client.connected, true);
  client.base = null;
  assert.equal(client.connected, false);
});

test('HTTP 非 2xx 会抛且带状态码', async () => {
  const { client } = stubFetch(async () => jsonResponse({ ok: false }, 503));
  client.base = 'http://127.0.0.1:47411';
  await assert.rejects(
    () => client.state(),
    (error) => {
      assert.equal(error.status, 503);
      return true;
    },
  );
});
