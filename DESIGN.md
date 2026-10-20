# dsh-notch-win 设计文档

| 项 | 值 |
| :--- | :--- |
| 目标产物 | Windows 端 DSH 灵动岛（插件 + 桌面 app） |
| 包名 / 插件 id / settings namespace | `@dsh-external/dsh-notch-win` / `dsh-notch-win` / `dsh-notch-win` |
| 状态 | 代码完成（单测 118/118 全绿）；真机显示、穿透与跳转已验证 |
| 平台 | Windows only（macOS 明确不做；Swift 端不纳入本仓库） |

---

## 1. 目标与非目标

### 目标

1. 一个**浮在所有窗口之上**的灵动岛：折叠态一小条，悬停展开 HUD，DSH 最小化/失焦时仍然可见。
2. 显示**粗粒度**的 agent 过程：状态（思考中 / 调用工具 / 已完成）+ 耗时 + 轮次/步骤 + 工具计数 + 上下文占用 + 子代理数 + 当前待办。
3. **状态计算全部搬到宿主进程**（DSH node 侧），订阅 DSH 自己的事件流，不再读磁盘会话文件。
4. **设置页与原生 DSH 插件设置页观感一致**，落在「设置 → 插件」分区里作为一个原生标签页。
5. **点击跳转**：点岛上的会话 → DSH 切到该会话（`uiWorkspace.openSession`，见 §8.1）。

### 非目标

- macOS / 物理刘海 / NSPanel / Swift 构建链。
- 自动下载安装启用 `exe`、校验和、TLS 代理 CA、安装链自检（**明确砍掉**，见 §3-D5）。
- 把 thinking 正文、工具参数全文搬进 IPC（隐私面 + 体积；中等粒度只要一行摘要）。
- 修改 DSH 源码（不做，见 §5-C1）。
- 新增 DSH session 事件类型（做不到，见 §5-C5）。

---

## 2. 结论速览

### 2.1 架构

```
                ┌──────────────────────────── DSH 进程 ────────────────────────────┐
                │                                                                  │
   agent/status │   宿主半边  lib/index.js                                         │
   session/event│   ┌────────────────────────────────────────────┐                 │
 ───────────────┼──▶│ 状态机 state.js                            │                 │
   (DSH 事件流) │   │  · 订阅 agent/status + session/event       │                 │
                │   │  · 采纳扫描 ctx.agents.list()/ctx.sessions  │                 │
                │   │  · 被请求时才懒算（150ms 节流）→ 一段 JSON  │                 │
                │   └───────────────┬────────────────────────────┘                 │
                │                   │                                              │
                │            ┌──────▼───────┐        ┌──────────────────────┐      │
                │            │ server.js    │        │ 渲染半边 lib/client.js│      │
                │            │ node:http    │◀──────▶│ · settings.plugins.tab│      │
                │            │ 127.0.0.1    │ 同机    │ · 命令轮询→uiWorkspace │    │
                │            │ :47411..     │        │ · config 读写         │      │
                │            └──────┬───────┘        └──────────────────────┘      │
                └───────────────────┼──────────────────────────────────────────────┘
                                    │ HTTP（回环，X-Notch 头 + Host 栅栏）
                    ┌───────────────▼────────────────┐
                    │ 岛 app  DSHNotch.exe (Electron)│
                    │ · 拉 /v1/state，画岛            │
                    │ · POST /v1/jump                │
                    │ · endpoint-<pid>.json 发现端口  │
                    └────────────────────────────────┘
```

- **两处跨进程**：① DSH 宿主 ↔ DSH 渲染（插件两半，历史结构，只服务设置页 + 跳转执行）；② DSH ↔ 岛 app（产品定义：必须独立顶层窗口）。
- **一条通道**：宿主半边起一个回环 HTTP，同时服务岛 app 和插件自己的渲染半边；状态只从 DSH 事件流来，不触碰会话文件。
- **一处不跨进程**：状态计算。数据在宿主内存里就有，不需要去磁盘上反推。

### 2.2 不纳入本实现的部分

- Windows app 只保留窗口、托盘、穿透与视图层；状态采集、配置持久化、跳转执行回到宿主或 DSH 本身。
- 不包含会话文件解析（zstd / jsonl / projection cache）、目录扫描与 mtime 启发式。
- 不包含自动下载、校验和、安装与自更新链路。
- macOS / Swift 端不纳入本仓库。

### 2.3 这样做的收益

| 目标 | 做法 |
| :--- | :--- |
| 状态实时且开销可预期 | 宿主内存状态机 + 一个 ≤4 KB 的 JSON 端点；空闲零定时器 |
| 不依赖未文档化的文件布局 | 不直接读取会话文件或投影缓存文件；投影值只经 DSH 服务做富化 |
| 配置只有一个权威 | DSH profile 配置；UI 只发一个 patch |
| 设置可持久化 | DSH 0.2.x 的 `Config` 导出与自动表单（历史版本差异见 §5 注） |
| 端点永不复用死实例 | 每实例一个 `endpoint-<pid>.json`，连接前校验 pid 活性 |
| 写通道有最低限度的防护 | 只绑回环 + Host 栅栏 + `X-Notch` 头强制预检 + 回显 Origin |

---

## 3. 决策记录（已与你确认）

| # | 决策 | 取舍 |
| :--- | :--- | :--- |
| D1 | 目录 `p4\dsh-notch-win`，id/包名 `dsh-notch-win` | 明确 Windows 专属，为将来 `dsh-notch-mac` 留位 |
| D2 | 设置页注册到 `settings.plugins.tab` | 与原生「插件配置」并排，外壳由 DSH 渲染 |
| D3 | 配置权威源 = DSH 原生 `~/.dsh/settings.yaml` | schema 校验 + 热重载 + 单一权威 |
| D4 | 岛信息粒度 = 中等 | 计算在宿主侧，代价低；不含 thinking 正文 |
| D5 | 砍掉自动安装，只启动已存在的 exe | 删掉下载器/校验和/TLS/EPERM 全部失败面 |
| D6 | 设置项：`enabled` `hideWhenIdle` `jumpEnabled` `expandOnHover` `glowEffect` `scale` `autoLaunchApp` | 另加一个必要的 `appPath`（见 §7.9，因为 D5 取消了自动安装） |

---

## 4. 设计依据与验证

> 本节记录设计时依赖的 DSH 侧事实与保留的交互原则。开工时可跳过，评审时不要跳过。

### 4.1 数据从哪来

| 数据 | 来源 | 是否需要跨进程 |
| :--- | :--- | :--- |
| 状态 | DSH 宿主内存（`agent/status` + `session/event`） | 不需要，数据就在宿主里 |
| 跳转 | 渲染进程的 `uiWorkspace.openSession(id)` | 需要（导航能力在渲染进程） |
| 配置 | DSH profile 配置 / `settings.yaml` | 需要（写入口在宿主） |

### 4.2 实测证据（本机）

- 会话日志是多帧 zstd：一个 2,597,629 字节的日志里有 **1372 帧**；`zlib.zstdDecompressSync(整个文件)` 只还原帧 #1 → **1 行**，必须自己逐帧解。这也是本设计不把会话文件当实时源的原因之一。
- `dsh-session-projection-cache` 的写策略：`turn/end` 必写 + 会话释放必写 + 每 200 事件/5000 ms 节流。它是**轮次边界的检查点，不是实时源** → `sessionStats.openStep` / `pendingCalls` 几乎恒定为空。
- 因此状态只订阅 DSH 事件流；投影缓存仅用于富化（`contextPressure` / `tokenUsage` / `sessionStats`），且只在需要时读。

### 4.3 保留的交互设计

- 岛的视觉语言、DOM 骨架、穿透三防线、`rev` 去重、自适应轮询时延。
- 渲染半边用 `window.__ModuleLoader__.load({id, factory})` 手写 bundle —— 这是第三方插件携带渲染半边的可行形态（无构建步骤，依据见附录 A 的 `dsh-client-modules`）。

---

## 5. DSH 侧硬约束（不可协商，均有源码出处）

| # | 约束 | 出处 | 后果 |
| :--- | :--- | :--- | :--- |
| **C1** | 原生「插件配置」卡片需要 namespace 出现在 `dsh-host-apiproxy` 的**硬编码白名单**里（`WEB_SETTINGS_NAMESPACES` / `PRODUCT_SETTINGS_NAMESPACES`），且源码注释写明"让插件自己 `settings.register()` 就能暴露配置"是 **deferred work** | `@deepseek-ai/dsh-host-apiproxy/lib/index.js:884-896, 1001, 2410-2415` | 第三方插件**拿不到**原生卡片。要么改 DSH，要么自己画设置页 → 我们用 `settings.plugins.tab` |
| **C2** | 注册 settings namespace 的正确写法是 `ctx.inject(["settings"], (settingsCtx) => settingsCtx.settings.register(settingsNamespace(ns), Schema))` | `@deepseek-ai/dsh-client-ui-theme/lib/index.js:71-74` | **不能**直接写 `ctx.settings.register(...)`：apply 时刻该服务可能尚未就绪 → `undefined` |
| **C3** | 插件没有轻量自有 RPC：Typert 需要 TypeScript 代码生成产物；`ctx.remote.$on` 的键面由**宿主组合**的 `TypertRemoteEventSelection` 收窄 | `@deepseek-ai/dsh-typert-protocol/README.zh.md`、`dsh-client-connection/README.zh.md` | 宿主 → 渲染进程的自定义消息**只能**自己开通道；回环 HTTP 是可行解 |
| **C4** | `session/event` 是 `@mode emit`、不 await，listener 抛错只被 `logger.warn` 吞掉 | `@deepseek-ai/dsh-session/lib/types/*.d.ts`（`'session/event'(session, event)`） | handler 必须**同步、快、绝不抛**；任何 I/O 都在独立定时器里做 |
| **C5** | 持久化读路径拒绝未知事件类型（除非带 `ignorable`）；"给下游插件事件留注册面"是 deferred | `@deepseek-ai/dsh-session/known-event-types.d.ts:7-18` | **不要**想着"往会话日志里写个自定义事件让客户端看到" |
| **C6** | `agent/status` 是 Scope 过滤派发（`Scoped<Agent>`） | `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:160-172`；`dsh-scope` 允许未打标签的 listener；harness 自用在 `dsh-agent/src/invariant.ts` 用 `{ global: true }` | 订阅必须**全局**，否则收不到别的 agent 的转换 |
| **C7** | 热重载**不会**重放 `agent/created` | `dsh-session-telemetry/README`（adoption sweep 注意事项） | 加载时必须做一次采纳扫描（§7.5） |
| **C8** | `dsh-host-webserver` 的 route 注册存在，但"Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch"，插件 route 是否在 Electron 渲染进程可达**未经验证** | `dsh-host-webserver/README.zh.md:7` | 用自建回环 HTTP，不用 `webServer.register`；可达性见 R1 / R1b，需真机验证 |

> **⚠ 2026-10 现状：本节 C2 与附录 A 的 settings 结论只对 DSH 0.1.x 成立。**
> 安装的桌面版 DSH `0.2.1-rc.2`（本机安装目录，构建 commit `332895e0`）里，
> `@deepseek-ai/dsh-settings` 只导出 `SettingsConflictError` / `SettingsForms` /
> `redactSecrets`：**没有 `settingsNamespace`，也没有 `register` / `SettingsScope`**。
> 设置页表单改为 DSH 读取插件导出的 `Config` 自动生成；配置由 profile 条目持久化，
> cordis 在 `apply(ctx, config)` 的第二参数把已校验的值交给插件。
>
> 早期版本在 `lib/config.js` 顶部静态导入 `settingsNamespace`，
> ESM 链接阶段直接抛 `does not provide an export named 'settingsNamespace'`，
> **整个宿主半边不会加载** → 没有 `host.log`、没有回环端口、`syncApp()` 不跑 →
> 岛 app 不会被拉起。修复：命名空间退化为普通字符串、配置从 `apply` 第二参数
> 播种（`createConfigStore().seed()`）、`ctx.inject(["settings"])` 里按
> `typeof settings.register === "function"` 分支保留 0.1.x 路径。详见
> `lib/config.js` 文件头与 `README.md` 的「DSH 版本兼容」。

---

## 6. 总体架构

### 6.1 组件

| 组件 | 位置 | 语言/形态 | 职责 |
| :--- | :--- | :--- | :--- |
| 宿主半边 | `lib/index.js` (+ `state.js` `server.js` `config.js` `paths.js` `log.js` `protocol.js`) | ESM，node | 订阅事件、算状态、跑 HTTP、持有配置、拉起 app |
| 渲染半边 | `lib/client.js` | 手写浏览器 bundle，`__ModuleLoader__.load` | 注册设置页；轮询命令 → `uiWorkspace.openSession`；上报当前会话 |
| 岛 app | `app/` | Electron（打包后无运行时 npm 依赖） | 拉状态、画岛、发跳转、托盘、穿透 |

### 6.2 通道

只有一条：**宿主半边自建的回环 HTTP**（`node:http`，绑 `127.0.0.1`）。

- 岛 app：`GET /v1/state`（自适应 250 / 1000 / 3000 ms）、`POST /v1/jump`、`POST /v1/ack`。
- 渲染半边：`GET /v1/state`（设置页的只读诊断，1000 ms）、`GET /v1/commands`（500 ms 轮询跳转）、`POST /v1/config`、`POST /v1/focus`。
- 双方都用 `GET /v1/health` 做**端口探测**（只认 `protocol` 对得上的那一个）。
- 端点发现：宿主启动时绑定端口（从 47411 起试 12 个），把 `endpoint-<pid>.json` 原子写到 `%LOCALAPPDATA%\dsh-notch-win\`，内容 `{protocol, port, pid, startedAt, version}`。**永不复用别人的端口**，死进程留下的端点会被识别并清理。
- 岛 app 在每次需要时**重读**该目录（不监听、不用 `fs.watch`），逐个校验"pid 活着 + health 回的 pid 与文件名一致 + 协议版本一致"，并顺手删掉死掉的端点文件；多个候选取 `startedAt` 最新者。
- 渲染半边没有端点文件可读，所以它按 47411..47422 **顺序探测**（见 R7 的限制）。

### 6.3 生命周期时序

```
DSH 启动
  └─ 宿主 apply()
       ├─ ctx.inject(["settings"]) → register(dsh-notch-win, Schema) → SettingsScope
       ├─ 采纳扫描：ctx.agents.list() 里 running 的 → 建条目（补上 running 起始时间）
       ├─ ctx.on("agent/status", h, { global: true })
       ├─ ctx.on("session/event", h)
       ├─ 起 HTTP server → 写 endpoint-<pid>.json
       └─ autoLaunchApp && appPath 存在 → spawn(DSHNotch.exe)（app 自持单实例锁，重复 spawn 无害）

用户点岛上某会话
  └─ app POST /v1/jump {sessionId}
       └─ 宿主入 ring（cap 32 / TTL 45 s），seq++
            └─ 渲染半边 GET /v1/commands?since=seq → 取到 → uiWorkspace.openSession(id)

用户在 DSH 里切会话
  └─ 渲染半边订阅 ctx.sessions.list → POST /v1/focus {sessionId}
       └─ 宿主 primaryId = id → 排序把主会话顶到第一条 → 岛高亮它

用户在设置页改开关
  └─ 渲染半边 POST /v1/config {patch}
       └─ 宿主 SettingsScope.update(patch) → settings.yaml
            └─ scope.watch → 内存 config 更新
                 └─ 岛下一次轮询（≤1 s）从快照里拿到新 config → 应用（缩放/发光/隐藏）

DSH 退出
  └─ dispose：关 server、删 endpoint-<pid>.json
       └─ 岛发现所有端点都不可用 → 显示「未连接宿主」，托盘保留
```

---

## 7. 宿主半边 `lib/`

### 7.1 文件划分

| 文件 | 职责 | 备注 |
| :--- | :--- | :--- |
| `lib/index.js` | 插件入口：`apply(ctx, config)`、`inject`、生命周期、把下面几件接起来 | 必须**保持小**，逻辑都在别的文件里 |
| `lib/protocol.js` | 协议常量：路径、状态枚举、字段名、`PROTOCOL_VERSION` | 纯数据，宿主与 app 共用 |
| `lib/state.js` | 纯函数状态机：`reduce(state, eventLike)` / `snapshot(state)` / `revOf(snapshot)` | **零 I/O，可单测** |
| `lib/server.js` | `node:http` 服务、路由、Host/Origin 栅栏、`X-Notch` 检查、JSON 编解码 | 只依赖 `node:http`/`node:crypto` |
| `lib/config.js` | schema 定义 + `SettingsScope` 包装（`get/watch/update` + 内存镜像） | 唯一的配置权威 |
| `lib/log.js` | 诊断日志（文件 + console） | 见 §7.11 |

### 7.2 订阅规格

```js
// 全局：agent/status 走 Scope 过滤派发，必须显式全局（C6）
ctx.on("agent/status", (payload) => {
  // payload: { agent: Agent, status: "idle" | "running" }；agent.id 即 SessionId
  safely(() => ingest(state, { kind: "status", agentId: payload.agent.id, status: payload.status }));
}, { global: true });

// 全局：会话事件（C4 → 只做内存写入，绝不 I/O、绝不抛）
ctx.on("session/event", (session, event) => {
  // event: { type, seq, time, data }
  //   ⚠️ 负载在 event.data 里，**不是**平铺在 event 上。这一条曾经搞错过，
  //   后果是所有 payload 字段都读到 undefined，状态永远是"思考中"。
  safely(() => ingest(state, { kind: "event", sessionId: session.id, event }));
});
```

`safely(fn)` = `try { fn() } catch (e) { log.warn(...) }`，包住**每一个** handler 体，绝不让异常冒到 DSH（emit 模式下会被 `logger.warn` 吞，但我们要保证状态机不被污染）。

`SessionEvent` 的权威定义在 `@deepseek-ai/dsh-session` 的 `lib/types/types.d.ts`（`SessionEventMap` 与 `SessionEvent`）。下表"负载字段"一列指的都是 `event.data` 内的字段。

**事件 → 状态变更表**

| 事件（`event.type`） | `event.data` 字段 | 作用 |
| :--- | :--- | :--- |
| `agent/status`（不是 session 事件） | `{agent, status}` | `running`：建/取条目，`elapsedFrom = now`，`status = "thinking"`，清 `stopped`；`idle`：`status = "done"`，**保持到用户 ack 或下一轮开始**，不再自动回 `idle` |
| `agent/disposed` | `{agent}` | 移除条目 |
| `agent/created` | `{agent}` | 建条目（热重载不重放 → 靠 §7.5 扫描兜底） |
| `turn/start` | `{turn}` | `entry.turn = turn`；`entry.step = null`；`entry.toolCount = 0`；清 `inFlight`；清 `stopped` |
| `step/start` | `{turn, step}` | `entry.turn/step`；若 `inFlight` 空 → `status = "thinking"` |
| `tool/call` | `{turn, step, callId, name, arguments}` | `inFlight.set(callId, name)`；`status = "tool"`；`toolName = name`；`toolCount++`；`detailText = summarize(name, arguments)` |
| `tool/result` | `{turn, step, message, error?}` | 负载里**没有** `callId` —— 配对信息在 `data.message.content[i].toolCallId`（`ToolResultBlock`）。删掉对应 `inFlight`；空则 `status = "thinking"` |
| `todo/write` | `{todos}` | `todoTotal/todoDone/todoText`（整体快照，最新胜） |
| `assistant/message` | `{turn, step, message, usage?}` | `usage.inputTokens + cacheReadTokens + cacheWriteTokens` → `contextTokens`（分子；分母见 `request/context`） |
| `request/context` | `{contextWindow}` | `contextLimit = contextWindow`（token-meter `contextPressure` 投影的分母） |
| `turn/end` | `{turn, reason}` | 清 `toolName`/`inFlight`；`reason.kind === "aborted"` → `entry.stopped = true`（用户主动停止），其余 false；**不**改 `status`（状态只由 `agent/status` 驱动） |

每个会话另有 `lastSeq` 重放保护：`event.seq` 不增就直接丢弃。会话恢复会把历史事件按序重放，而我们订阅的时机可能晚于事件本身，两种情况都不允许状态倒退。

> **关键设计点**：`status` 的"执行中/执行完成"只由 `agent/status` 驱动。`turn/end` 不等于 agent 结束（agent 可能继续下一轮），但它的 `reason.kind` 用来区分"已完成"与"已停止"。`done` 不再定时回 `idle`，保持到用户点击表头确认（ack）或下一轮开始。

### 7.3 状态模型

```js
// 内存态（宿主私有）
Map<sessionId, {
  id, label, shortId,            // label 来自 §7.5 / 标题兜底链
  status,                        // "idle" | "thinking" | "tool" | "done"
  elapsedFrom,                   // epoch ms | null
  turn, step,                    // number | null
  inFlight: Map<callId, name>,   // 未配对的 tool/call
  toolCount,
  contextFraction,               // 0..1 | null
  todoTotal, todoDone, todoText,
  detailText,
  lastSeq,                       // 去重用：忽略 seq 回退（重放/恢复）
  updatedAt,
}>
primaryId                          // 渲染半边上报的"当前会话"
```

### 7.4 状态机

```
         agent/status=running
                 │
                 ▼
   ┌─────────► thinking ◄────────────┐
   │             │  │                │
   │  step/start │  │ tool/call      │ tool/result 且 inFlight 空
   │             │  ▼                │
   │             │  tool ────────────┘
   │             │
   │             │ agent/status=idle
   │             ▼
   │           done ──(用户 ack / 下一轮)──► idle
   │             │
   │             └─ stopped=true 时显示“已停止”（turn/end reason=aborted）
   └───────────────────────────────────────────
              agent/status=running（再次）
```

- `idle` 的条目**不参与** HUD 列表（除非 `hideWhenIdle=false` 且用户想看历史 → 由 app 侧决定，宿主照样把 `idle` 条目发出去但排在后面）。
- 条目上限 `MAX_ENTRIES = 8`，排序：`running` 优先 → `primaryId` 优先 → `updatedAt` 倒序。

### 7.5 采纳扫描（adoption sweep）

`apply()` 里做一次，**在**挂 listener **之后**（避免窗口期丢事件）：

```js
for (const agent of ctx.agents.list()) {          // Agent[]，见 §15
  seed({ id: agent.id, status: agent.status });    // "running" | "idle"
}
```

这一步**必须**在挂完 listener 之后：热重载时 `agent/created` 不会重放，不扫的话"已经在跑的会话"要等到它下一次状态变化才出现。

每次 `enrich(now)`（也在懒计算路径上）顺带补两件事：

- **子代理计数**：一遍扫完 `ctx.sessions.list()`，`header.origin === 'subagent'` 且 `header.parentSession` 指向父会话、且 `ctx.agents.get(child).status === 'running'` 的，给父会话累加 `subagentRunning`。
- **标题**（优先级从高到低，前一级拿不到才往下走）：① DSH 会话标题（`session/title` 事件，或富化时读 `sessionTitle.get(session).title`，`labelSource:"title"`）→ ② 首条 `user/message` 的文本（截 40 字，`labelSource:"message"`）→ ③ `header.cwd` 的最后一段路径名（`C:\work\acme-api` → `acme-api`，`labelSource:"cwd"`）→ ④ `shortId`（前 8 位）。带 `labelSource` 是为了"只许升级不许降级"：DSH 标题可以盖掉消息/目录名，后来的 `user/message` 可以盖掉目录名兜底，反过来都不行。**标题缺失不影响功能** —— 但这是整条链里最容易"什么都对就是名字不对"的一环，所以设置页把 `label` 直接显示出来便于核对。

- 已在跑的会话补 `elapsedFrom = now`（精确起点不可得，标注为近似）。
- 内存不无界增长：`EVICT_IDLE_MS = 600000`（10 分钟没动过的 **idle** 条目回收；`live` 条目**永不**回收）、`SESSION_MAP_MAX = 64`（兜底上限，超了先淘汰最旧的 idle）。

### 7.6 计算与发布（**没有定时器**）

- **完全没有发布定时器**：`state(sinceRev)` 被请求时才重算，且距上次计算 < `PUBLISH_THROTTLE_MS` 时直接复用上一次的结果。
- 所以 **idle 时 CPU 为零**：没有 `setInterval`、没有排队、没有"每 250 ms 醒来看看有没有变"；渲染半边也不留自己的定时轮询节奏。
- `rev = fnv1a(stableStringify(snapshot))`，`stableStringify` 是键名排序的 JSON —— 保证同一份状态永远得到同一个 `rev`。
- `state(sinceRev)`：`sinceRev === rev` 时只回 `{unchanged:true, rev}`，不做序列化。
- 宿主侧**没有任何"推送"**：岛与设置页各自轮询。这样宿主的开销与"谁在看"完全无关。
- **没有 `done → idle` 的自动定时器**：`done`（以及 `stopped=true` 的“已停止”）保持到用户点击表头确认（ack）或下一轮开始。`DONE_HOLD_MS` 仅保留在协议常量里（兼容旧客户端），宿主不再使用。

### 7.7 HTTP 端点规格

基址 `http://127.0.0.1:<port>`，全部 `Content-Type: application/json; charset=utf-8`。

| 方法 | 路径 | 消费方 | 请求 | 响应 |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/health` | app / 渲染半边（探测） | — | `{ok:true, pid, protocol, version, startedAt, entries, live}` |
| `GET` | `/v1/state` | app / 渲染半边 | `?rev=<rev>` 可选 | 见 §10；`rev` 相同时 `{unchanged:true, rev}` |
| `POST` | `/v1/jump` | app | `{sessionId}` | `{ok:true, seq}`；`jumpEnabled=false` → 409 `feature-disabled`；同时 ack 该会话的 done/stopped |
| `POST` | `/v1/ack` | app | `{sessionId}` | `{ok:true}`；把 done/stopped 刷回 idle |
| `GET` | `/v1/commands` | 渲染半边 | `?since=<seq>` | `{seq, jumps:[{seq, sessionId}]}` |
| `POST` | `/v1/config` | 渲染半边 | `{patch}` | `{ok:true, config, configSource}` |
| `POST` | `/v1/focus` | 渲染半边 / app | `{sessionId\|null}` | `{ok:true}` |

错误统一：`{ok:false, code, message}`，HTTP 400/403/404/409。`code` ∈ `bad-json` `bad-request` `feature-disabled`（409）`forbidden-host` `forbidden-origin` `unknown-route` `not-found` `config-rejected`。

`jump` ring：`cap 32`、`TTL 45 s`，重放去重（同 `sessionId` 在 500 ms 内只保留一条）。用 ring 而不是"推送"，是因为第三方插件没有宿主↔渲染的轻量 RPC（C3）。

### 7.8 安全模型

| 措施 | 作用 | 实现 |
| :--- | :--- | :--- |
| 只绑 `127.0.0.1` | 不对外暴露 | `server.listen(port, "127.0.0.1")` |
| **Host 栅栏** | 挡 DNS rebinding（Host 是重绑定唯一伪造不了的请求头） | `Host` 去端口后必须 ∈ `{127.0.0.1, localhost, [::1]}`，否则 403 |
| **Origin 白名单 + 回显** | 挡跨站读 | `Origin` 为 `null`（Electron `file://`）、`dsh-app://app`（DSH 桌面渲染进程的自定义 scheme）或回环权威时才回显 `Access-Control-Allow-Origin: <原值>` + `Vary: Origin`；**永不用 `*`** |
| **`X-Notch: 1` 自定义头** | 挡跨站写（强制预检，预检失败就发不出 POST） | 所有 `POST` 必须带该头，否则 403 |
| **`Access-Control-Allow-Private-Network: true`** | Chromium 的 Private Network Access：`file://`（不透明来源）向回环发**带自定义头**的请求时，预检必须显式放行这一跳，否则 POST 会被浏览器直接拦掉 | 仅当请求带 `access-control-request-private-network: true` 时才回这个头 |
| `sec-fetch-site: cross-site` 一律拒 | 双保险 | 直接 403 |
| 不回传任何会话正文 | 减小泄漏面 | `detailText` 上限 120 字符、单行、去控制字符 |

> `Access-Control-Allow-Private-Network` **不是可选的加固**：DSH 桌面版正是用 `file://` 加载 dist，少了它表现为"`GET` 能通、保存配置没反应"——最难查的那种半死状态。
>
> 不引入 per-boot token：它需要把密钥分发给渲染半边，而第三方插件没有可靠的办法把密钥注入 Electron 渲染进程（C8 说明那层是 IPC 桥接的，不可控），于是"分发机制本身"会成为新的失败面。上面五条**无需密钥**且足够挡住浏览器发起的跨站请求；同机同用户的恶意进程不在威胁模型内。

### 7.9 配置（settings namespace）

```js
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const NS = settingsNamespace("dsh-notch-win");

export const ConfigSchema = z.object({
  enabled:        z.boolean().default(true),      // 岛总开关（关=不显示且不拉起 app）
  hideWhenIdle:   z.boolean().default(false),     // 全部 idle 时岛消失
  jumpEnabled:    z.boolean().default(true),      // 点击跳转
  expandOnHover:  z.boolean().default(true),      // 悬停展开
  glowEffect:     z.boolean().default(true),      // 状态发光/呼吸
  scale:          z.number().min(0.8).max(1.4).default(1),   // 缩放
  autoLaunchApp:  z.boolean().default(true),      // DSH 启动时拉起岛 app
  appPath:        z.string().default(""),         // exe 路径覆盖（空=按 §7.10 顺序探测）
});
```

注册（**必须**是 C2 的写法）：

```js
// 不用 `export const inject = ["settings"]`：settings 永久缺席时整个插件会卡在
// pending（岛就不工作了）。局部注入让 apply 立刻跑，settings 迟到或不到都能降级。
ctx.inject(["settings"], (settingsCtx) => {
  scope = settingsCtx.settings.register(NS, ConfigSchema, { base: config || {} });
  mirror = scope.get();                 // 内存镜像
  scope.watch((next) => { mirror = next; });   // 没有"变脏"要标：状态是懒算的（§7.6）
  source = "settings";
});
```

- `appPath` 是**新增**的必要字段（D5 取消了自动安装，必须有人告诉插件 exe 在哪）。
- `settings` 服务不可用时（理论上不会，§16 已确认 `dsh-base` 挂了 `dsh-settings-file`）：`mirror` 退化为 schema 默认值，`source` 记作 `"defaults"` 或 `"memory"`（用户改过就是后者），日志记一条 warn，`runtime.settingsError` 带出去给设置页显示。**不再有第二份配置文件兜底**。

### 7.10 岛 app 的启动与发现

`appPath` 解析顺序（`lib/paths.js` 的 `appExeCandidates`）：

1. `config.appPath`（非空）
2. `%LOCALAPPDATA%\dsh-notch-win\DSHNotch.exe`
3. `<插件包>/app/dist/win-unpacked/DSHNotch.exe`（electron-builder 的默认产出）
4. `<插件包>/app/dist/DSHNotch.exe`（自定义打包产出）

取第一个**真实存在**的（`resolveAppExe`，逐个 `existsSync`，读权限出错就当作不存在继续往下找）。

- `autoLaunchApp && enabled`：`spawn(exe, [], { detached: true, stdio: "ignore", env: islandAppEnv(process.env, dataDir()) }).unref()`。**无条件 spawn 是安全的** —— app 自己持有 Electron 单实例锁，第二次启动会立刻退出。
- **子进程环境必须先清洗**（`lib/launch.js`）：DSH 桌面版用 `ELECTRON_RUN_AS_NODE=1` 跑自己的宿主进程；如果原样 `{ ...process.env }` 传给岛 app，Electron 不再启动 Chromium，而是把 `src/main.js` 当普通 Node 脚本执行，`require('electron')` 拿不到 `app/BrowserWindow`，进程 200ms 内退出。此时 `host.log` 仍会写「已拉起岛 app」（spawn 成功），但任务管理器没有进程、`%APPDATA%\dsh-notch-win` 也不更新 —— 必须删掉 `ELECTRON_RUN_AS_NODE`，并监听子进程 `exit` 把「启动后 Xms 就退出」写进日志。
- `DSH_NOTCH_NO_LAUNCH=1` 环境变量可跳过拉起（无头调试/测试用）。
- 找不到 exe：记一条 warn，**不重试**（不引入退避定时器）；设置页的"运行状态"卡里显示探测结果（`appExe` / `appExists`）。
- 不在插件里做"下载 / 校验 / 安装 / 更新"（D7 已砍）。

### 7.11 日志与诊断

- 位置：`%LOCALAPPDATA%\dsh-notch-win\host.log`（**不写进** app 的目录，两者不混；app 的端点文件也在这个目录里，但文件名区分得很清楚）。
- 每次 DSH 启动把上一份**轮转**成 `host.prev.log`（`renameSync`），而不是原地截断 —— 上一次崩溃前的日志是排查时的唯一线索，截断掉就永远看不到了。
- 只记：平台/node 版本、settings 注册结果、端口绑定结果、端点文件路径、app 启动结果、跳转入队（**只记 sessionId 前 8 位**）。
- **绝不记**配置值以外的内容、绝不记会话正文/工具参数。
- `DSH_NOTCH_DATA_DIR` 可以整体覆盖数据目录（日志与端点文件都跟着走）。**端到端测试必须用它**：`test/host.test.mjs` 跑的是真实的 `apply()`，不隔离的话测试诊断日志会混进用户真实的 `host.log`，而里面恰好有 `DSH_NOTCH_NO_LAUNCH=1，跳过拉起岛 app` 这种一看就像真实行为的行 —— 这件事真的发生过，并被读成"插件默认不拉起岛"。宿主拉起岛 app 时会把该变量显式传给子进程，所以调试时两侧看的是同一个目录。

### 7.12 失败降级矩阵

| 失败 | 行为 |
| :--- | :--- |
| `settings` 服务缺席 | 配置落内存镜像（`configSource: "memory"`）；设置页**照常可改**（改这一份内存值），并在卡片描述里明确写"重启即丢失"；日志 warn |
| 端口 12 个都占 | 不写 endpoint 文件，日志 warn；岛与设置页显示"未连接（重试中）"；**不影响 DSH 本体** |
| app exe 不存在 | 日志 warn + 设置页提示路径；岛不显示（其它功能全部照常） |
| 某个 `session/event` 负载意外 | `safely` 吞掉；不影响其他条目 |
| 渲染半边没有 `slots` 服务 | 不注册设置页，其余功能（跳转轮询、焦点上报）**照常**（`apply` 里显式判断，不靠 `inject` 卡住整个插件） |
| `uiWorkspace.openSession` 抛错（会话已消失） | 跳转轮询里记一次 `lastError` 并继续；岛页脚回显"无法切换到会话 …" |
| 状态机异常 | 单条目标记，整机不停 |

---

## 8. 渲染半边 `lib/client.js`

形态：手写浏览器 bundle，`window.__ModuleLoader__.load({ id: "@dsh-external/dsh-notch-win", factory })`（形态依据见 §4.3 与附录 A 的 `dsh-client-modules`）。

```js
// slots / sessions / uiWorkspace 都是渲染进程的根服务：
// - slots 由槽位系统提供；
// - sessions 提供列表/对象层（ClientSessions）；
// - uiWorkspace 提供导航（dsh-client-ui-workspace 的 UiWorkspaceService）。
// 声明注入会在服务就绪后才 apply；旧版 DSH 缺少 uiWorkspace 时等待而不是报错。
exports.inject = ["slots", "sessions", "uiWorkspace"];
```

### 8.1 跳转为什么是 `uiWorkspace.openSession(id)`

当前桌面版（DSH 0.2.1-rc.2 / 桌面 2.0.x）的导航 API 在
`dsh-client-ui-workspace` 的 `UiWorkspaceService` 上：

```
dsh-client-ui-workspace  L1380: super(ctx, "uiWorkspace")
dsh-client-ui-workspace  L1470: openSession(target) { this.replaceMain(target, ...) }
```

`openSession` 会替换主区域并选中会话；侧栏点击、fork 跳转、toast 里的
"打开 fork 源"都走它。`sessions` 服务（`ClientSessions`）只负责列表/对象层
（`list`、`manager`、`scope`…），**没有 `open`**；导航统一走
`uiWorkspace.openSession`。

```js
if (ctx.uiWorkspace?.openSession) {
  ctx.uiWorkspace.openSession(jump.sessionId);
} else if (ctx.sessions?.open) {
  ctx.sessions.open(jump.sessionId); // 旧版 DSH / 代理差异兜底
}
```

### 8.2 上报"当前在看哪个会话"

`dsh-client-runtime` 的 `sessions.list` 是一个 snapshot store（`getSnapshot()` / `subscribe(fn)`），`getSnapshot().current` 就是当前选中的会话 id（`createSnapshotStore` 定义于 `dsh-client-runtime` L8913）。

```js
const store = ctx.sessions.list;
const off = store.subscribe(() => {
  const current = store.getSnapshot().current;   // 变了才报，300ms 去抖
  void post("/v1/focus", { sessionId: current });
});
```

这样岛能高亮"你正在看的那个会话"，而不是只有跳转过的那个。上报是**尽力而为**：失败不重试、不影响任何可见功能。拿不到 store 就安静降级（`supported: false`）。

### 8.3 设置页（`settings.plugins.tab`）

槽位契约（`dsh-cordis-client-runner` 的槽位清单 + `dsh-client-ui-settings-plugin-inventory` 的真实调用）要求：

| 选项 | 必要性 | 说明 |
| :--- | :--- | :--- |
| `name` | 必填 | `"settings.plugins.tab"` |
| `id` | **必填** | 自己的 cell key。**复用 DSH 自带 tab 的 id（`all` / `configurable`）会替换掉它，而不是并列一个** |
| `order` | 可选 | 升序排列 |
| `label` | 可选但实际必需 | tab 上显示的文字。不给就是一个无名标签 |

```js
ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register(
  { name: "settings.plugins.tab", id: PLUGIN_ID, order: 50, label: "灵动岛" },
  () => h(SettingsTab, { channel }),
));
```

为什么要 `label` 用字符串而不是 `() => "灵动岛"`：契约允许 `string | (() => string)`，thunk 的用途是随 locale 变化重读；本插件只有一个中文界面、不注册 locale 字典，给字符串更诚实。

- 外壳（分区标题、标签栏、滚动）由 DSH 渲染 → **观感天然一致**（D2）。
- 内容**不引入 `dsh-client-ui-primitives` 的组件**，而是自建但**完全复用 DSH 的主题令牌**（`--dsw-alias-border-l2` / `--dsw-alias-label-primary|secondary|tertiary|dimmed|error` / `--dsw-alias-bg-layer-2|3` / `--dsw-alias-bg-module-platform` / `--dsw-alias-brand-primary`），并以 `<style data-plugin-css="…">` 注入、类名统一 `dshnotch_` 前缀。理由见 D2 的补充：原生卡片是**内部组件**（`dsh-client-ui-settings-plugins` 的 `ValueField` / `PluginCard`），不对外导出；而主题令牌是**公开契约**（`dsh-client-ui-theme` 就是靠它工作的），跟着令牌走就自然跟随明暗主题。
- 卡片结构**照抄原生**：`li.dshnotch_card` → `button.dshnotch_header`（`aria-expanded`、`span.dshnotch_headText` 里 `name` + `description`、右侧 chevron）→ `div.dshnotch_body` → `div.dshnotch_footer`。字段结构照抄原生 `ValueField`：`div.field` → `div.head`（label + badge）→ 控件 → `p.hint`/`p.invalid`。
- 两张卡：**配置**（暂存编辑，点「保存」才提交，可「丢弃」）与**运行状态**（只读诊断）。
- 保存语义：本地草稿 → 逐字段与已存值比对（数字按数值比，避免 `1` / `1.0` 误判）→ 点「保存」→ `POST /v1/config {patch}` → 回读返回值直接并进快照；失败保留草稿并显示错误。
- 客户端**先校验**（`scale` 范围），错的值不往 `settings.yaml` 里送；宿主仍会再校验并回 400（§7.7）。
- 运行状态卡里放：回环通道（端口 + 连通）、配置来源、追踪中的会话（带状态点与小字）、宿主 pid、协议版本、岛 app 路径与是否存在、设置注册错误、宿主日志路径。

### 8.4 渲染半边不碰配置的读写语义

读配置、写配置**全部**走宿主半边的回环 HTTP（`/v1/state`、`/v1/config`），而不是 `ctx.settingsScope.bind({ namespace })`。后者在原生插件里确实可用（`dsh-client-ui-theme` 就这么用），但这里刻意只保留一条通路：宿主 → DSH 配置层。渲染层不写 `settingsScope`，也不在 `localStorage` 留副本，避免同一份配置出现多个写入口。代价与限制见 R7（渲染半边拿不到"自己的宿主 pid"，同机多实例时会连到先响应的那个宿主）。

### 8.5 明确不做的

- 不注册 `conversation.session.header.utilities`（头部快捷开关）——砍掉。
- 不碰 `settingsScope` / `configForms` / `localStorage`（配置全部经宿主，见 D3/C1）。
- 不查 `ctx.sessions` 的快照来做状态（状态在宿主算，见 §6.3）。

---

## 9. Windows app（`app/`）

### 9.1 文件清单

| 文件 | 职责 |
| :--- | :--- |
| `app/package.json` | CJS（**不能**是 ESM：`protocol.cjs` 靠 `require` 加载）、Electron + electron-builder 依赖、`win.target = ["dir"]` |
| `app/src/main.js` | 主进程：窗口/托盘/穿透三防线/单实例锁/缩放/自适应轮询/IPC |
| `app/src/endpoint.js` | 端点发现：pid 活性 + health pid 一致 + 协议版本一致，顺手清理死文件 |
| `app/src/host-client.js` | 宿主 HTTP 客户端：探活 / 拉快照（带 `rev` 短路）/ 跳转 / 焦点 |
| `app/src/preload.js` | `contextBridge` 暴露 `window.island`，顺便把 `protocol.cjs` 交给渲染层 |
| `app/src/index.html` | 骨架（只创建一次，之后只改文本与属性） |
| `app/src/renderer.js` | 视图层：快照 → DOM（按 id 复用会话行）、命中判定、点击跳转 |
| `app/src/styles.css` | 外观：透明窗口、黑色胶囊、状态色带、展开弹簧 |
| `app/src/protocol.cjs` | **生成物**（`scripts/gen-app-protocol.mjs` 由 `lib/protocol.js` 生成，测试断言字节一致） |
| `app/assets/*` | 图标（`icon.ico` / `icon.png` / `tray.png`） |

**不包含**：会话文件解析（zstd / jsonl / projection cache）、目录扫描、活动推断、自更新/安装器逻辑。这些职责要么由 DSH 自身承担，要么由宿主状态机取代。

### 9.2 主进程职责

1. **端点发现**（`endpoint.js`）：读 `%LOCALAPPDATA%\dsh-notch-win\endpoint-<pid>.json`，逐个校验
   - pid 还活着吗（`process.kill(pid, 0)`；**只有 `ESRCH` 才算死**，其它错误一律当作活着），死了就把文件删掉；
   - `GET /v1/health` 回的 `pid` 与**文件名里的 pid 一致吗**（挡 pid 复用与端口被抢）；
   - `protocol` 对得上吗（挡协议不符的本地服务与其它插件）。
   三条都过才连；多个候选取 `startedAt` 最新者。不复用别的实例留下的端口：死进程的端点会被识别并清理。
2. **拉状态**：`GET /v1/state?rev=<last>`，宿主未变时只回 `{unchanged:true}`；app 侧再按 `rev` 去重一次，内容没变就**不惊动渲染层**。
3. **自适应时延**：有 `live` 条目或指针正悬在岛上 250 ms；全空闲 1000 ms；连不上宿主 3000 ms。
4. **应用配置**：配置**从快照里来**（`payload.config`），所以岛不读任何配置文件 —— 在 DSH 设置页改一下，≤1 s 就生效。`scale` → `setZoomFactor` + 同步窗口尺寸；`glowEffect` → `data-glow`；`expandOnHover` → 是否悬停展开；`enabled=false` / `hideWhenIdle` 且无 live 条目 → 隐藏窗口。
5. **跳转**：`POST /v1/jump`（带 `X-Notch: 1`）。失败时把 sessionId 放进剪贴板并在页脚回显原因。
6. **穿透三防线**：渲染层 mousemove 命中判定 → `setInteractive`；渲染层 `mouseleave`；主进程 500 ms 看门狗（指针已出窗就强制收回）。隐藏窗口时也复位。
7. `backgroundThrottling: false`（**不能省**：失焦后 Chromium 会把定时器降频，250 ms 轮询会变成半天不动）。
8. 托盘（显示/隐藏/打开配置目录/打开宿主日志/退出）作为隐藏后的逃生口；单实例锁让宿主每次启动重复拉起无害。
9. **不做**：不下载、不校验、不安装、不自更新（已砍，见 D7）。`DSH_NOTCH_NO_LAUNCH=1` 可让宿主跳过拉起（测试用）。
10. `app.setPath("userData", %APPDATA%\dsh-notch-win)` 必须在 `requestSingleInstanceLock()` **之前**：Electron 的默认 userData 由 productName 决定；若与其它同样叫 `DSHNotch` 的 app 共用，就会共用单实例锁（后启动的静默退出，无任何报错）。

### 9.3 渲染层字段裁剪

- 宿主 `status` 仍是 **4 值**：`idle | thinking | tool | done`；岛的 `data-status` 额外用 `stopped`（done 且用户主动停止）和 `offline` 做配色。`waiting`（等待用户确认）砍掉 —— 需要额外的 approval 钩子才能可靠推断。
- 折叠态与展开态**共用同一行表头**（状态点 + 徽标 + 标题 + 耗时），折叠时只多一条可选的上下文百分比；不再有两套内容。
- 会话行与表头同一套顺序：状态点 → 中文状态徽标 → 标题 → 副信息 → 耗时；行右侧只放耗时，状态不再放在末尾。
- 岛上没有单独的"详情"行：过程只在表头徽标和会话行徽标显示；`detailText` 仍保留在快照里供设置页/诊断，不在岛上显示。
- 统计一行：**轮次 / 工具 / 子代理 / 上下文 / Token**，另加"执行中 N"（多会话时）；Token 的悬浮明细给未缓存输入、输出、缓存命中（缓存写入非 0 时才出现）。
- 页脚：左侧"通道状态"（`宿主进程 … · 端口 …` 或"未连接"），右侧操作提示 / 跳转回执 / `保持展开` 开关。
- 面板级「保持展开」在页脚；表头是当前会话摘要，平时不可点，**已完成/已停止时可点确认（ack）**。展开时列表只列**其他会话**（当前会话在表头），避免同一行状态出现两遍。
- 耗时**本地按秒走字**（`elapsedFrom` + `Date.now()`），不为了刷新一个秒数去求宿主多发一拍。
- HUD 只保留表头、待办、会话列表、统计与页脚；通道状态统一放在页脚左侧。
- 表头与会话行在标题前显示工作区（`header.cwd` 末段）弱化前缀；折叠态同样显示，宽度不足时胶囊自适应加宽。

---

## 10. 快照协议 v1

协议 v1。**禁止**出现 `now` `activity` `proj` `file` `mtimeMs` `project` 这类字段（它们描述的是从文件推断状态，而本设计不再推断）。

```jsonc
{
  "v": 1,
  "rev": "a1b2c3d4",              // 除时间外全部内容的稳定哈希；GET /v1/state?rev=<rev> 命中则只回 {unchanged:true}
  "runtime": {                     // 诊断信息（设置页与岛都用）
    "pid": 12345,
    "protocol": 1,
    "port": 47411,
    "startedAt": 1792345000000,
    "appExe": "C:\\...\\DSHNotch.exe" | null,
    "appExists": true,
    "logFile": "C:\\...\\host.log" | null,
    "settingsError": null          // 非 null 表示配置无法持久化（降级在跑）
  },
  "config": { "enabled": true, "hideWhenIdle": false, "jumpEnabled": true,
              "expandOnHover": true, "glowEffect": true, "scale": 1,
              "autoLaunchApp": true, "appPath": "" },
  "configSource": "settings" | "memory" | "defaults",
  "primaryId": "session-xxxx" | null,
  "entries": [{
    "id": "session-xxxx",
    "label": "重构设置页",
    "shortId": "xxxx",
    "status": "idle|thinking|tool|done",
    "stopped": false,              // done 且用户主动停止 → true（显示“已停止”，glow 琥珀）
    "live": true,                  // = status !== "idle"
    "glow": "#4E7CFF",             // 状态色，app 只消费不改语义
    "elapsedFrom": 1792349000000,  // epoch ms | 0，app 自己按秒走字
    "turn": 3, "step": 2,          // number | null
    "toolName": "str_replace_editor",   // string | null
    "toolCount": 7,
    "subagentRunning": 2,
    "contextTokens": 53760,        // 已用 prompt tokens（input + cache 读写）
    "contextLimit": 128000,        // 模型上下文窗口 | null
    "contextFraction": 0.42,       // 0..1 | null（分母未知时 null，岛退化为显示 contextTokens）
    "todoTotal": 5, "todoDone": 2, "todoText": "写状态机单测",
    "detailText": "str_replace_editor · lib/state.js"   // ≤120 字符，单行
  }]
}
```

**没有** `serverNow`：宿主与岛在**同一台机器同一个时钟**上，`elapsedFrom` 与 app 侧 `Date.now()` 直接可比，多一个字段只是多一个可能不一致的来源。

**错误码**（`{ok:false, code, message}`）

| 码 | HTTP | 触发 |
| :--- | :--- | :--- |
| `config-rejected` | 400 | patch 过不了 schema（客户端也会先校验，这是第二道） |
| `feature-disabled` | **409** | `jumpEnabled=false` 时的 `/v1/jump` —— 与"请求格式不对"明确区分开 |
| `unknown-route` | 404 | 未知路径（app/渲染半边据此判断"宿主换了端口"） |
| `bad-request` | 400 | 体不是 JSON / 缺字段 |
| `forbidden-origin` | 403 | Origin 不白名单 / `sec-fetch-site: cross-site` / Host 不匹配 |

---

## 11. 目录结构

```
dsh-notch-win/
├─ DESIGN.md                    # 本文档
├─ README.md                    # 一页速览 + 开发/安装说明
├─ CONTRIBUTING.md              # 贡献指南
├─ LICENSE                      # MIT
├─ THIRD_PARTY_NOTICES.md       # 第三方版权与许可声明
├─ .gitignore
├─ .gitattributes               # 文本行尾与二进制资源
├─ package.json                 # @dsh-external/dsh-notch-win, type: module
├─ dsh.plugin.json              # { id: "dsh-notch-win", main: "./lib/index.js" }
├─ cordis.patch.yml             # - insert: [{ id: notch-win, name: '@dsh-external/dsh-notch-win' }]
├─ lib/
│  ├─ index.js                  # 插件入口（订阅 + 采纳扫描 + 路由处理 + 拉起 app）
│  ├─ protocol.js               # 协议常量（**唯一出处**）
│  ├─ paths.js                  # 插件根 / 数据目录 / 日志路径 / app exe 候选项
│  ├─ state.js                  # 纯函数状态机（零 I/O）
│  ├─ server.js                 # 回环 HTTP + 安全栅栏
│  ├─ config.js                 # settings namespace + schema + 配置仓库
│  ├─ launch.js                 # 拉起岛 app（清理 ELECTRON_RUN_AS_NODE）
│  ├─ log.js                    # 诊断日志（每次启动轮转到 host.prev.log）
│  └─ client.js                 # 渲染半边（自包含浏览器 bundle）
├─ scripts/
│  └─ gen-app-protocol.mjs      # lib/protocol.js → app/src/protocol.cjs（--check 断言一致）
├─ app/
│  ├─ package.json              # Electron（CJS！不能是 ESM），win.target = ["dir"]
│  ├─ src/
│  │  ├─ main.js                # 主进程：窗口/托盘/穿透三防线/缩放/轮询
│  │  ├─ preload.js             # contextBridge + 把 protocol.cjs 交给渲染层
│  │  ├─ renderer.js            # 岛 UI（只改文本与属性）
│  │  ├─ endpoint.js            # 端点发现：pid 活性 + health pid 一致 + 协议一致
│  │  ├─ host-client.js         # 宿主 HTTP 客户端（探活/快照/跳转/焦点）
│  │  ├─ protocol.cjs           # ← 生成物（scripts/gen-app-protocol.mjs）
│  │  ├─ index.html
│  │  └─ styles.css
│  └─ assets/                   # tray.png / icon.ico / icon.png
└─ test/
   ├─ state.test.mjs            # 状态机：喂合成事件序列，断言快照
   ├─ server.test.mjs           # 端点 + 安全栅栏（Host/Origin/X-Notch/PNA）
   ├─ protocol.test.mjs         # 断言生成物 app/src/protocol.cjs 与 lib/protocol.js 逐字节一致
   ├─ config.test.mjs           # schema 默认值 + patch 往返
   ├─ host.test.mjs             # 端到端：假 cordis ctx 起真回环 HTTP，跑完整生命周期
   ├─ client.test.mjs           # 渲染半边：常量漂移/类名漂移/字段覆盖/跳转接线
   └─ app.test.mjs              # app：端点发现 + HTTP 客户端 + 源文件语法与 id 对齐
```

> `lib/protocol.js` 是**唯一出处**：`app/src/protocol.cjs` 由 `scripts/gen-app-protocol.mjs` 生成（`npm run check-protocol` 断言字节一致），渲染半边的那份常量块由 `test/client.test.mjs` 逐项比对。三处协议常量都由测试钉住，谁都不许手改跑偏。

---

## 12. 实施计划与状态

| 阶段 | 内容 | 状态 |
| :--- | :--- | :--- |
| **P1 宿主状态机** | `protocol.js` `paths.js` `log.js` `config.js` `state.js` `index.js`：订阅 + 采纳扫描 + 懒计算 | ✅ `test/state.test.mjs` `test/config.test.mjs` 全绿 |
| **P2 HTTP 通道** | `server.js`：路由 + 端点文件 + 安全栅栏 + 端口探测 | ✅ `test/server.test.mjs` 全绿（含 PNA 预检、Host/Origin/`X-Notch` 栅栏、`rev` 短路、ring 去重） |
| **P3 岛 app** | `app/src/{endpoint,host-client,main,preload,renderer}.js` + `index.html` + `styles.css` | ✅ 代码完成，`test/app.test.mjs` 全绿；折叠/展开、穿透、跳转已真机验证 |
| **P4 渲染半边 + 设置页 + 跳转** | `lib/client.js`：`settings.plugins.tab` 两卡 + 命令轮询 + 焦点上报 | ✅ `test/client.test.mjs` 全绿；设置页在 0.2.x 下的适配见 R9 |
| **P5 收口** | 真机跑一遍、目测 UI、README | ✅ 岛本体已验证：显示、工作区与 Token 统计、穿透、点击跳转；设置页观感受 R9 限制 |
| **P6 端到端宿主测试** | 假 cordis ctx + 真回环 HTTP，跑完整生命周期 | ✅ `test/host.test.mjs` 全绿 |

**当前：`npm test` 118 项全绿。**

剩余工作集中在 R9 的渲染半边 0.2.x 适配（设置 tab）；宿主、岛本体、跳转与统计均已真机验证。

---

## 13. 测试与验收

**单元 / 契约（`npm test` = `node --test "test/**/*.test.mjs"`，共 118 项）**

- `state.test.mjs`：喂一串合成事件（含乱序 `seq` 回退、`tool/call` 无 `result`、`turn/end` 后 agent 仍 running、畸形负载），断言快照与 `rev` 稳定性；另覆盖工作区字段与累计 token 的回填/裁剪。
- `server.test.mjs`：Host 栅栏（`Host: evil.com` → 403）、Origin 回显（`null` 与回环过、跨站 403）、`X-Notch` 缺失 → 403、PNA 预检头、`rev` 短路 → `unchanged:true`、ring 的 cap/TTL/去重、只绑 `127.0.0.1`。
- `config.test.mjs`：schema 默认值与边界、`patch` 往返、settings 缺席时的降级。
- `protocol.test.mjs`：`app/src/protocol.cjs` 与 `lib/protocol.js` 逐字节一致（生成物不许手改）。
- `host.test.mjs`：**端到端** —— 用假 cordis ctx（`effect` 立即执行）起真回环 HTTP，跑端点文件、health、state、采纳扫描、子代理计数、工作区与累计 token（含缓存读写）、配置写入/400、跳转队列与去重、焦点、卸载清理、settings 缺席降级、数据目录布局。它跑的是**真实的 `apply()`**，所以必须被关进笼子：`DSH_NOTCH_DATA_DIR` → 系统临时目录、`DSH_NOTCH_NO_LAUNCH=1` → 不拉真实窗口；文件顶部有一条断言专门保证"数据目录确实在沙箱里"，否则它会去写用户真实的 `%LOCALAPPDATA%\dsh-notch-win`。
- `client.test.mjs`：渲染半边的四类"静默走样" —— 协议常量漂移、类名与 CSS 漂移（**两个方向**都不许有孤儿）、schema 加了键却没有控件、跳转没接到 `uiWorkspace.openSession`；另有端口探测只认协议版本对得上的宿主、去抖、`stop()` 后不再发请求。
- `app.test.mjs`：端点发现（必须 pid 活着 + health pid 与文件名一致 + 协议一致，顺手清理死文件）、HTTP 客户端（`X-Notch` 头、`rev` 拼串、未连接明确抛错）、每个源文件语法可解析、`index.html` 的 id 与 `renderer.js` 对齐。

**真机冒烟（P5 手测清单）**

1. DSH 启动后 3 s 内岛出现，且显示当前正在跑的会话。
2. 在 DSH 里发一条会调工具的消息 → 状态点 `thinking` → `tool`（岛上显示“调用工具”，统计里的工具数递增）。
3. 执行完成 → `done`（“已完成”）保持住；点表头确认 → `idle`。在 DSH 里主动点停止 → `turn/end reason=aborted` → 岛上显示“已停止”（琥珀色），同样点表头确认后回 `idle`。
4. 最小化 DSH → 岛仍在最上层；**鼠标穿透**：点岛后面窗口的按钮能点到；指针进岛能点会话切换、能点页脚「保持展开」。
5. 点岛上一条会话 → DSH 切到该会话（§8.1 的 `uiWorkspace.openSession`）。
6. 在 DSH 里切会话 → 岛的展开列表里头条目跟着变（§8.2 的焦点上报）。
7. 设置页改 `scale` / `glowEffect` → **1 s 内**生效；重启 DSH 后保持；`~/.dsh/settings.yaml` 里出现 `dsh-notch-win:` 分节。
8. 杀掉 `DSHNotch.exe` → 宿主无异常（**不自动重启**）；重新拉起源点文件被正确识别。
9. 关掉 DSH → 岛显示"未连接"，不崩、不刷屏；托盘图标能重新显示/退出。
10. 存一份残缺的 `endpoint-<死pid>.json` → 岛能跳过它并顺手删掉。

**性能不变量**

- 宿主：`session/event` handler **零 I/O、零异常**；空闲**零定时器**（只有 `GET /v1/state` 才重算，且受 `PUBLISH_THROTTLE_MS` 节流）。
- app：`rev` 去重（内容没变不惊动渲染层）；自适应时延 250/1000/3000 ms。
- 渲染层：热路径不重建 DOM（只改文本与属性）；`getBoundingClientRect` 由 `ResizeObserver` 失效缓存，不在每次 `mousemove` 触发同步布局。

---

## 14. 风险与未决项

| # | 风险 / 未决 | 应对 |
| :--- | :--- | :--- |
| R1 | ~~渲染进程能否 `fetch` 自建回环端口~~ **已解决** | DSH 0.2.1-rc.2 渲染进程的 Origin 是 `dsh-app://app`，原先被 Origin 栅栏 403（表现为设置页"未启动"、点击不跳转、焦点不上报）；`originPolicy` 已放行该 scheme，设置页/跳转/焦点三条通路共用同一条 HTTP 通道 |
| R1b | Chromium 的 **Private Network Access** 会拦 `file://` → 回环的带自定义头 POST | 已在 OPTIONS 预检里回 `Access-Control-Allow-Private-Network: true`（§7.8），并有测试。若实测仍被拦，退路是去掉自定义头、改由 `Origin: null` + `Host` 栅栏承担写保护 |
| R2 | 上下文占用的分母/分子 | **已解决**：分母来自 token-meter 的 `contextPressure` 投影（`request/context` 的 `contextWindow`），宿主 `enrich()` 读 `ctx.get("sessionProjections").snapshot(session).values.contextPressure`；分子 = `inputTokens + cacheReadTokens + cacheWriteTokens`。分母拿不到时岛退化为显示绝对 token 数 |
| R3 | 会话标题的宿主面 API（`ctx.sessions` 摘要）确切访问器 | **已解决**：`ctx.sessions.list/get` + `SessionHeader.origin==='subagent'` / `parentSession` 已核对；标题优先级：DSH `session/title`（`ctx.get("sessionTitle").get(session)`）→ 首条 `user/message` → `header.cwd` 末段 → `shortId`（§7.5）。焦点会话即使没有事件也会建条目（`onFocus` → `ensure`），否则 `primaryId` 会指向不存在的条目、岛回落到旧会话 |
| R4 | `settings.plugins.tab` / `slots` 契约的版本区间 | 槽位选项已按 `dsh-cordis-client-runner` 的槽位清单与 `dsh-client-ui-settings-plugin-inventory` 的真实调用核对（`id` 必填、`label` 才有名字）；`peerDependencies` 声明版本区间；注册失败（没有 `slots`）**不阻断插件**（`apply` 里显式判断） |
| R5 | 与其它同类灵动岛插件同时安装 | 本插件使用独立 id / settings namespace / 端口段（47411 起）/ app 数据目录；岛 app 显式把 userData 挪到 `%APPDATA%\dsh-notch-win`——若与其它同样使用 `DSHNotch` productName 的 app 共用默认 userData，会共用 Electron 单实例锁（后启动的静默退出）。多个岛画在同一位置会重叠，建议同一时间只启用一个 |
| R6 | macOS | 明确不做。将来做 `dsh-notch-mac` 时，宿主半边与协议（含 `lib/client.js` 的跳转/焦点路径）可完全复用，只换 `app/` |
| R7 | **同机跑两个 DSH 实例时**，第二个实例的岛与设置页会连到**先响应的那个宿主** | 渲染进程与岛都拿不到"自己的宿主 pid"（第三方插件没有宿主↔渲染 RPC，C3）。当前策略：候选端点按 `startedAt` 取最新、第一份健康者胜。设置页与岛的页脚都**显示 pid 与端口**，所以不会"悄悄连错"。彻底解决需要渲染半边能从注入处拿到 host pid |
| R8 | DSH 0.2.x 的 settings 服务是 `SettingsForms` | 没有 `register` / `SettingsScope`，岛内设置页与 `POST /v1/config` 的写入只活在宿主内存里（**不落盘**）。持久化请用 DSH 原生「设置 → 插件」表单（依据插件导出的 `Config` 自动生成）；`health` 的 `settings` 字段报 `settings` 而不是 `unavailable` |
| R9 | 渲染半边在 DSH 0.2.x 下可能不出现 | `dsh.client.inject` 仍列着 `dsh-client-runtime` / `dsh-client-ui-primitives` / `dsh-client-ui-slots`，这三个包在 `0.2.1-rc.2` 已改名/重组。设置 tab 可能不出现；**不影响宿主半边、端点、岛 app 与跳转**。渲染半边适配是下一个独立任务 |
| R10 | 岛 app 的窗口/穿透手感只能在真机上评价 | §13 手测清单逐条过；`DSH_NOTCH_NO_LAUNCH=1` 便于单独调试 app |

### 明确**不**做的事（避免再次长出来）

- 不读任何会话文件（zstd / jsonl / projection cache）。
- 不做 mtime / 扫描缓存 / 目录遍历。
- 不做自动下载安装与自更新。
- 不新增配置文件（配置只在 `settings.yaml`）。
- 不往会话日志里写自定义事件。
- 不把 thinking 正文搬进 IPC。
- 不依赖 `settingsScope` / `configForms` / `localStorage` 中的任何一个。

---

## 15. 附录 A：关键 DSH API 速查（均已核对源码）

| 用途 | API | 出处 |
| :--- | :--- | :--- |
| 注册配置（0.1.x 专用） | `ctx.inject(["settings"], c => c.settings.register(settingsNamespace(ns), Schema, { base }))` → `SettingsScope{get,watch,update}` | `dsh-client-ui-theme/lib/index.js:71-74`；`dsh-settings/README.zh.md:11` |
| namespace 助手（0.1.x 专用） | `import { settingsNamespace } from "@deepseek-ai/dsh-settings"` | `dsh-client-ui-theme/lib/index.js:1`；**0.2.1-rc.2 已删除该导出，不要静态 import** |
| 配置（0.2.x 当前桌面版） | 命名空间就是插件 id 字符串；配置由 profile 条目持久化，cordis 在 `apply(ctx, config)` 第二参数传入；表单由 DSH 依据插件导出的 `Config` 自动生成（`dsh-settings` 只导出 `SettingsForms`，无 `register`） | DSH 安装目录的 `resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js`（0.2.1-rc.2） |
| agent 状态 | `ctx.on("agent/status", ({agent,status}) => …, { global: true })`，`status: "idle"|"running"`，`agent.id` 即 `SessionId` | `dsh-agent/lib/types/runtime-types.d.ts:160-172` |
| agent 注册表 | `ctx.agents.list(): Agent[]` / `ctx.agents.get(id): Agent | undefined` | `dsh-agent/lib/types/index.d.ts:349,363` |
| 会话事件 | `ctx.on("session/event", (session, event) => …)`，`@mode emit` | `dsh-session/lib/types/*.d.ts` |
| 事件负载 | `event = {type, seq, time, data}`，负载**在 `event.data` 里**：`turn/start{turn}` `turn/end{turn,reason}` `step/start{turn,step}` `tool/call{turn,step,callId,name,arguments}` `tool/result{turn,step,message,error?}`（无 `callId`，配对看 `data.message.content[i].toolCallId`）`todo/write{todos}` `assistant/message{turn,step,message,usage?}` | `dsh-session/lib/types/types.d.ts:223-354`（`SessionEventMap`）、`:398-430`（`SessionEvent`） |
| 设置 slot 注册 | `ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({name, id, order, label, locale, inject}, Comp))` | 真实调用：`dsh-client-ui-settings-plugin-inventory/lib/client.js:285-292`（`id:'all'`、`order:10`、`label:()=>t("tab")`）；槽位清单：`dsh-cordis-client-runner/lib/client.js:3188-3225` |
| 设置 slot 契约要点 | `id` **必填**且复用自带 id（`all` / `configurable`）会**替换**它；`label` 不给就是无名 tab | 同上（`registerOptions` 文档） |
| **跳转（切会话）** | `ctx.uiWorkspace.openSession(id)` —— `uiWorkspace` 服务由 `dsh-client-ui-workspace` 提供；`sessions.open` / `manager.select` 仅作旧版 DSH 兜底 | `dsh-client-ui-workspace/lib/client.js:1380`（`super(ctx, "uiWorkspace")`）/ `:1470`（`openSession`）；侧栏/toast 的第一方调用点同文件 `:5063`、`:5172` |
| **当前会话（焦点）** | `ctx.sessions.list` 是 snapshot store；`getSnapshot().current` / `subscribe(fn)`（返回退订函数） | `dsh-client-runtime/lib/client.js:8913-8928`（`createSnapshotStore`）、`9905` |
| 客户端插件声明 | `package.json` 的 `dsh.client` **只认** `platform`（string）/ `inject`（**包名**数组）/ `immediately`（bool）；其它键被静默丢弃（所以自造的 `external` 是死配置） | `dsh-client-modules/lib/index.js:61-73` |
| 原生 UI 原子 | `StateDot` `DisclosureRow` `Button` `Pill` `Menu` `Modal` `Input` `Toast` `HoverCard` `ic_ds_*` | `dsh-client-ui-primitives/README.zh.md:5` |
| 为什么不能走原生配置卡片 | `WEB_SETTINGS_NAMESPACES`（`agent-loop`/`shell`/`locale`/`permission`/`ui-conversation`/`ui-theme`/`web-search-deepseek`）+ `PRODUCT_SETTINGS_NAMESPACES`，且注释写明 self-expose 是 deferred | `dsh-host-apiproxy/lib/index.js:884-896,1001,2410-2415` |
| settings namespace 规则 | `settingsNamespace(v)` 只做校验：必须匹配 `/^[a-z][a-z0-9-]*$/`（identity 函数）→ 我们的分节名就是 `dsh-notch-win` | `dsh-settings/lib/index.js:81-89` |
| 插件包形态 | `package.json` 的 `dsh.bundle.patch` + `dsh.client.inject`；`exports["./client"]`（string 或 `{default: string}`） | `dsh-client-modules/lib/index.js:75-85`；真实样例：`@deepseek-ai/dsh-client-ui-theme/package.json` |

---

## 16. 附录 B：环境与版本结论

| 检查 | 结论 |
| :--- | :--- |
| `ctx.settings` 是否可用 | DSH 0.1.x 可用（`dsh-settings-file` 挂载 `settings.yaml`）；0.2.x 改为 `SettingsForms` + `apply(ctx, config)`，见 §5 注 |
| 配置落点 | 0.1.x：`~/.dsh/settings.yaml` 的分节；0.2.x：profile 条目配置 |
| 会话日志 | 文件名随 DSH 版本与压缩配置变化（`session.v4.jsonl.zstd` / `session.jsonl.zstd`；`compression:"none"` 时无 `.zstd`）→ 本设计不依赖它 |
| 岛 app 产出 | `app/dist/win-unpacked/DSHNotch.exe`；宿主按 §7.10 的顺序查找，不要求全局安装 |
| 端口段 | **47411** 起，只绑回环 |

---

*本文档记录的是**已完成**的实现（P1–P6 全绿）；剩余工作见 §14-R9（渲染半边 0.2.x 适配）。*
