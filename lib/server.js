/**
 * @module @dsh-external/dsh-notch-win/server
 *
 * 宿主半边自建的回环 HTTP，**同时**服务两个消费者：
 * - 岛 app（Electron，独立进程）：拉状态、发跳转请求
 * - 插件自己的渲染半边（DSH 渲染进程里的浏览器 bundle）：读配置、轮询跳转命令
 *
 * ## 为什么是自建服务器，而不是 `ctx.webServer.register(route)`
 *
 * `ctx.webServer` 确实提供 route 注册，但 `@deepseek-ai/dsh-host-webserver` 的
 * README 明确写着「Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch」——
 * 也就是说桌面版渲染进程能不能打到插件 route 是**未经验证**的。本插件改用自建
 * 回环端口，由渲染半边与岛 app 直接 `fetch`。
 *
 * ## 安全模型（无需密钥）
 *
 * | 措施 | 挡什么 |
 * | --- | --- |
 * | 只绑 `127.0.0.1` | 对外暴露 |
 * | `Host` 栅栏 | DNS rebinding（Host 是重绑定唯一伪造不了的请求头） |
 * | `Origin` 白名单 + 回显（**永不用 `*`**） | 跨站读 |
 * | 所有 POST 必须带 `X-Notch: 1`（强制预检） | 跨站写 |
 * | `sec-fetch-site: cross-site` 一律拒 | 双保险 |
 * | 不回传会话正文（`detailText` 已在状态机里截断到 120 字符） | 减小泄漏面 |
 *
 * 刻意**不**引入 per-boot token：那需要把密钥分发给渲染半边，而渲染半边在
 * Electron 下无法可靠拿到注入脚本，等于把"分发机制本身"变成新的失败面。
 * 同机同用户的恶意进程不在威胁模型内。
 */
import http from 'node:http';

import * as P from './protocol.js';

function stripPort(host) {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const index = host.lastIndexOf(':');
  return index >= 0 ? host.slice(0, index) : host;
}

/** `Host` 必须是回环权威 —— 否则 403。 */
export function hostAllowed(headers) {
  const raw = headers.host;
  if (typeof raw !== 'string' || raw === '') return false;
  return P.ALLOWED_HOSTS.includes(stripPort(raw));
}

/**
 * `Origin` 策略：缺失（非浏览器客户端，例如岛 app）放行；`null`（Electron
 * `file://` 页面）放行；回环权威放行并**回显**该 Origin；其余一律拒。
 */
export function originPolicy(headers) {
  const origin = headers.origin;
  if (origin === undefined) return { ok: true, echo: null };
  if (origin === 'null') return { ok: true, echo: 'null' };
  if (typeof origin !== 'string') return { ok: false, echo: null };
  // DSH 桌面渲染进程的自定义 scheme。网页无法伪造 Origin（它是 forbidden
  // header，只能由浏览器自己填），所以按可信来源放行并回显。
  if (origin === 'dsh-app://app') return { ok: true, echo: origin };
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, echo: null };
  }
  if (!P.ALLOWED_HOSTS.includes(parsed.hostname)) return { ok: false, echo: null };
  return { ok: true, echo: origin };
}

function corsHeaders(echo) {
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-notch',
    'Access-Control-Max-Age': '600',
  };
  if (echo !== null) headers['Access-Control-Allow-Origin'] = echo;
  return headers;
}

function json(res, status, body, echo) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    ...corsHeaders(echo),
  });
  res.end(payload);
}

function fail(res, status, code, message, echo) {
  json(res, status, { ok: false, code, message }, echo);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > P.MAX_BODY_BYTES) {
      const error = new Error(`请求体超过 ${P.MAX_BODY_BYTES} 字节`);
      error.code = P.ERR.tooLarge;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.code = P.ERR.badJson;
    throw error;
  }
}

/**
 * @param handlers 由 `lib/index.js` 提供的业务回调，全部可以是 async：
 *   `health()` `state(sinceRev)` `jump(sessionId)` `commands(since)` `config(patch)` `focus(sessionId)`
 */
export function createServer({ log, handlers, portBase, portTries }) {
  const firstPort = portBase ?? P.PORT_BASE;
  const tries = portTries ?? P.PORT_TRIES;
  let server = null;
  let port = 0;

  async function route(req, res, echo) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'GET' && path === P.ROUTE.health) {
      return json(res, 200, { ok: true, ...(await handlers.health()) }, echo);
    }

    if (req.method === 'GET' && path === P.ROUTE.state) {
      const since = url.searchParams.get('rev');
      return json(res, 200, await handlers.state(since), echo);
    }

    if (req.method === 'GET' && path === P.ROUTE.commands) {
      const raw = url.searchParams.get('since');
      const since = raw === null ? 0 : Number.parseInt(raw, 10);
      return json(res, 200, await handlers.commands(Number.isFinite(since) ? since : 0), echo);
    }

    if (req.method === 'POST' && P.MUTATING_ROUTES.includes(path)) {
      const body = await readJson(req);
      if (path === P.ROUTE.jump) return json(res, 200, await handlers.jump(body), echo);
      if (path === P.ROUTE.config) return json(res, 200, await handlers.config(body), echo);
      if (path === P.ROUTE.ack) return json(res, 200, await handlers.ack(body), echo);
      return json(res, 200, await handlers.focus(body), echo);
    }

    return fail(res, 404, P.ERR.unknownRoute, `未知路由 ${req.method} ${path}`, echo);
  }

  async function onRequest(req, res) {
    const policy = originPolicy(req.headers);

    if (req.method === 'OPTIONS') {
      if (!policy.ok) return fail(res, 403, P.ERR.forbiddenOrigin, '来源不被允许', null);
      const headers = corsHeaders(policy.echo);
      // Chromium 的 Private Network Access：从 `file://`（不透明来源）向回环地址发
      // **带自定义头**的请求时会先发预检，并要求响应显式放行这一跳，否则 POST 会被
      // 浏览器直接拦掉 —— 表现为"GET 能通、保存配置没反应"。DSH 桌面版正是
      // `file://` 加载 dist，所以这一条是必需的，不是可选加固。
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, headers);
      return res.end();
    }

    if (!hostAllowed(req.headers)) {
      return fail(res, 403, P.ERR.forbiddenHost, 'Host 必须是回环地址', policy.echo);
    }
    if (!policy.ok) {
      return fail(res, 403, P.ERR.forbiddenOrigin, '来源不被允许', null);
    }
    // DSH 渲染进程是 `dsh-app://app` → `http://127.0.0.1`，浏览器会把这条
    // 请求标成 cross-site；Origin 已经过白名单，这里不能再按跨站拒。
    if (policy.echo !== 'dsh-app://app' && req.headers['sec-fetch-site'] === 'cross-site') {
      return fail(res, 403, P.ERR.forbiddenOrigin, '拒绝跨站请求', policy.echo);
    }

    const path = (req.url ?? '/').split('?')[0];
    const mutating = P.MUTATING_ROUTES.includes(path);
    // 所有会改状态的路由都必须带自定义头：浏览器会先发预检，而预检对跨站来源
    // 会被上面的 Origin 策略拒掉 —— 于是跨站页面根本发不出这个 POST。
    if (mutating && req.headers[P.NOTCH_HEADER] !== P.NOTCH_HEADER_VALUE) {
      return fail(res, 403, P.ERR.forbiddenOrigin, `缺少 ${P.NOTCH_HEADER} 头`, policy.echo);
    }

    try {
      await route(req, res, policy.echo);
    } catch (error) {
      if (error && error.code === P.ERR.tooLarge) {
        return fail(res, 413, P.ERR.tooLarge, error.message, policy.echo);
      }
      if (error && error.code === P.ERR.badJson) {
        return fail(res, 400, P.ERR.badJson, error.message, policy.echo);
      }
      if (error && error.code === P.ERR.configRejected) {
        return fail(res, 400, P.ERR.configRejected, error.message, policy.echo);
      }
      if (error && error.code === P.ERR.featureDisabled) {
        return fail(res, 409, P.ERR.featureDisabled, error.message, policy.echo);
      }
      if (error && error.code === P.ERR.badRequest) {
        // 调用方明确判定的"请求不合法"（例如缺少 sessionId）必须映射成 400，
        // 否则会伪装成服务器故障，把排查方向带偏。
        return fail(res, 400, P.ERR.badRequest, error.message, policy.echo);
      }
      log?.warn?.('处理请求失败：', error);
      return fail(res, 500, P.ERR.badRequest, '内部错误', policy.echo);
    }
  }

  return {
    get port() {
      return port;
    },
    get base() {
      return `http://${P.LISTEN_HOST}:${port}`;
    },
    get listening() {
      return server !== null && server.listening;
    },
    /** 实际绑定地址（测试用它断言"只绑回环"）。 */
    address() {
      return server ? server.address() : null;
    },

    /** 从 `PORT_BASE` 起顺延绑定；全部占用则抛错（由调用方降级，不影响 DSH 本体）。 */
    async start() {
      if (server) return port;
      const last = firstPort + tries - 1;
      for (let candidate = firstPort; candidate <= last; candidate += 1) {
        const attempt = http.createServer((req, res) => {
          onRequest(req, res).catch((error) => {
            log?.warn?.('请求处理未捕获异常：', error);
            try {
              fail(res, 500, P.ERR.badRequest, '内部错误', null);
            } catch {
              /* 响应头已发出：忽略 */
            }
          });
        });
        attempt.keepAliveTimeout = 5000;
        attempt.headersTimeout = 10000;
        try {
          await new Promise((resolve, reject) => {
            const onError = (error) => {
              attempt.removeListener('listening', onListening);
              reject(error);
            };
            const onListening = () => {
              attempt.removeListener('error', onError);
              resolve();
            };
            attempt.once('error', onError);
            attempt.once('listening', onListening);
            attempt.listen(candidate, P.LISTEN_HOST);
          });
        } catch (error) {
          try {
            attempt.close();
          } catch {
            /* ignore */
          }
          if (error && error.code === 'EADDRINUSE') continue;
          throw error;
        }
        server = attempt;
        port = candidate;
        server.on('error', (error) => log?.warn?.('HTTP 运行时错误：', error));
        return port;
      }
      throw new Error(`端口 ${firstPort}~${last} 全部被占用`);
    },

    /**
     * 关闭监听。**必须显式踢掉空闲连接**：Node 的 `server.close()` 只停止接受新连接，
     * 空闲的 keep-alive socket 会一直占着端口（我们的 `keepAliveTimeout` 是 5s），
     * 于是"卸载后立刻重启"会撞 EADDRINUSE。
     */
    async stop() {
      if (!server) return;
      const closing = server;
      server = null;
      port = 0;

      if (typeof closing.closeIdleConnections === 'function') closing.closeIdleConnections();
      await new Promise((resolve) => {
        // 兜底：还在传输中的连接最多再给 250ms，然后强制断开。
        const force = setTimeout(() => {
          if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections();
        }, 250);
        force.unref?.();
        closing.close(() => {
          clearTimeout(force);
          resolve();
        });
      });
    },
  };
}
