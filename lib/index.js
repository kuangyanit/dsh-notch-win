/**
 * @module @dsh-external/dsh-notch-win
 *
 * Windows 灵动岛的**宿主半边**。这是「方案 A」的落点：状态在这里算，岛那边
 * 只负责画。
 *
 * 职责：
 * 1. 订阅 DSH 自己的 `agent/status` 与 `session/event`，在内存里累加状态。
 * 2. 加载时做一次**采纳扫描**（热重载不会重放 `agent/created`）。
 * 3. 起一个只绑 `127.0.0.1` 的回环 HTTP，同时服务岛 app 与插件自己的渲染半边。
 * 4. 把配置注册进 DSH 原生 settings（`~/.dsh/settings.yaml`）。
 * 5. 拉起已存在的岛 app 可执行文件（**不做**下载/校验/安装/自更新）。
 *
 * 不做什么（刻意，避免旧实现的问题再长出来）：
 * - 不读任何会话文件（zstd / jsonl / projection cache）；
 * - 不做 mtime 启发式或扫描缓存；
 * - 不新增配置文件（配置只在 settings.yaml）；
 * - 不往会话日志里写自定义事件。
 *
 * ## 为什么没有 `export const inject`
 *
 * 旧实现写了 `export const inject = ['settings']` **并且**在 apply 里直接取
 * `ctx.settings` 属性，结果拿到 `undefined`（每次启动都落 `settings 服务不可用`）。
 * 正确写法是 `ctx.inject(['settings'], settingsCtx => ...)`（DSH 自己的
 * `dsh-client-ui-theme` 就是这么写的）。
 *
 * 这里刻意**不**导出 `inject`：一旦声明，`settings` 服务永久缺席时整个插件会永远
 * 卡在 pending，岛也就不工作了。用 `ctx.inject` 的局部注入，apply 立刻跑，
 * settings 迟到或不到都能降级工作。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import * as P from './protocol.js';
import { ConfigSchema, NS, createConfigStore } from './config.js';
import { islandAppEnv } from './launch.js';
import { createLog } from './log.js';
import {
  appExeCandidates,
  dataDir,
  endpointFilePath,
  resolveAppExe,
} from './paths.js';
import { createServer } from './server.js';
import { buildStable, createState, ingest, revOf, shortId, tick } from './state.js';

export const name = '@dsh-external/dsh-notch-win';

export { ConfigSchema as Config, NS };

export function apply(ctx, config) {
  const log = createLog();

  const settingsAtApply = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  log.info(`加载 · pid ${process.pid} · node ${process.version} · protocol v${P.PROTOCOL_VERSION}`);
  log.info(
    `settings 服务在 apply 时刻${settingsAtApply ? '可用' : '不可用'}（不可用只影响配置持久化，岛本体照常）`,
  );

  const state = createState();
  const store = createConfigStore({ log });
  const startedAt = Date.now();

  let stable = null;
  let rev = null;
  let computeAt = 0;
  let appExe = null;
  let appWanted = false;
  let settingsError = null;
  let endpointWritten = null;
  let server = null;

  // DSH 0.2.x：配置由 profile 条目持久化，cordis 在 `apply(ctx, config)` 时把它
  // 作为第二参数交进来。先播种，后面的 syncApp() 才能尊重用户的 enabled /
  // autoLaunchApp / appPath。非法存量值只降级、不阻断加载。
  try {
    if (store.seed(config)) log.info('配置来自宿主 profile 条目');
  } catch (error) {
    settingsError = String(error?.message ?? error);
    log.warn('宿主交来的配置未通过 schema，退回默认值：', error);
  }

  const jumps = [];
  let jumpSeq = 0;

  /** 让下一次状态读取强制重算（配置变更、焦点变更后调用）。 */
  function invalidate() {
    computeAt = 0;
  }

  function safely(what, fn) {
    try {
      fn();
    } catch (error) {
      // 事件是 emit 模式：异常本来就会被 DSH 的 logger 吞掉。我们自己吞，
      // 是为了保证状态机不会留下"改了一半"的条目。
      log.warn(`${what} 抛出（已吞掉）：`, error);
    }
  }

  function agentIdOf(payload) {
    const id = payload?.agent?.id ?? payload?.id;
    return id === undefined || id === null ? null : String(id);
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  // `agent/status` 是 Scope 过滤派发（`Scoped<Agent>`），必须显式要全局，
  // 否则收不到别的 agent 的状态转换。
  ctx.on(
    'agent/status',
    (payload) => {
      safely('agent/status', () => {
        const agentId = agentIdOf(payload);
        if (agentId === null) return;
        const status = payload?.status ?? payload?.agent?.status;
        ingest(state, { kind: 'status', agentId, status }, Date.now());
      });
    },
    { global: true },
  );

  ctx.on(
    'agent/created',
    (payload) => {
      safely('agent/created', () => {
        const agentId = agentIdOf(payload);
        if (agentId === null) return;
        ingest(state, { kind: 'created', agentId }, Date.now());
      });
    },
    { global: true },
  );

  ctx.on(
    'agent/disposed',
    (payload) => {
      safely('agent/disposed', () => {
        const agentId = agentIdOf(payload);
        if (agentId === null) return;
        ingest(state, { kind: 'disposed', agentId });
      });
    },
    { global: true },
  );

  // 同步、无 I/O、绝不抛。负载在 `event.data` 下（`SessionEvent = {type, seq, time, data}`）。
  ctx.on('session/event', (session, event) => {
    safely('session/event', () => {
      const id = session?.id ?? event?.sessionId;
      if (id === undefined || id === null) return;
      ingest(state, { kind: 'event', sessionId: String(id), event }, Date.now());
    });
  });

  // -------------------------------------------------------------------------
  // 采纳扫描（必须在挂完 listener 之后，避免窗口期丢事件）
  // -------------------------------------------------------------------------

  /**
   * 读服务，但**不触发 cordis 的 inject 校验**。
   *
   * DSH 0.2.x 用的是 cordis 4.0.5：`ctx.agents` / `ctx.sessions` 这类属性访问
   * 如果在插件 `inject` 里没声明，会抛 `cannot get property "agents" without inject`
   * （不是返回 undefined）。`ctx.get(name)` 是官方的“无 inject 读取”入口，服务没
   * 就绪时返回 undefined —— 正好适合“插件照常加载、富化能力晚点到”的取舍。
   */
  function service(name) {
    try {
      return ctx.get(name) ?? null;
    } catch {
      return null;
    }
  }

  let swept = false;
  let sweepDeferredLogged = false;

  function sweep() {
    const agentService = service('agents');
    if (!agentService) {
      if (!sweepDeferredLogged) {
        sweepDeferredLogged = true;
        log.info('agents 服务尚未就绪，采纳扫描延后到下一次快照');
      }
      return;
    }
    let agents;
    try {
      agents = agentService.list?.() ?? [];
    } catch (error) {
      log.warn('采纳扫描失败（agents.list）：', error);
      return;
    }
    swept = true;
    const now = Date.now();
    let running = 0;
    for (const agent of agents) {
      if (!agent || agent.id === undefined || agent.id === null) continue;
      const agentId = String(agent.id);
      ingest(state, { kind: 'created', agentId }, now);
      ingest(state, { kind: 'status', agentId, status: agent.status }, now);
      if (agent.status === 'running') running += 1;
    }
    log.info(`采纳扫描：${agents.length} 个 agent（running ${running} 个）`);
  }

  sweep();

  // -------------------------------------------------------------------------
  // 富化：子代理计数 + cwd 兜底标题
  // -------------------------------------------------------------------------

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function enrich(now) {
    const sessionService = service('sessions');
    if (!sessionService) return;
    let sessions;
    try {
      sessions = sessionService.list?.() ?? [];
    } catch (error) {
      log.warn('读取 sessions.list 失败：', error);
      return;
    }
    const agentService = service('agents');
    const titleService = service('sessionTitle');
    const projectionService = service('sessionProjections');
    const sessionsById = new Map();
    for (const session of sessions) {
      if (session && session.id !== undefined && session.id !== null) {
        sessionsById.set(String(session.id), session);
      }
    }

    // 一遍扫完，算出"每个父会话有几个 running 的子代理"。
    const runningChildren = new Map();
    for (const session of sessions) {
      const header = session?.header;
      if (!header || header.origin !== 'subagent') continue;
      const parent = header.parentSession;
      if (typeof parent !== 'string') continue;
      let running = false;
      try {
        running = agentService?.get?.(session.id)?.status === 'running';
      } catch {
        running = false;
      }
      if (running) runningChildren.set(parent, (runningChildren.get(parent) ?? 0) + 1);
    }

    for (const [id, entry] of [...state.sessions]) {
      const want = runningChildren.get(id) ?? 0;
      if (entry.subagentRunning !== want) {
        ingest(state, { kind: 'meta', sessionId: id, subagentRunning: want }, now);
      }
      const session = sessionsById.get(id);
      // 工作区标签：DSH 侧栏的工作区默认就是 cwd 末段目录名。完整路径留给 tooltip。
      const workspace = workspaceOf(session);
      if (workspace !== null) {
        ingest(
          state,
          { kind: 'meta', sessionId: id, workspace: workspace.name, workspacePath: workspace.path },
          now,
        );
      }
      // 上下文占用 / 累计 token / 轮次步骤回填：token-meter 的 contextPressure
      // 投影给出占用分子分母，tokenUsage 给出累计量与最近一轮，
      // sessionStats/turnBoundary 补轮次。
      if (session) {
        let values = null;
        try {
          values = projectionService?.snapshot?.(session)?.values ?? null;
        } catch {
          values = null;
        }
        const pressure = values?.contextPressure;
        if (pressure) {
          const tokens = pressure.projectedTokens ?? pressure.pressureTokens;
          if (typeof tokens === 'number' || typeof pressure.contextWindow === 'number') {
            ingest(
              state,
              { kind: 'meta', sessionId: id, contextTokens: tokens, contextLimit: pressure.contextWindow },
              now,
            );
          }
        }
        // 会话累计 token：tokenUsage 投影的 wire view 就是 totals 四项。主数字
        // 按 provider 口径给“全部处理量”：未缓存输入 + 输出 + 缓存读写。
        const usage = values?.tokenUsage;
        if (usage && typeof usage === 'object') {
          const uncached = numberOrNull(usage.uncachedInputTokens);
          const output = numberOrNull(usage.outputTokens);
          const cacheRead = numberOrNull(usage.cacheReadTokens);
          const cacheWrite = numberOrNull(usage.cacheWriteTokens);
          if (uncached !== null && output !== null) {
            ingest(
              state,
              {
                kind: 'meta',
                sessionId: id,
                tokenTotal: uncached + output + (cacheRead ?? 0) + (cacheWrite ?? 0),
                tokenInput: uncached,
                tokenOutput: output,
                tokenCacheRead: cacheRead,
                tokenCacheWrite: cacheWrite,
              },
              now,
            );
          }
        }
        if (entry.turn === null) {
          const outlineTurns = values?.turnOutline?.turns;
          const lastOutlineTurn =
            Array.isArray(outlineTurns) && outlineTurns.length > 0
              ? outlineTurns[outlineTurns.length - 1]?.turn
              : null;
          const turn =
            values?.sessionStats?.lastTurn ??
            lastOutlineTurn ??
            values?.tokenUsage?.last?.turn;
          if (typeof turn === 'number' && Number.isFinite(turn)) {
            entry.turn = turn;
            entry.updatedAt = now;
          }
        }
        if (entry.turn !== null && entry.step === null) {
          const step = values?.tokenUsage?.last?.step;
          if (typeof step === 'number' && Number.isFinite(step)) entry.step = step;
        }
      }
      // 宿主重启后焦点会补建空条目；从会话日志补回最近一轮的轮次/工具数。
      // 每个条目只折一次；后续变化由实时 session/event 驱动。
      if (session && entry.historyChecked !== true) {
        entry.historyChecked = true;
        const history = historyOf(session);
        if (history !== null) {
          if (entry.turn === null && history.turn !== null) entry.turn = history.turn;
          if (entry.step === null && history.step !== null) entry.step = history.step;
          if (entry.toolCount === 0) entry.toolCount = history.toolCount;
          entry.updatedAt = now;
        }
      }
      // DSH 侧栏显示的会话标题优先于首条用户消息 / cwd。只在还没拿到标题时
      // 折一次事件日志（`sessionTitle.get` 是 O(events)，不必每拍都做）。
      if (entry.labelSource !== 'title') {
        let title = null;
        try {
          title = session ? titleService?.get?.(session)?.title ?? null : null;
        } catch {
          title = null;
        }
        if (typeof title === 'string' && title !== '') {
          ingest(state, { kind: 'meta', sessionId: id, label: title, labelSource: 'title' }, now);
        }
      }
      if (entry.label === null) {
        const label = workspace !== null ? workspace.name : null;
        if (label !== null) {
          ingest(state, { kind: 'meta', sessionId: id, label, labelSource: 'cwd' }, now);
        }
      }
    }
  }

  /** 工作区名 = cwd 末段（DSH 侧栏的默认工作区标题）；没有 cwd 就没有标签。 */
  function workspaceOf(session) {
    const cwd = session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.trim() === '') return null;
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return base ? { name: base, path: cwd } : null;
  }

  /** 这个版本的 Session 可能用 log / eventsSnapshot 暴露事件，不一定是 events。 */
  function sessionEvents(session) {
    for (const candidate of [session?.events, session?.eventsSnapshot, session?.log]) {
      if (Array.isArray(candidate)) return candidate;
    }
    return null;
  }

  /** 从会话日志补回最近一轮的 turn/step/toolCount（只在条目还没有 turn 时调用）。 */
  function historyOf(session) {
    const events = sessionEvents(session);
    if (events === null) return null;
    let turn = null;
    let step = null;
    let toolCount = 0;
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'turn/start') {
        if (typeof data.turn === 'number' && Number.isFinite(data.turn)) {
          turn = data.turn;
          step = null;
          toolCount = 0;
        }
      } else if (event.type === 'step/start') {
        if (typeof data.step === 'number' && Number.isFinite(data.step)) step = data.step;
      } else if (event.type === 'tool/call') {
        toolCount += 1;
      }
    }
    if (turn === null && step === null && toolCount === 0) return null;
    return { turn, step, toolCount };
  }

  // -------------------------------------------------------------------------
  // 快照与节流
  // -------------------------------------------------------------------------

  function buildEnv() {
    return {
      pid: process.pid,
      port: server?.port ?? 0,
      startedAt,
      appExe,
      appExists: appExe !== null,
      logFile: log.path,
      settingsError,
      config: store.config,
      configSource: store.source,
    };
  }

  /**
   * 重算快照。**没有定时器**：只在被读取时按 `PUBLISH_THROTTLE_MS` 节流重算，
   * 因此空闲时宿主的 CPU 占用是零，而对外看到的最坏陈旧度仍是 150ms。
   */
  function refresh(now) {
    // agents 服务可能在 apply 之后才就绪；每拍快照前补一次采纳扫描，
    // 保证“DSH 启动时就已在跑的会话”不需要等下一个事件才出现。
    if (!swept) sweep();
    tick(state, now);
    enrich(now);
    const next = buildStable(state, buildEnv());
    computeAt = now;
    const nextRev = revOf(next);
    if (nextRev === rev) return false;
    stable = next;
    rev = nextRev;
    return true;
  }

  function wire(sinceRev) {
    const now = Date.now();
    if (stable === null || now - computeAt >= P.PUBLISH_THROTTLE_MS) refresh(now);
    if (typeof sinceRev === 'string' && sinceRev !== '' && sinceRev === rev) {
      return { unchanged: true, rev };
    }
    return { ...stable, rev };
  }

  // -------------------------------------------------------------------------
  // 跳转队列
  // -------------------------------------------------------------------------

  function pruneJumps(now) {
    while (jumps.length > 0 && now - jumps[0].at > P.JUMP_TTL_MS) jumps.shift();
  }

  function enqueueJump(sessionId) {
    const now = Date.now();
    pruneJumps(now);
    const duplicate = jumps.find(
      (item) => item.sessionId === sessionId && now - item.at < P.JUMP_DEDUPE_MS,
    );
    if (duplicate) return duplicate.seq;
    jumpSeq += 1;
    jumps.push({ seq: jumpSeq, sessionId, at: now });
    if (jumps.length > P.JUMP_RING_CAP) jumps.splice(0, jumps.length - P.JUMP_RING_CAP);
    return jumpSeq;
  }

  function rejected(message, code = P.ERR.badRequest) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  server = createServer({
    log,
    handlers: {
      async health() {
        const snapshot = wire();
        const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
        return {
          pid: process.pid,
          protocol: P.PROTOCOL_VERSION,
          version: P.PLUGIN_VERSION,
          rev: snapshot.rev,
          entries: entries.length,
          live: entries.filter((entry) => entry.live).length,
          appExists: appExe !== null,
          // 0.2.x 没有可写的 settings scope，但配置确实来自 profile 条目
          // （apply 的第二参数）—— 这种也要如实标成 settings。
          settings:
            store.available || store.source === 'settings'
              ? store.source
              : 'unavailable',
        };
      },

      async state(sinceRev) {
        return wire(sinceRev);
      },

      async commands(since) {
        const now = Date.now();
        pruneJumps(now);
        return {
          seq: jumpSeq,
          config: store.config,
          configSource: store.source,
          jumps: jumps
            .filter((item) => item.seq > since)
            .map((item) => ({ seq: item.seq, sessionId: item.sessionId })),
        };
      },

      async jump(body) {
        if (!store.config.jumpEnabled) {
          throw rejected('跳转已在设置里关闭', P.ERR.featureDisabled);
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        if (sessionId === '') throw rejected('缺少 sessionId');
        const seq = enqueueJump(sessionId);
        // 点击会话行既是跳转，也是对“已完成/已停止”的确认。
        ingest(state, { kind: 'ack', sessionId }, Date.now());
        invalidate();
        log.info(`跳转入队 seq=${seq} session=${shortId(sessionId)}`);
        return { ok: true, seq };
      },

      async focus(body) {
        const sessionId = body?.sessionId == null ? null : String(body.sessionId);
        log.info(`焦点上报 session=${sessionId === null ? 'null' : shortId(sessionId)}`);
        ingest(state, { kind: 'focus', sessionId }, Date.now());
        invalidate();
        return { ok: true };
      },

      async ack(body) {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
        if (sessionId === '') throw rejected('缺少 sessionId');
        const changed = ingest(state, { kind: 'ack', sessionId }, Date.now());
        if (changed) invalidate();
        return { ok: true };
      },

      async config(body) {
        const patch = body?.patch ?? body;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw rejected('patch 必须是对象');
        }
        try {
          const result = await store.set(patch);
          log.info(
            `配置写入 ${Object.keys(patch).join(',') || '(空)'} · persisted=${result.persisted}`,
          );
          return {
            ok: true,
            config: result.config,
            configSource: result.persisted ? 'settings' : 'memory',
          };
        } catch (error) {
          throw rejected(error?.message ?? '配置被拒绝', P.ERR.configRejected);
        }
      },
    },
  });

  // -------------------------------------------------------------------------
  // 端点文件与岛 app
  // -------------------------------------------------------------------------

  function writeEndpoint() {
    const file = endpointFilePath(process.pid);
    const payload = JSON.stringify({
      protocol: P.PROTOCOL_VERSION,
      version: P.PLUGIN_VERSION,
      port: server.port,
      pid: process.pid,
      startedAt,
    });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, payload, 'utf8');
    fs.renameSync(temporary, file);
    return file;
  }

  function launchApp() {
    if (appExe === null) return;
    // 测试/无头环境用：不让宿主拉起真实窗口。见 test/host.test.mjs。
    if (process.env.DSH_NOTCH_NO_LAUNCH === '1') {
      log.info(`DSH_NOTCH_NO_LAUNCH=1，跳过拉起岛 app（${appExe}）`);
      return;
    }
    try {
      const launchedAt = Date.now();
      const child = spawn(appExe, [], {
        detached: true,
        stdio: 'ignore',
        // 把数据目录显式交给子进程；同时去掉 ELECTRON_RUN_AS_NODE（见 lib/launch.js，
        // 否则 Electron 以纯 Node 模式跑 main.js，进程秒退、窗口永远不出现）。
        env: islandAppEnv(process.env, dataDir()),
      });
      child.on('error', (error) => log.warn('拉起岛 app 失败：', error));
      // 关键诊断：`spawn` 成功 ≠ 窗口出现。之前"日志写着已拉起、但哪都看不到"
      // 就是因为子进程 200ms 后以纯 Node 模式退出，而这里没有任何人记录它退出了。
      child.on('exit', (code, signal) => {
        const lived = Date.now() - launchedAt;
        if (lived < 3000) {
          log.warn(
            `岛 app 启动后只活了 ${lived}ms 就退出（code=${code}${signal ? `, signal=${signal}` : ''}）—— ` +
              '若它曾在前台正常显示过，先检查宿主环境里的 ELECTRON_RUN_AS_NODE / 文件沙箱；' +
              '否则看 Windows 事件日志里的 Application Error（0x80000003 之类）。',
          );
        } else {
          log.info(`岛 app 已退出（code=${code}${signal ? `, signal=${signal}` : ''} · 运行 ${Math.round(lived / 1000)}s）`);
        }
      });
      child.unref();
      log.info(`已拉起岛 app：${appExe}`);
    } catch (error) {
      log.warn('拉起岛 app 抛出：', error);
    }
  }

  function syncApp() {
    appExe = resolveAppExe(store.config.appPath);
    const want = store.config.enabled && store.config.autoLaunchApp;
    if (want && !appWanted) {
      if (appExe === null) {
        log.warn(
          `未找到岛 app。已探测：${appExeCandidates(store.config.appPath).join(' | ')}；` +
            '可在设置页填写 appPath',
        );
      } else {
        launchApp();
      }
    }
    appWanted = want;
    log.info(`岛 app：${appExe ?? '(未找到)'} · enabled=${store.config.enabled}`);
  }

  store.on(() => {
    invalidate();
    syncApp();
  });

  // -------------------------------------------------------------------------
  // settings 注册（迟到的服务；写法见文件头注释）
  // -------------------------------------------------------------------------

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings;
    // DSH 0.2.x 的 settings 服务是 `SettingsForms`：没有 `register`，插件表单由
    // DSH 读取插件导出的 `Config` 自动生成。这里直接跳过手动注册，配置已经由
    // apply 的第二参数播种过了（见上方 store.seed）。
    if (typeof settings?.register !== 'function') {
      settingsError = null;
      log.info('settings 0.2.x：表单由 DSH 依据导出的 Config 自动生成，跳过手动注册');
      return;
    }
    try {
      const scope = settings.register(NS, ConfigSchema, { base: config || {} });
      settingsError = null;
      settingsCtx.effect(() => store.attach(scope));
      log.info(`settings 注册成功 · namespace=${String(NS)} · 配置文件 ${settings.documentPath ?? '(未知)'}`);
    } catch (error) {
      settingsError = String(error?.message ?? error);
      log.error('settings 注册失败（配置将只活在内存里，设置页会提示）：', error);
    }
  });

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  ctx.effect(() => {
    void (async () => {
      try {
        await server.start();
        endpointWritten = writeEndpoint();
        log.info(`回环 HTTP 已监听 ${server.base} · 端点文件 ${endpointWritten}`);
      } catch (error) {
        log.error('回环 HTTP 启动失败（岛与设置页不可用，DSH 本体不受影响）：', error);
      }
      syncApp();
    })();

    return () => {
      if (endpointWritten !== null) {
        try {
          fs.rmSync(endpointWritten, { force: true });
        } catch (error) {
          log.warn('删除端点文件失败：', error);
        }
      }
      log.info('已卸载');
      // 返回 promise，让调用方（包括测试）能等端口真正释放。
      return server.stop();
    };
  });
}
