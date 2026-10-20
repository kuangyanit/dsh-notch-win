/**
 * @module @dsh-external/dsh-notch-win/client
 *
 * 灵动岛的**渲染半边**（跑在 DSH 渲染进程里的浏览器 bundle）。只做三件事：
 *
 * 1. 在 `设置 → 插件` 里注册一个 tab（设置页 + 运行状态诊断页）。
 * 2. 轮询宿主半边的跳转队列，把「点了岛上的会话」变成 DSH 真的切过去。
 * 3. 把「用户当前正在看哪个会话」上报给宿主，让岛高亮正确的条目。
 *
 * ## 关键决定：渲染半边**不碰**配置的读写语义
 *
 * 设置页的读写全部走宿主半边的回环 HTTP（`/v1/state`、`/v1/config`），
 * 而不是 `ctx.settingsScope.bind({ namespace })`。旧实现同时用
 * settingsScope / 兜底副本 / localStorage 三条路写同一份配置，三路互相删键，
 * 产生了最难排查的一类缺陷。这里只有一条路：宿主 → `~/.dsh/settings.yaml`。
 *
 * 代价是渲染半边必须自己找到宿主的端口。见下面的 `probe()`：从 47411 起
 * 依次探测，取第一个 `/v1/health` 协议版本对得上的。**已知限制**：同机跑两个
 * DSH 实例时，第二个实例的设置页会连到第一个实例的宿主（岛也是），
 * 因为渲染进程拿不到「自己的宿主 pid」。这个限制写在 DESIGN.md 的 R7。
 *
 * ## 跳转为什么是 `uiWorkspace.openSession(id)`
 *
 * DSH 桌面 0.2.x 的导航 API 在 `dsh-client-ui-workspace` 的
 * `UiWorkspaceService`（`super(ctx, "uiWorkspace")`）上：`openSession(target)`
 * 会替换主区域并选中会话。`sessions` 服务（`ClientSessions`）只负责列表/对象层，
 * 没有 `open`；不同版本/服务代理下仍保留 `sessions.open` / `manager.select`
 * 两级兜底。
 *
 * ## 为什么 `inject` 是 `slots` / `sessions` / `uiWorkspace`
 *
 * 三个都是渲染进程的根服务。焦点上报同时兼容 `sessions.list.current`、
 * `uiWorkspace.selection` 和 localStorage 的 `dsh.sessions.current` ——
 * 页面刚加载时 list 可能还是 pending，`current` 是 undefined。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-notch-win',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = react;
    const h = react.createElement;

    // 原生图标（拿不到就退化成内置 SVG，卡片照常可用）。
    let IconChevronDownOutline14 = null;
    try {
      IconChevronDownOutline14 = require('@deepseek-ai/dsh-client-ui-primitives').IconChevronDownOutline14;
    } catch (error) {
      IconChevronDownOutline14 = null;
    }

    // #region 协议常量（test/client.test.mjs 会逐项与 lib/protocol.js 对比，防止漂移）
    const PROTOCOL_VERSION = 1;
    const PLUGIN_ID = 'dsh-notch-win';
    const PORT_BASE = 47411;
    const PORT_TRIES = 12;
    const ROUTE = {
      health: '/v1/health',
      state: '/v1/state',
      jump: '/v1/jump',
      commands: '/v1/commands',
      config: '/v1/config',
      focus: '/v1/focus',
      ack: '/v1/ack',
    };
    const NOTCH_HEADER = 'x-notch';
    const NOTCH_HEADER_VALUE = '1';
    const STATUS_COLOR = {
      idle: '#6B7280',
      thinking: '#4E7CFF',
      tool: '#22C55E',
      done: '#8B5CF6',
    };
    const STATE_POLL_ACTIVE_MS = 250;
    const STATE_POLL_IDLE_MS = 1000;
    const COMMAND_POLL_MS = 500;
    const COMMAND_POLL_BACKOFF_MS = 3000;
    const FOCUS_DEBOUNCE_MS = 300;
    const FOCUS_RETRY_MS = 1000;
    // #endregion

    // ────────────────────────────────────────────────────────────────────────
    // 样式：和 DSH 自带插件同样的做法 —— 一段 CSS 挂到 <style data-plugin-css=…>
    // ────────────────────────────────────────────────────────────────────────
    //
    // 颜色**全部**走 `--dsw-alias-*` 令牌（DSH 主题自己的变量），所以自动跟随
    // 明暗主题，不会出现「深色模式下白底」这种与原生卡片打架的情况。
    // 类名统一 `dshnotch_` 前缀，避免和别的插件的 CSS module 哈希撞车。
    const CSS_ID = '@dsh-external/dsh-notch-win/settings.css';
    const CSS = `
.dshnotch_section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshnotch_heading{margin:0;font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dshnotch_cards{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.dshnotch_card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}
.dshnotch_card:hover{border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2))}
.dshnotch_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2))}
.dshnotch_header{display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:0;border-radius:12px;background:0 0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.dshnotch_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshnotch_headText{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.dshnotch_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshnotch_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dshnotch_chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.dshnotch_chevronOpen{transform:rotate(180deg)}
.dshnotch_pending{flex:none;white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px}
.dshnotch_body{margin:0 16px;padding-bottom:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshnotch_field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshnotch_field+.dshnotch_field{border-top:1px solid var(--dsw-alias-border-l2)}
.dshnotch_head{display:flex;align-items:center;gap:8px}
.dshnotch_label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.dshnotch_badges{display:inline-flex;flex:none;align-items:center;gap:8px}
.dshnotch_badge{white-space:nowrap;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px}
.dshnotch_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshnotch_invalid{margin:0;color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary));font-size:12px;line-height:1.5}
.dshnotch_input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshnotch_input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.dshnotch_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshnotch_inputInvalid{border-color:var(--dsw-alias-label-error,var(--dsw-alias-border-l2))}
.dshnotch_switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .16s,border-color .16s}
.dshnotch_switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.35);transition:transform .16s}
.dshnotch_switch[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.dshnotch_switch[aria-checked=true]::after{transform:translateX(14px)}
.dshnotch_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshnotch_switch:disabled{opacity:.4;cursor:default}
.dshnotch_footer{display:flex;align-items:center;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshnotch_failed{flex:1;min-width:0;margin:0;color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary));font-size:12px;line-height:1.5}
.dshnotch_button{padding:5px 14px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dshnotch_discard{border-color:var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary)}
.dshnotch_discard:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dshnotch_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dshnotch_button:disabled{opacity:.4;cursor:default}
.dshnotch_value{margin:0;color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;word-break:break-all}
.dshnotch_valueMuted{margin:0;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;word-break:break-all}
.dshnotch_dot{display:inline-block;flex:none;width:8px;height:8px;margin-right:6px;border-radius:50%;vertical-align:middle}
.dshnotch_entry{display:flex;align-items:center;gap:8px;padding:7px 0;font-size:12px;line-height:1.5}
.dshnotch_entry+.dshnotch_entry{border-top:1px solid var(--dsw-alias-border-l2)}
.dshnotch_entryLabel{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dshnotch_entryMeta{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshnotch_empty{margin:0;padding:12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
`;

    /**
     * 语义名 → 实际类名。
     *
     * 集中在一处的理由很实际：类名拼错了**不会有任何报错**，只会静默变成
     * 没有样式的裸元素（"设置页看起来不太对"这种最难查）。`test/client.test.mjs`
     * 断言这里的每个值都出现在上面的 CSS 里，也断言 CSS 里的每个类都被用到。
     */
    const s = {
      section: 'dshnotch_section',
      heading: 'dshnotch_heading',
      cards: 'dshnotch_cards',
      card: 'dshnotch_card',
      cardOpen: 'dshnotch_cardOpen',
      header: 'dshnotch_header',
      headText: 'dshnotch_headText',
      name: 'dshnotch_name',
      description: 'dshnotch_description',
      chevron: 'dshnotch_chevron',
      chevronOpen: 'dshnotch_chevronOpen',
      pending: 'dshnotch_pending',
      body: 'dshnotch_body',
      field: 'dshnotch_field',
      head: 'dshnotch_head',
      label: 'dshnotch_label',
      badges: 'dshnotch_badges',
      badge: 'dshnotch_badge',
      hint: 'dshnotch_hint',
      invalid: 'dshnotch_invalid',
      input: 'dshnotch_input',
      inputInvalid: 'dshnotch_inputInvalid',
      switch: 'dshnotch_switch',
      footer: 'dshnotch_footer',
      failed: 'dshnotch_failed',
      button: 'dshnotch_button',
      discard: 'dshnotch_discard',
      save: 'dshnotch_save',
      value: 'dshnotch_value',
      valueMuted: 'dshnotch_valueMuted',
      dot: 'dshnotch_dot',
      entry: 'dshnotch_entry',
      entryLabel: 'dshnotch_entryLabel',
      entryMeta: 'dshnotch_entryMeta',
      empty: 'dshnotch_empty',
    };

    /**
     * 插入样式。幂等：`data-plugin-css` 就是同一个 DSH 原生 bundle 用的标记
     * （见 `dsh-client-ui-settings-plugins/lib/client.js` 顶部）。
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const selector = `style[data-plugin-css=${JSON.stringify(CSS_ID)}]`;
      if (document.querySelector(selector) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 通道：探测宿主端口 + 发请求
    // ────────────────────────────────────────────────────────────────────────

    /**
     * 建一个到宿主半边的通道。
     *
     * `probe()` 只认「协议版本对得上」的端口，所以**不会**误连其它同类插件
     * （它们可能占用别的端口段，且 `/v1/health` 形状不同）。
     *
     * @param opts.probeTimeoutMs 单端口探测超时。连接被拒是立刻失败的，这个
     *   超时只防"端口有人听但不回话"的情况。
     */
    function createChannel({ probeTimeoutMs = 600, requestTimeoutMs = 5000 } = {}) {
      let base = null;
      let port = 0;

      async function call(path, { method = 'GET', body, timeout = requestTimeoutMs } = {}) {
        if (base === null) throw new Error('尚未连接到宿主半边');
        const init = {
          method,
          cache: 'no-store',
          signal: AbortSignal.timeout(timeout),
          headers:
            method === 'GET'
              ? {}
              : { 'content-type': 'application/json', [NOTCH_HEADER]: NOTCH_HEADER_VALUE },
        };
        if (body !== undefined) init.body = JSON.stringify(body);

        const response = await fetch(base + path, init);
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok) {
          const error = new Error((payload && payload.message) || `HTTP ${response.status}`);
          // `code` 来自服务端的错误码表（config-rejected / feature-disabled / …），
          // 有它就顺着显示，没有就退回状态码。
          error.code = payload && payload.code;
          error.status = response.status;
          throw error;
        }
        return payload;
      }

      return {
        get base() {
          return base;
        },
        get port() {
          return port;
        },
        get connected() {
          return base !== null;
        },
        call,
        disconnect() {
          base = null;
          port = 0;
        },
        /** @returns 命中的 `{ port, base, health }`，一个都没命中则 `null`。 */
        async probe() {
          for (let index = 0; index < PORT_TRIES; index += 1) {
            const candidatePort = PORT_BASE + index;
            const candidateBase = `http://127.0.0.1:${candidatePort}`;
            try {
              const response = await fetch(candidateBase + ROUTE.health, {
                cache: 'no-store',
                signal: AbortSignal.timeout(probeTimeoutMs),
              });
              if (!response.ok) continue;
              const health = await response.json();
              if (!health || health.ok !== true) continue;
              if (health.protocol !== PROTOCOL_VERSION) continue;
              base = candidateBase;
              port = candidatePort;
              return { port: candidatePort, base: candidateBase, health };
            } catch (error) {
              // 端口没人听（ECONNREFUSED）是**预期**情况，不是错误：继续试下一个。
            }
          }
          base = null;
          port = 0;
          return null;
        },
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 跳转轮询
    // ────────────────────────────────────────────────────────────────────────

    /**
     * 轮询宿主的跳转队列并调用 `open(sessionId)`。
     *
     * 三条自我约束（沿用旧实现里正确的部分）：
     * 1. 任何异常都吞掉 —— 最坏情况是点击没反应，绝不能影响 DSH 本体；
     * 2. 失败要退避 —— 宿主没起来时不要每 500ms 刷一次日志；
     * 3. 可停止 —— 返回 `stop()`，插件卸载时干净收手。
     *
     * @param opts.open 执行跳转的回调（`sessionId => boolean`）。
     */
    function createJumpPoller({ channel, open, pollMs = COMMAND_POLL_MS, backoffMs = COMMAND_POLL_BACKOFF_MS }) {
      const state = { seq: 0, jumped: 0, failed: 0, probes: 0, lastError: null };
      let timer = null;
      let stopped = false;

      function schedule(delay) {
        if (stopped) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          void tick();
        }, delay);
      }

      async function tick() {
        if (stopped) return;

        if (!channel.connected) {
          state.probes += 1;
          const found = await channel.probe();
          if (stopped) return;
          if (found === null) {
            state.failed += 1;
            state.lastError = '未找到宿主半边';
            return schedule(backoffMs);
          }
        }

        try {
          const result = await channel.call(`${ROUTE.commands}?since=${state.seq}`);
          state.failed = 0;
          state.lastError = null;
          if (Array.isArray(result && result.jumps)) {
            for (const jump of result.jumps) {
              if (typeof jump?.sessionId !== 'string') continue;
              state.seq = Math.max(state.seq, Number(jump.seq) || 0);
              let ok = false;
              try {
                ok = open(jump.sessionId) === true;
              } catch (error) {
                ok = false;
              }
              if (ok) state.jumped += 1;
              else state.lastError = `无法切换到会话 ${jump.sessionId}`;
            }
          }
          state.seq = Math.max(state.seq, Number(result && result.seq) || 0);
          schedule(pollMs);
        } catch (error) {
          state.failed += 1;
          state.lastError = String(error && error.message ? error.message : error);
          // 拿不到 HTTP 状态码 = 网络层就断了（宿主进程退出 / 换了端口）→
          // 下次先重新探测端口。有状态码说明宿主还活着，不必重探。
          if (error && error.status === undefined) channel.disconnect();
          schedule(backoffMs);
        }
      }

      return {
        state,
        start() {
          if (stopped) return;
          schedule(0);
        },
        stop() {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
        },
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    // 焦点上报
    // ────────────────────────────────────────────────────────────────────────

    /**
     * 把「DSH 里当前选中的会话」上报给宿主，让岛高亮正确的条目。
     *
     * 数据源是 `ctx.sessions.list`（`dsh-client-runtime` 的 snapshot store，
     * `getSnapshot().current` 就是当前会话 id）。上报是**尽力而为**：
     * 失败不重试、不影响任何可见功能。
     */
    function createFocusReporter({
      ctx,
      channel,
      debounceMs = FOCUS_DEBOUNCE_MS,
      retryMs = FOCUS_RETRY_MS,
    } = {}) {
      const sessions = ctx && ctx.sessions;
      const store = sessions && sessions.list;
      if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') {
        return { stop() {}, supported: false };
      }

      const selection = sessions && sessions.selection;
      let uiWorkspace = null;
      try {
        uiWorkspace = ctx && ctx.uiWorkspace;
      } catch (error) {
        uiWorkspace = null;
      }
      if (!uiWorkspace) {
        try {
          uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
        } catch (error) {
          uiWorkspace = null;
        }
      }
      const workspaceSelection = uiWorkspace && uiWorkspace.selection;
      function readCurrent() {
        let current;
        try {
          current = store.getSnapshot().current;
        } catch (error) {
          current = undefined;
        }
        // 页面刚加载、list 还是 pending 时 `list.current` 是 undefined；
        // 此时持久化的 selection（uiWorkspace.selection / localStorage 的
        // dsh.sessions.current）才是用户当前看的会话。两条路都读不到才放弃。
        if ((current === undefined || current === null) && selection && typeof selection.getSnapshot === 'function') {
          try {
            current = selection.getSnapshot()?.sessionId;
          } catch (error) {
            current = undefined;
          }
        }
        if (
          (current === undefined || current === null) &&
          workspaceSelection &&
          typeof workspaceSelection.getSnapshot === 'function'
        ) {
          try {
            current = workspaceSelection.getSnapshot()?.sessionId;
          } catch (error) {
            current = undefined;
          }
        }
        if ((current === undefined || current === null) && globalThis.localStorage) {
          try {
            current = JSON.parse(globalThis.localStorage.getItem('dsh.sessions.current') || 'null')?.sessionId;
          } catch (error) {
            current = undefined;
          }
        }
        return current;
      }

      let timer = null;
      let retry = null;
      let last = null;
      let desired = null;
      let stopped = false;

      function send(current) {
        try {
          return channel.call(ROUTE.focus, { method: 'POST', body: { sessionId: String(current) } });
        } catch (error) {
          return Promise.reject(error);
        }
      }

      function flush() {
        if (stopped || desired === null) return;
        const current = desired;
        void send(current)
          .then(() => {
            if (desired === current) desired = null;
          })
          .catch(() => {
            if (stopped || desired !== current) return;
            // 宿主还没探测到（插件刚加载时最常见）。1s 后重试，直到成功
            // 或焦点又变了 —— 失败不能变成"永远不上报"。
            if (retry !== null) clearTimeout(retry);
            retry = setTimeout(() => {
              retry = null;
              flush();
            }, retryMs);
          });
      }

      function report(current) {
        if (stopped) return;
        if (current === undefined || current === null || current === last) return;
        last = current;
        desired = current;
        if (timer !== null) clearTimeout(timer);
        if (retry !== null) clearTimeout(retry);
        retry = null;
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, debounceMs);
      }

      const unsubscribe = store.subscribe(() => report(readCurrent()));
      const unsubscribeSelection =
        selection && typeof selection.subscribe === 'function'
          ? selection.subscribe(() => report(readCurrent()))
          : null;
      const unsubscribeWorkspace =
        workspaceSelection && typeof workspaceSelection.subscribe === 'function'
          ? workspaceSelection.subscribe(() => report(readCurrent()))
          : null;

      // 插件加载时当前会话已经选中，不会触发 subscribe 回调 —— 必须主动补报一次。
      const initial = readCurrent();
      report(initial);

      return {
        supported: true,
        stop() {
          stopped = true;
          if (typeof unsubscribe === 'function') unsubscribe();
          if (typeof unsubscribeSelection === 'function') unsubscribeSelection();
          if (typeof unsubscribeWorkspace === 'function') unsubscribeWorkspace();
          if (timer !== null) clearTimeout(timer);
          if (retry !== null) clearTimeout(retry);
          timer = null;
          retry = null;
        },
      };
    }

    /**
     * 真正执行跳转。
     *
     * DSH 桌面 0.2.x 的导航 API 是 `uiWorkspace.openSession(target)`
     * （`dsh-client-ui-workspace` 的 `UiWorkspaceService`）。`sessions` 服务
     * 只负责列表/对象层，没有 `open`；但不同版本/服务代理下仍可能有
     * `sessions.open` 或 `manager.select`，所以保留两级兜底。
     */
    function openSession(ctx, sessionId) {
      let uiWorkspace = null;
      try {
        uiWorkspace = ctx && ctx.uiWorkspace;
      } catch {
        uiWorkspace = null;
      }
      if (!uiWorkspace) {
        try {
          uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
        } catch {
          uiWorkspace = null;
        }
      }
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        try {
          uiWorkspace.openSession(sessionId);
          return true;
        } catch {
          /* 落到下面的兜底 */
        }
      }

      const attempts = [];
      const sessions = ctx && ctx.sessions;
      if (sessions) attempts.push(sessions);
      try {
        const service = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        if (service && service !== sessions) attempts.push(service);
      } catch {
        /* ignore */
      }

      for (const service of attempts) {
        if (service && typeof service.open === 'function') {
          try {
            service.open(sessionId);
            return true;
          } catch {
            /* 试 manager.select */
          }
        }
        // `open(id)` 的实现就是 `manager.select(id)`；服务代理只暴露数据属性时，
        // 这是同一条路径的显式写法。
        const manager = service && service.manager;
        if (manager && typeof manager.select === 'function') {
          try {
            manager.select(sessionId);
            return true;
          } catch {
            /* 下一个候选 */
          }
        }
      }

      return false;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 设置页字段
    // ────────────────────────────────────────────────────────────────────────

    /**
     * 字段表。顺序就是界面顺序，与 `ConfigSchema` 一一对应 ——
     * `test/client.test.mjs` 会断言这里不留漏键（schema 加了键却忘了加控件，
     * 用户就永远改不了它）。
     */
    const FIELDS = [
      {
        key: 'enabled',
        kind: 'switch',
        label: '启用灵动岛',
        hint: '关闭后岛不显示，也不会拉起岛 app。',
      },
      {
        key: 'hideWhenIdle',
        kind: 'switch',
        label: '空闲时隐藏',
        hint: '所有会话都不在执行中时把岛隐藏起来。',
      },
      {
        key: 'jumpEnabled',
        kind: 'switch',
        label: '允许点击跳转',
        hint: '点岛上的会话时，让 DSH 切换到该会话。',
      },
      {
        key: 'expandOnHover',
        kind: 'switch',
        label: '悬停展开',
        hint: '鼠标移到岛上时自动展开详情。',
      },
      {
        key: 'glowEffect',
        kind: 'switch',
        label: '发光效果',
        hint: '状态色的内外发光与呼吸动效。',
      },
      {
        key: 'autoLaunchApp',
        kind: 'switch',
        label: 'DSH 启动时自动拉起岛',
        hint: '已运行的实例会被单实例锁挡住，重复拉起无害。',
      },
      {
        key: 'appPath',
        kind: 'text',
        label: '岛 app 路径',
        hint: '留空则依次探测 %LOCALAPPDATA%\\dsh-notch-win\\DSHNotch.exe 与插件目录下的 app\\dist。',
        placeholder: 'C:\\path\\to\\DSHNotch.exe',
      },
      {
        key: 'scale',
        kind: 'number',
        label: '缩放',
        hint: '岛的整体缩放倍率，0.8 ~ 1.4。',
        min: 0.8,
        max: 1.4,
      },
    ];

    /** 客户端先校验一遍：错的值不该跑到 `settings.yaml` 里。宿主仍会再校验（400）。 */
    function fieldError(field, raw) {
      if (field.kind !== 'number') return null;
      const text = String(raw).trim();
      if (text === '') return '不能为空';
      const value = Number(text);
      if (!Number.isFinite(value)) return '必须是一个数字';
      if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`;
      if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`;
      return null;
    }

    /** 一个键是否相对已存值有改动（数字按数值比较，避免 `1` / `1.0` 误判）。 */
    function isDirty(field, staged, stored) {
      if (field.kind === 'switch') return staged === true !== (stored === true);
      const text = String(staged).trim();
      if (field.kind === 'number') {
        const value = Number(text);
        return Number.isFinite(value) ? value !== stored : true;
      }
      return text !== String(stored ?? '');
    }

    function toPatch(fields, dirtyKeys, config, staged) {
      const patch = {};
      for (const field of fields) {
        if (!dirtyKeys.includes(field.key)) continue;
        if (fieldError(field, staged[field.key]) !== null) continue;
        const raw = staged[field.key];
        if (field.kind === 'switch') patch[field.key] = raw === true;
        else if (field.kind === 'number') patch[field.key] = Number(String(raw).trim());
        else patch[field.key] = String(raw);
      }
      return patch;
    }

    const SOURCE_TEXT = {
      settings: 'settings.yaml（可持久化）',
      memory: '内存（settings 服务不可用，重启即丢失）',
      defaults: '默认值（settings 尚未挂载）',
    };

    // ────────────────────────────────────────────────────────────────────────
    // 组件
    // ────────────────────────────────────────────────────────────────────────

    function Chevron({ open }) {
      if (IconChevronDownOutline14) {
        return h(IconChevronDownOutline14, {
          className: open ? `${s.chevron} ${s.chevronOpen}` : s.chevron,
        });
      }
      return h(
        'svg',
        {
          className: open ? `${s.chevron} ${s.chevronOpen}` : s.chevron,
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M3.5 5.5 7 9l3.5-3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /** 折叠卡片，结构照抄 DSH 原生插件卡片（`li.card` → `button.header` → `div.body`）。 */
    function Card({ title, description, open, onToggle, pending, children }) {
      return h(
        'li',
        { className: open ? `${s.card} ${s.cardOpen}` : s.card },
        h(
          'button',
          {
            type: 'button',
            className: s.header,
            'aria-expanded': open,
            onClick: onToggle,
          },
          h(
            'span',
            { className: s.headText },
            h('span', { className: s.name }, title),
            description === null ? null : h('span', { className: s.description }, description),
          ),
          pending === null ? null : h('span', { className: s.pending }, pending),
          h(Chevron, { open }),
        ),
        open === true ? h('div', { className: s.body }, children) : null,
      );
    }

    /** 开关。原生卡片没有布尔控件，所以这个是本插件自己的，但沿用同一套令牌与尺寸。 */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        className: s.switch,
        disabled: disabled === true,
        onClick: () => onChange(checked !== true),
      });
    }

    /**
     * 一行字段。DOM 结构与原生 `ValueField` 一致：
     * `div.field` → `div.head`(label + badges) → 控件 → `p.hint|invalid`。
     */
    function Field({ label, dirty, hint, error, control, children }) {
      const message = error !== null ? error : hint;
      return h(
        'div',
        { className: s.field },
        h(
          'div',
          { className: s.head },
          h('span', { className: s.label }, label),
          dirty === true ? h('span', { className: s.badges }, h('span', { className: s.badge }, '未保存')) : null,
          control === undefined ? null : control,
        ),
        children === undefined ? null : children,
        message === null || message === undefined
          ? null
          : h('p', { className: error !== null ? s.invalid : s.hint }, message),
      );
    }

    /** 只读的一行诊断信息。 */
    function Info({ label, value, muted }) {
      return h(
        'div',
        { className: s.field },
        h('div', { className: s.head }, h('span', { className: s.label }, label)),
        h('p', { className: muted === true ? s.valueMuted : s.value }, value),
      );
    }

    /**
     * 设置页主体。挂载期间按 `STATE_POLL_IDLE_MS` 拉 `/v1/state`
     * （设置页是诊断视图，不需要岛那种 250ms 的实时性）。
     */
    function SettingsTab({ channel }) {
      const [link, setLink] = useState({ state: 'probing', port: 0, error: null });
      const [snapshot, setSnapshot] = useState(null);
      const [staged, setStaged] = useState({});
      const [saving, setSaving] = useState(false);
      const [failed, setFailed] = useState(null);
      const [openSettings, setOpenSettings] = useState(true);
      const [openRuntime, setOpenRuntime] = useState(false);

      useEffect(() => {
        let cancelled = false;
        let timer = null;

        const tick = async () => {
          if (cancelled) return;

          if (!channel.connected) {
            const found = await channel.probe();
            if (cancelled) return;
            if (found === null) {
              setLink({ state: 'absent', port: 0, error: '没有找到宿主半边的回环端口' });
              timer = setTimeout(() => void tick(), COMMAND_POLL_BACKOFF_MS);
              return;
            }
            setLink({ state: 'ready', port: found.port, error: null });
          }

          try {
            const next = await channel.call(ROUTE.state);
            if (cancelled) return;
            setSnapshot(next);
            setLink({ state: 'ready', port: channel.port, error: null });
          } catch (error) {
            if (cancelled) return;
            channel.disconnect();
            setLink({
              state: 'absent',
              port: 0,
              error: `与宿主半边的连接已断开：${String(error && error.message ? error.message : error)}`,
            });
          }
          timer = setTimeout(() => void tick(), STATE_POLL_IDLE_MS);
        };

        void tick();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [channel]);

      const config = snapshot && snapshot.config ? snapshot.config : null;
      const runtime = snapshot && snapshot.runtime ? snapshot.runtime : null;
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      const liveCount = entries.filter((entry) => entry.live === true).length;

      const valueOf = useCallback(
        (field) => {
          if (config === null) return field.kind === 'switch' ? false : '';
          if (Object.prototype.hasOwnProperty.call(staged, field.key)) return staged[field.key];
          const stored = config[field.key];
          return field.kind === 'switch' ? stored === true : String(stored === undefined ? '' : stored);
        },
        [config, staged],
      );

      const dirtyKeys = useMemo(() => {
        if (config === null) return [];
        return FIELDS.filter((field) =>
          Object.prototype.hasOwnProperty.call(staged, field.key)
            ? isDirty(field, staged[field.key], config[field.key])
            : false,
        ).map((field) => field.key);
      }, [config, staged]);

      const preflightError = useMemo(() => {
        for (const field of FIELDS) {
          if (!dirtyKeys.includes(field.key)) continue;
          const message = fieldError(field, staged[field.key]);
          if (message !== null) return `${field.label}：${message}`;
        }
        return null;
      }, [dirtyKeys, staged]);

      const edit = (field, value) => {
        setStaged((previous) => ({ ...previous, [field.key]: value }));
        setFailed(null);
      };

      const save = async () => {
        setSaving(true);
        setFailed(null);
        try {
          const result = await channel.call(ROUTE.config, {
            method: 'POST',
            body: { patch: toPatch(FIELDS, dirtyKeys, config, staged) },
          });
          setStaged({});
          if (result && result.config) {
            // 立刻把返回值并进快照：不必等下一次轮询，避免"保存了但界面没变"的错觉。
            setSnapshot((previous) =>
              previous
                ? { ...previous, config: result.config, configSource: result.configSource }
                : previous,
            );
          }
        } catch (error) {
          setFailed(String(error && error.message ? error.message : error));
        } finally {
          setSaving(false);
        }
      };

      const blocked = dirtyKeys.length === 0 || preflightError !== null || saving;

      const renderField = (field) => {
        const error = dirtyKeys.includes(field.key) ? fieldError(field, staged[field.key]) : null;
        const dirty = dirtyKeys.includes(field.key);

        if (field.kind === 'switch') {
          return h(
            Field,
            {
              key: field.key,
              label: field.label,
              hint: field.hint,
              dirty,
              error,
              control: h(Switch, {
                checked: valueOf(field) === true,
                disabled: saving || config === null,
                label: field.label,
                onChange: (next) => edit(field, next),
              }),
            },
            null,
          );
        }

        return h(
          Field,
          {
            key: field.key,
            label: field.label,
            hint: field.hint,
            dirty,
            error,
          },
          h('input', {
            className: error !== null ? `${s.input} ${s.inputInvalid}` : s.input,
            type: 'text',
            ...(field.kind === 'number' ? { inputMode: 'numeric' } : {}),
            ...(error !== null ? { 'aria-invalid': true } : {}),
            value: valueOf(field),
            placeholder: field.placeholder === undefined ? '' : field.placeholder,
            disabled: saving || config === null,
            onChange: (event) => edit(field, event.target.value),
          }),
        );
      };

      const linkText =
        link.state === 'ready'
          ? `127.0.0.1:${link.port} · 已连接`
          : link.state === 'probing'
            ? '正在连接…'
            : '未连接（重试中）';

      return h(
        'div',
        { className: s.section },
        h('h2', { className: s.heading }, '插件配置'),
        h(
          'ul',
          { className: s.cards },
          h(Card, {
            key: 'settings',
            title: '灵动岛',
            description:
              config === null
                ? '正在读取配置…'
                : `状态由 DSH 宿主进程计算，岛只负责显示 · 配置来源：${SOURCE_TEXT[snapshot.configSource] ?? snapshot.configSource}`,
            open: openSettings,
            onToggle: () => setOpenSettings((value) => value !== true),
            pending: dirtyKeys.length > 0 ? `${dirtyKeys.length} 项未保存` : null,
          }, [
            ...FIELDS.map(renderField),
            h(
              'div',
              { key: 'footer', className: s.footer },
              failed === null ? null : h('p', { className: s.failed }, failed),
              preflightError === null ? null : h('p', { className: s.failed }, preflightError),
              h(
                'button',
                {
                  type: 'button',
                  className: `${s.button} ${s.discard}`,
                  disabled: dirtyKeys.length === 0 || saving,
                  onClick: () => {
                    setStaged({});
                    setFailed(null);
                  },
                },
                '丢弃',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: `${s.button} ${s.save}`,
                  disabled: blocked,
                  onClick: () => void save(),
                },
                saving ? '保存中…' : '保存',
              ),
            ),
          ]),
          h(
            Card,
            {
              key: 'runtime',
              title: '运行状态',
              description: '宿主半边 ↔ 岛 app 的通道与运行时诊断',
              open: openRuntime,
              onToggle: () => setOpenRuntime((value) => value !== true),
              pending: link.state === 'ready' ? null : '未连接',
            },
            [
              h(Info, { key: 'link', label: '回环通道', value: linkText, muted: link.state !== 'ready' }),
              link.error === null ? null : h(Info, { key: 'linkerr', label: '通道错误', value: link.error }),
              h(Info, {
                key: 'source',
                label: '配置来源',
                value: snapshot === null ? '(未知)' : String(SOURCE_TEXT[snapshot.configSource] ?? snapshot.configSource),
              }),
              h(Info, {
                key: 'sessions',
                label: '追踪中的会话',
                value: snapshot === null ? '(等待状态)' : `${entries.length} 条 · 有 ${liveCount} 条在执行`,
              }),
              snapshot === null
                ? null
                : h(
                    'div',
                    { key: 'entries', className: s.field },
                    entries.length === 0
                      ? h('p', { className: s.empty }, '当前没有会话。随便发一条消息就会出现在这里。')
                      : entries.map((entry) =>
                          h(
                            'div',
                            { key: entry.id, className: s.entry },
                            h('span', {
                              className: s.dot,
                              style: { background: entry.glow || STATUS_COLOR[entry.status] || STATUS_COLOR.idle },
                            }),
                            h('span', { className: s.entryLabel }, entry.label),
                            h(
                              'span',
                              { className: s.entryMeta },
                              entry.detailText ? entry.detailText : entry.status,
                            ),
                          ),
                        ),
                  ),
              runtime === null
                ? null
                : h(Info, { key: 'pid', label: '宿主进程', value: `pid ${runtime.pid}` }),
              runtime === null
                ? null
                : h(Info, {
                    key: 'protocol',
                    label: '协议版本',
                    value: `v${runtime.protocol}${snapshot.v === undefined ? '' : ` · 快照 v${snapshot.v}`}`,
                  }),
              runtime === null
                ? null
                : h(Info, {
                    key: 'app',
                    label: '岛 app',
                    value:
                      runtime.appExe === null || runtime.appExe === undefined
                        ? '(未找到：请在上方填写「岛 app 路径」)'
                        : runtime.appExe,
                    muted: runtime.appExists !== true,
                  }),
              runtime === null || runtime.settingsError === null
                ? null
                : h(Info, { key: 'settingsError', label: '设置注册错误', value: runtime.settingsError }),
              runtime === null
                ? null
                : h(Info, { key: 'log', label: '宿主日志', value: runtime.logFile ?? '(未知)' }),
            ],
          ),
        ),
      );
    }

    // ────────────────────────────────────────────────────────────────────────
    // apply
    // ────────────────────────────────────────────────────────────────────────

    const inject = ['slots', 'sessions', 'uiWorkspace'];

    function apply(ctx) {
      try {
        ensureStyles();
      } catch (error) {
        // 样式挂不上不致命：只是不好看，功能照常。
      }

      const channel = createChannel();

      const jumpPoller = createJumpPoller({
        channel,
        open: (sessionId) => openSession(ctx, sessionId),
      });
      const focusReporter = createFocusReporter({ ctx, channel });

      ctx.effect(
        () => {
          jumpPoller.start();
          return () => {
            jumpPoller.stop();
            focusReporter.stop();
          };
        },
        'dsh-notch-win: 跳转轮询与焦点上报',
      );

      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;

      ctx.slots.inject(
        'settings.plugins.tab',
        () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              // `id` 必须是自己独有的：复用 DSH 自带 tab 的 id（'all' / 'configurable'）
              // 会**替换**那个 tab 而不是并列一个。`label` 是 tab 上的文字，
              // 契约里是 `string | (() => string)`；本插件只有一个中文界面，
              // 没有注册 locale 字典，所以直接给字符串。
              id: PLUGIN_ID,
              order: 50,
              label: '灵动岛',
            },
            () => h(SettingsTab, { channel }),
          ),
        'dsh-notch-win: 设置页',
      );
    }

    exports.FIELDS = FIELDS;
    exports.SettingsTab = SettingsTab;
    exports.apply = apply;
    exports.inject = inject;
    exports.createChannel = createChannel;
    exports.createFocusReporter = createFocusReporter;
    exports.createJumpPoller = createJumpPoller;
    return module.exports;
  },
});
