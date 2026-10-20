'use strict';

/**
 * 宿主半边的 HTTP 客户端（app 侧）。
 *
 * 只做几件事：探活、拉快照、发跳转、报焦点、确认完成。**没有任何状态机** —— 状态机在
 * 宿主进程里（方案 A），这里拿到的就是可以直接画的一份快照。
 */
const P = require('./protocol.cjs');

const DEFAULT_TIMEOUT_MS = 3000;

function createHostClient({ fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function request(base, path, { method = 'GET', body } = {}) {
    if (!doFetch) throw new Error('当前运行时没有 fetch');
    // 不连接时 base 是 null，拼出来会是 "null/v1/state" —— 在 Electron 里这倒是
    // 会立刻抛（非法 URL），但错误信息毫无指向性。这里明确报出来。
    if (typeof base !== 'string' || base === '') throw new Error('尚未连接到宿主半边');
    const init = {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers:
        method === 'GET'
          ? undefined
          : { 'content-type': 'application/json', [P.NOTCH_HEADER]: P.NOTCH_HEADER_VALUE },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await doFetch(`${base}${path}`, init);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  let base = null;

  return {
    get base() {
      return base;
    },
    set base(value) {
      base = value === null || value === undefined ? null : String(value);
    },
    get connected() {
      return base !== null;
    },

    /** 探活：返回 health 对象，或 `null`（端口没人听 / 形状不对）。 */
    async probe(port) {
      try {
        const health = await request(`http://127.0.0.1:${port}`, P.ROUTE.health);
        if (!health || health.ok !== true) return null;
        return health;
      } catch (error) {
        return null;
      }
    },

    /** 拉快照。带 `rev` 时宿主可能只回 `{ unchanged: true }`（省一次序列化）。 */
    state(rev) {
      const query = typeof rev === 'string' && rev !== '' ? `?rev=${encodeURIComponent(rev)}` : '';
      return request(base, P.ROUTE.state + query);
    },

    jump(sessionId) {
      return request(base, P.ROUTE.jump, { method: 'POST', body: { sessionId } });
    },

    focus(sessionId) {
      return request(base, P.ROUTE.focus, {
        method: 'POST',
        body: { sessionId: sessionId === null ? null : String(sessionId) },
      });
    },

    ack(sessionId) {
      return request(base, P.ROUTE.ack, { method: 'POST', body: { sessionId } });
    },
  };
}

module.exports = { createHostClient };
