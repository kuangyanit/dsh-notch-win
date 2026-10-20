/**
 * 回环 HTTP 的契约与安全栅栏测试。
 *
 * 安全部分是重点：这一层是"DSH 之外的世界"唯一能进到岛状态的路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import * as P from '../lib/protocol.js';
import { createServer, hostAllowed, originPolicy } from '../lib/server.js';

// 用一段独立端口，避免和真机上跑的实例互相打扰。
const TEST_PORT_BASE = 47611;

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
        // 每个用例起一个**新**连接：Node 19+ 的全局 agent 默认 keep-alive，
        // 复用上一个用例已经关掉的 server 的池化 socket 会得到 ECONNRESET。
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
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fakeHandlers() {
  const seen = { jumps: [], config: [], focus: [], acks: [], since: [] };
  const rev = 'deadbeef';
  return {
    seen,
    rev,
    handlers: {
      async health() {
        return { pid: process.pid, protocol: P.PROTOCOL_VERSION, entries: 2, live: 1 };
      },
      async state(sinceRev) {
        if (sinceRev === rev) return { unchanged: true, rev };
        return { v: P.PROTOCOL_VERSION, rev, entries: [] };
      },
      async commands(since) {
        seen.since.push(since);
        return { seq: 3, config: { enabled: true }, configSource: 'settings', jumps: [] };
      },
      async jump(body) {
        seen.jumps.push(body);
        return { ok: true, seq: seen.jumps.length };
      },
      async config(body) {
        if (body?.patch && body.patch.scale === 9) {
          const error = new Error('$.n expected number <= 1.4 but got 9');
          error.code = P.ERR.configRejected;
          throw error;
        }
        seen.config.push(body);
        return { ok: true, config: { enabled: true, scale: 1 } };
      },
      async focus(body) {
        seen.focus.push(body);
        return { ok: true };
      },
      async ack(body) {
        seen.acks.push(body);
        return { ok: true };
      },
    },
  };
}

async function withServer(run) {
  const fake = fakeHandlers();
  const server = createServer({ log: null, handlers: fake.handlers, portBase: TEST_PORT_BASE, portTries: 4 });
  await server.start();
  try {
    await run({ fake, server, port: server.port });
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 纯函数：栅栏判定
// ---------------------------------------------------------------------------

test('hostAllowed 只认回环权威', () => {
  assert.equal(hostAllowed({ host: '127.0.0.1:47411' }), true);
  assert.equal(hostAllowed({ host: 'localhost:47411' }), true);
  assert.equal(hostAllowed({ host: '[::1]:47411' }), true);
  assert.equal(hostAllowed({ host: 'evil.com' }), false);
  assert.equal(hostAllowed({ host: '127.0.0.1.evil.com' }), false);
  assert.equal(hostAllowed({}), false);
});

test('originPolicy：缺失放行、null 放行、回环回显、其余拒', () => {
  assert.deepEqual(originPolicy({}), { ok: true, echo: null });
  assert.deepEqual(originPolicy({ origin: 'null' }), { ok: true, echo: 'null' });
  assert.deepEqual(originPolicy({ origin: 'http://127.0.0.1:8080' }), {
    ok: true,
    echo: 'http://127.0.0.1:8080',
  });
  assert.deepEqual(originPolicy({ origin: 'dsh-app://app' }), {
    ok: true,
    echo: 'dsh-app://app',
  });
  assert.equal(originPolicy({ origin: 'http://evil.com' }).ok, false);
  assert.equal(originPolicy({ origin: 'not a url' }).ok, false);
});

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

test('GET /v1/health 与 /v1/state 正常应答', async () => {
  await withServer(async ({ port, fake }) => {
    const health = await request(port, 'GET', P.ROUTE.health);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.live, 1);

    const state = await request(port, 'GET', P.ROUTE.state);
    assert.equal(state.status, 200);
    assert.equal(state.body.rev, fake.rev);
    assert.deepEqual(state.body.entries, []);
  });
});

test('state 的 rev 短路：相同 rev 只回 unchanged', async () => {
  await withServer(async ({ port, fake }) => {
    const same = await request(port, 'GET', `${P.ROUTE.state}?rev=${fake.rev}`);
    assert.equal(same.status, 200);
    assert.deepEqual(same.body, { unchanged: true, rev: fake.rev });

    const other = await request(port, 'GET', `${P.ROUTE.state}?rev=ffffffff`);
    assert.equal(other.body.unchanged, undefined);
  });
});

test('commands 解析 since，缺省为 0', async () => {
  await withServer(async ({ port, fake }) => {
    await request(port, 'GET', `${P.ROUTE.commands}?since=7`);
    await request(port, 'GET', P.ROUTE.commands);
    await request(port, 'GET', `${P.ROUTE.commands}?since=abc`);
    assert.deepEqual(fake.seen.since, [7, 0, 0]);
  });
});

test('可变路由必须带 X-Notch 头（挡住跨站写）', async () => {
  await withServer(async ({ port, fake }) => {
    const body = { sessionId: 'session-1' };

    const without = await request(port, 'POST', P.ROUTE.jump, { body });
    assert.equal(without.status, 403);
    assert.equal(without.body.code, P.ERR.forbiddenOrigin);
    assert.equal(fake.seen.jumps.length, 0);

    const withHeader = await request(port, 'POST', P.ROUTE.jump, {
      body,
      headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
    });
    assert.equal(withHeader.status, 200);
    assert.equal(withHeader.body.ok, true);
    assert.deepEqual(fake.seen.jumps, [body]);
  });
});

test('config、focus 与 ack 也走同一条写入路径', async () => {
  await withServer(async ({ port, fake }) => {
    const headers = { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE };

    const config = await request(port, 'POST', P.ROUTE.config, { body: { patch: { scale: 1.2 } }, headers });
    assert.equal(config.status, 200);
    assert.deepEqual(fake.seen.config, [{ patch: { scale: 1.2 } }]);

    const focus = await request(port, 'POST', P.ROUTE.focus, { body: { sessionId: 'session-9' }, headers });
    assert.equal(focus.status, 200);
    assert.deepEqual(fake.seen.focus, [{ sessionId: 'session-9' }]);

    const ack = await request(port, 'POST', P.ROUTE.ack, { body: { sessionId: 'session-9' }, headers });
    assert.equal(ack.status, 200);
    assert.deepEqual(fake.seen.acks, [{ sessionId: 'session-9' }]);
  });
});

test('被拒绝的配置写入映射成 400 config-rejected，而不是 500', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'POST', P.ROUTE.config, {
      body: { patch: { scale: 9 } },
      headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, P.ERR.configRejected);
    assert.match(res.body.message, /expected number/);
  });
});

test('畸形 JSON 体是 400 bad-json，不是 500', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'POST', P.ROUTE.jump, {
      body: '{not json',
      headers: { [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, P.ERR.badJson);
  });
});

test('未知路由是 404 unknown-route', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'GET', '/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, P.ERR.unknownRoute);
    assert.equal((await request(port, 'GET', '/api/settings.describe')).status, 404);
  });
});

// ---------------------------------------------------------------------------
// 栅栏
// ---------------------------------------------------------------------------

test('非回环 Host 一律 403（挡 DNS rebinding）', async () => {
  await withServer(async ({ port }) => {
    for (const host of ['evil.com', '127.0.0.1.evil.com', 'localhost.evil.com']) {
      const res = await request(port, 'GET', P.ROUTE.health, { headers: { host } });
      assert.equal(res.status, 403, `Host: ${host} 应该被拒`);
      assert.equal(res.body.code, P.ERR.forbiddenHost);
    }
  });
});

test('跨站 Origin 一律 403，且不回显 ACAO=*', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'GET', P.ROUTE.health, {
      headers: { origin: 'http://evil.com' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, P.ERR.forbiddenOrigin);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

test('回环 Origin 被回显（而不是用 *）', async () => {
  await withServer(async ({ port }) => {
    const origin = 'http://127.0.0.1:8080';
    const res = await request(port, 'GET', P.ROUTE.health, { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers.vary, 'Origin');
  });
});

test('Electron 的 file:// 页面（Origin: null）被放行', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'POST', P.ROUTE.jump, {
      body: { sessionId: 'session-1' },
      headers: { origin: 'null', [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
  });
});

test('sec-fetch-site: cross-site 直接拒（双保险）', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'GET', P.ROUTE.health, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
  });
});

test('dsh-app://app 的 cross-site 标记要放行（自定义 scheme 访问回环必然跨站）', async () => {
  await withServer(async ({ port }) => {
    const res = await request(port, 'GET', P.ROUTE.health, {
      headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'dsh-app://app');
  });
});

test('OPTIONS 预检：允许来源 204，跨站来源 403', async () => {
  await withServer(async ({ port }) => {
    const ok = await request(port, 'OPTIONS', P.ROUTE.config, {
      headers: { origin: 'http://127.0.0.1:8080', 'access-control-request-method': 'POST' },
    });
    assert.equal(ok.status, 204);
    assert.match(ok.headers['access-control-allow-headers'], /x-notch/);

    const bad = await request(port, 'OPTIONS', P.ROUTE.config, {
      headers: { origin: 'http://evil.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(bad.status, 403);
  });
});

test('PNA 预检：file:// 页面（Origin: null）起 POST 时必须显式放行私网', async () => {
  await withServer(async ({ port }) => {
    const preflight = await request(port, 'OPTIONS', P.ROUTE.config, {
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-notch,content-type',
        'access-control-request-private-network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'null');
    assert.equal(
      preflight.headers['access-control-allow-private-network'],
      'true',
      '少了这个头，Chromium 会把这次跨私网请求直接拦掉',
    );

    // 不要求时就不要回这个头（避免无谓地放宽）
    const plain = await request(port, 'OPTIONS', P.ROUTE.config, {
      headers: { origin: 'null', 'access-control-request-method': 'POST' },
    });
    assert.equal(plain.headers['access-control-allow-private-network'], undefined);
  });
});

test('只绑回环：监听地址必须是 127.0.0.1', async () => {
  await withServer(async ({ server }) => {
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.family, 'IPv4');
  });
});

test('端口占用时顺延到下一个', async () => {
  const first = createServer({
    log: null,
    handlers: fakeHandlers().handlers,
    portBase: TEST_PORT_BASE + 20,
    portTries: 2,
  });
  const second = createServer({
    log: null,
    handlers: fakeHandlers().handlers,
    portBase: TEST_PORT_BASE + 20,
    portTries: 2,
  });
  await first.start();
  try {
    await second.start();
    assert.equal(first.port, TEST_PORT_BASE + 20);
    assert.equal(second.port, TEST_PORT_BASE + 21, '应顺延而不是复用或报错');
  } finally {
    await second.stop();
    await first.stop();
  }
});

test('端口段全满时报错（调用方据此降级，不影响 DSH 本体）', async () => {
  const base = TEST_PORT_BASE + 40;
  const blocker = createServer({ log: null, handlers: fakeHandlers().handlers, portBase: base, portTries: 1 });
  const loser = createServer({ log: null, handlers: fakeHandlers().handlers, portBase: base, portTries: 1 });
  await blocker.start();
  try {
    await assert.rejects(() => loser.start(), /全部被占用/);
  } finally {
    await blocker.stop();
  }
});
