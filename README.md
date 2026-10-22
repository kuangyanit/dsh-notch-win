# dsh-notch-win

Windows 端 DSH 灵动岛：一个浮在所有窗口之上的状态岛（闲置时是一条胶囊，悬停展开成 HUD），显示 agent 的执行状态、工作区、工具、上下文占用、累计 Token、子代理层级与聚合待办；点岛上任一会话可让 DSH 切过去。

> **当前状态：代码完成、单测 130/130 全绿。宿主半边已在 DSH `0.2.1-rc.2` 的真实
> cordis 4.0.5 / schemastery 3.18.5 组合下验证：能加载、能写 `host.log`、能拉起
> `DSHNotch.exe`（重启 DSH 后生效）。渲染半边（设置页）的 0.2.x 适配仍未做，见
> 「已知限制」R8/R9。**
> 设计的来龙去脉、每条 DSH 约束的源码出处、以及"为什么不用某个看起来更省事的方案"，都在 [`DESIGN.md`](./DESIGN.md)。**先读它。**

## 设计要点

- **状态在 DSH 宿主进程内计算**：订阅 `agent/status` + `session/event`，用内存状态机累加；不读会话文件、不解压 zstd，也不靠投影缓存或 mtime 来推断状态。
- **空闲零定时器**：只有岛或设置页请求时才重算，150 ms 节流。
- **配置只有一条通路**：DSH 自己的 profile 配置（0.1.x 的 `settings.yaml` 分节 / 0.2.x 的 profile 条目与自动表单）；渲染层不碰 `settingsScope` / `localStorage`。
- **设置页是原生标签页**：注册在「设置 → 插件」里，外壳与主题令牌由 DSH 提供。
- **跳转走官方导航 API**：`uiWorkspace.openSession(id)`，另保留 `sessions.open` / `manager.select` 兜底。
- **端点按进程隔离**：每个宿主写自己的 `endpoint-<pid>.json`，连接前校验 pid 活性、health 返回的 pid 与协议版本，不复用别人的端口。
- **不碰安装链**：只启动已存在的 `DSHNotch.exe`，不下载、不校验和、不自更新。
- **Windows only**：macOS 明确不做；宿主半边与协议可复用于将来的 `dsh-notch-mac`。

## 目录

| 路径 | 说明 |
| :--- | :--- |
| `DESIGN.md` | 详细设计文档（含每条 DSH 约束的源码出处） |
| `README.md` | 使用、安装与诊断 |
| `CONTRIBUTING.md` | 贡献指南 |
| `LICENSE` | MIT |
| `THIRD_PARTY_NOTICES.md` | 第三方版权与许可声明 |
| `package.json` | `@dsh-external/dsh-notch-win`：`dsh.bundle.patch` + `dsh.client.inject` |
| `dsh.plugin.json` | 插件元数据 |
| `cordis.patch.yml` | 把宿主半边 insert 进 DSH 的 Cordis 插件栈 |
| `lib/` | 宿主半边（ESM，node）+ 渲染半边（手写浏览器 bundle） |
| `app/` | Electron 岛 app（打包后无运行时 npm 依赖） |
| `test/` | 单测（`node --test`） |
| `scripts/` | `lib/protocol.js` → `app/src/protocol.cjs` 的生成器 |

## DSH 版本兼容（0.1.x / 0.2.x）——「岛 app 不随 DSH 启动」就是这个原因

2026-10-19 起，桌面版 DSH 实际运行的是 `0.2.1-rc.2`（以本机 DSH 安装目录为准，以及
`DSH NEXT` 同版本）。这一版的 `@deepseek-ai/dsh-settings` **只导出**
`SettingsConflictError` / `SettingsForms` / `redactSecrets`：

- 没有 `settingsNamespace`；
- 没有 `register` / `SettingsScope{get,watch,update}`；
- 设置页表单改成 DSH 直接读插件导出的 `Config` 自动生成。

只面向 0.1.x 的版本曾在 `lib/config.js` 顶部静态导入 `settingsNamespace`。ESM 在**链接阶段**就报：

```
SyntaxError: The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'
```

于是 `apply()` 一次都没跑：`%LOCALAPPDATA%\dsh-notch-win\host.log` 不会生成、回环 HTTP
不起、`syncApp()` 不执行，**岛 app 自然也不会被拉起**（DSH 本身不受影响，所以现象就是
"DSH 好好的，岛就是不出来"）。

现在改为（见 `lib/config.js` 文件头、`lib/index.js` 的 settings 注入块）：

| | 0.1.x | 0.2.x（当前桌面版） |
| :--- | :--- | :--- |
| namespace | `settingsNamespace(PLUGIN_ID)`（branded 字符串） | 普通字符串 `PLUGIN_ID`（运行时就等于它） |
| 配置来源 | `ctx.inject(["settings"])` → `register()` → `SettingsScope` | cordis 在 `apply(ctx, config)` 的第二参数里直接给 |
| 配置写入 | `scope.update()` → `settings.yaml` | 暂无写回（见 R8）；DSH 原生表单负责持久化 |
| 设置页面 | 插件自己 `register` | DSH 依据导出的 `Config` 自动生成 |

所以代码里不再静态 import `dsh-settings`，只在 `settings` 服务**确实有 `register`** 时
才走 0.1.x 的注册路径；否则跳过注册、用 `config` 播种配置。

> 验证方式（真机）：重启 DSH 后看 `%LOCALAPPDATA%\dsh-notch-win\host.log` 是否出现，
> 里面应有 `加载 · pid …` → `回环 HTTP 已监听 …` → `已拉起岛 app：…`。
> 没有 `host.log` = 宿主半边仍然没被加载，先找 DSH 控制台/日志里的
> `notch-win (@dsh-external/dsh-notch-win): failed to import`。

### 第二个坑：`ELECTRON_RUN_AS_NODE`（日志写着「已拉起」，但哪都看不到岛）

2026-10-19 真机现象：`host.log` 明明有 `已拉起岛 app：…\DSHNotch.exe`，但任务管理器里
没有 `DSHNotch.exe`、任务栏/屏幕上都看不到岛、`%APPDATA%\dsh-notch-win` 的 mtime 也不更新。

原因：DSH 桌面版的**宿主进程本身**是用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯
Node 模式运行的。插件原来 `spawn(exe, [], { env: { ...process.env } })` 把这个变量原样传给
岛 app —— 岛也是 Electron 应用，拿到 `ELECTRON_RUN_AS_NODE=1` 后**不启动 Chromium**，
而是把 `app/src/main.js` 当普通 Node 脚本执行：`require('electron')` 拿不到
`app/BrowserWindow`，第一行 `app.setPath(...)` 就抛错，进程 ~200ms 退出。

修复：`lib/launch.js` 的 `islandAppEnv()` 会在 spawn 前删掉 `ELECTRON_RUN_AS_NODE`
（其余环境变量保留，并写入 `DSH_NOTCH_DATA_DIR`）；`lib/index.js` 还监听子进程
`exit`，异常早退会写一条：

```
WARN 岛 app 启动后只活了 213ms 就退出（code=0）—— …检查 ELECTRON_RUN_AS_NODE / 文件沙箱…
```

app 侧也顺手修了一个同类静默退出：`app.setPath('userData', …)` 之前先
`mkdirSync(..., { recursive: true })`，否则 userData 目录不存在时 Chromium 单实例锁
建不出来，`requestSingleInstanceLock()` 返回 false，app 直接 `quit()`。

> 注：从**被 DSH 沙箱/任务计划程序直接拉起的进程**里启动 Electron（包括纯净的
> Electron 发行版）在本机可能会崩在 `0x80000003`（Chromium 沙箱初始化失败，属启动
> 上下文问题）；以 Explorer 双击或 DSH 宿主拉起为准。若 `host.log` 出现上面的
> 「只活了 Xms 就退出」，把该行连同 Windows 事件日志里的 Application Error 一起看。

## 配置项

权威源是 DSH 自己的配置层：0.1.x 是 `~/.dsh/settings.yaml` 的 `dsh-notch-win:` 分节
（namespace 只允许小写 kebab）；0.2.x 是 profile 条目配置（DSH 依据插件导出的 `Config`
自动生成的「设置 → 插件」表单写这里）。插件不再静态 import `dsh-settings`。

| 键 | 类型 | 默认 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | bool | `true` | 岛总开关（关 = 不显示，也不拉起 app） |
| `hideWhenIdle` | bool | `false` | 所有会话都 idle 时把岛藏起来 |
| `jumpEnabled` | bool | `true` | 允许点击岛上会话跳转 |
| `expandOnHover` | bool | `true` | 指针悬停时展开 |
| `glowEffect` | bool | `true` | 状态发光/呼吸效果 |
| `scale` | number | `1` | 缩放，范围 `0.8`–`1.4` |
| `autoLaunchApp` | bool | `true` | DSH 启动时拉起岛 app |
| `appPath` | string | `""` | 岛 app 的 exe 路径覆盖（空 = 按下面的顺序自动找） |

### exe 查找顺序

1. `appPath`（非空）
2. `%LOCALAPPDATA%\dsh-notch-win\DSHNotch.exe`
3. `<插件包>\app\dist\win-unpacked\DSHNotch.exe`（electron-builder 默认产出）
4. `<插件包>\app\dist\DSHNotch.exe`

取第一个真实存在的。都不存在就记一条 warn 并放弃（**不重试、不下载、不安装**）。

## 安装（本地开发）

插件没有发布到 registry，所以按本地依赖装进 DSH 的 profile。下文的 `<本仓库路径>` 指你克隆或放置本仓库的目录。

1. 改 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：

   ```jsonc
   {
     "dependencies": {
       "@dsh-external/dsh-notch-win": "link:<本仓库路径>"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // …原有的…
           "@dsh-external/dsh-notch-win"
         ]
       }
     }
   }
   ```

   > 用 **`link:`** 而不是 `file:`：`link:` 会做成目录联接（Junction），改完 `lib/` 重启 DSH 就生效；`file:` 是把文件拷进去，每次改都要重装。二者解析 `@deepseek-ai/*` 的结果相同（宿主的 profile 根目录挂着那份）。

2. 在该 profile 目录里跑一次安装（`link:` 不需要联网）：

   ```powershell
   cd %USERPROFILE%\.dsh\profiles\desktop
   pnpm install --no-frozen-lockfile
   ```

3. 构建岛 app：

   ```powershell
   cd <本仓库路径>\app
   npm install
   npm run dist:dir     # 产出 dist\win-unpacked\DSHNotch.exe
   ```

   > 若 `dist:dir` 卡在 `connect ETIMEDOUT ...:443`（github.com 不可达），那是 electron-builder 在下 `winCodeSign`（只用来改 exe 图标/版本号并签名）。用 `npm run dist:dir:nosign` 跳过它 —— 代价只是 exe 保留 Electron 的默认图标与文件属性，**功能无影响**（托盘图标与窗口图标都走我们自己的 `assets/*.png`，不进 exe 资源）。

   装成 `link:` 之后**不需要**把 exe 复制到任何地方：宿主按 §7.10 的顺序查找，会直接命中 `<插件包>\app\dist\win-unpacked\DSHNotch.exe`（也就是这里刚产出的那个），重新打包即刻生效。

4. 重启 DSH。岛应在几秒内出现（DSH `0.2.1-rc.2` 需要重启才会重新加载插件；见上面的「DSH 版本兼容」）。设置页在 **设置 → 插件 → 灵动岛**。

> 插件使用独立的 id、settings namespace、端口段与 app 数据目录，可与其它同类插件同时安装；但多个岛会画在同一位置，没有实际意义，建议同一时间只启用一个。

## 诊断

| 想看什么 | 在哪 |
| :--- | :--- |
| 宿主日志 | `%LOCALAPPDATA%\dsh-notch-win\host.log`（每次 DSH 启动把上一份**轮转**成 `host.prev.log`，不是截断） |
| **插件到底加载没** | `host.log` 不存在 = 宿主半边没加载。先找 DSH 控制台/日志里的 `notch-win (@dsh-external/dsh-notch-win): failed to import`。桌面版 DSH 的宿主 stdout 不落盘（`~/.dsh/logs/desktop-next.log` 是 DSH NEXT 通道的日志） |
| **日志说「已拉起」但看不到岛** | 先看任务管理器有没有 `DSHNotch.exe`；再搜 `host.log` 里的 `启动后只活了 … 就退出`。最常见原因是子进程继承了 `ELECTRON_RUN_AS_NODE`（见上面「第二个坑」）。也看 Windows 事件日志 Application Error（`0x80000003` = Chromium 沙箱初始化失败，通常是启动上下文问题） |
| 端口与端点文件 | 同目录下的 `endpoint-<pid>.json` |
| 岛是否连上宿主 | 岛的页脚：`宿主进程 … · 端口 …` 或"未连接" |
| 配置到底生效了没 | 设置页「运行状态」卡：配置来源（`settings` / `memory` / `defaults`）、端口、被追踪的会话、`appPath` 探测结果、设置注册错误 |
| 只想调 app，不想让 DSH 拉起它 | 环境变量 `DSH_NOTCH_NO_LAUNCH=1` |
| 想把整套运行时落点搬到别处（日志 + 端点文件） | 环境变量 `DSH_NOTCH_DATA_DIR=<目录>`；宿主拉起岛 app 时会把它一起传下去 |

日志里**不会**出现会话正文或工具参数（`detailText` 上限 120 字符）。

## 开发

```powershell
cd <本仓库路径>
npm test                 # node --test "test/**/*.test.mjs"，130 项
npm run gen-protocol     # lib/protocol.js → app/src/protocol.cjs
npm run check-protocol   # 断言生成物与源文件字节一致（CI 用）
```

> 在 DSH 自己的 pwsh 沙箱里跑 `npm test` 会因 `spawn EPERM` 失败（Node test runner 要
> spawn 子进程）；改用 `node --test --test-isolation=none "test/**/*.test.mjs"` 在
> 单进程里跑。

`lib/protocol.js` 是协议常量的**唯一出处**：

- `app/src/protocol.cjs` 由 `scripts/gen-app-protocol.mjs` 生成（`app/` 是 CJS，不能 `import` ESM）；
- `lib/client.js` 里的那份常量块由 `test/client.test.mjs` 逐项比对。

所以常量**只改 `lib/protocol.js`**，然后跑 `npm run gen-protocol`。

测试需要仓库内的 `node_modules/@deepseek-ai/*`（指向 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 的 junction），只为让 `lib/` 能用普通静态 import 又能离线跑；`node_modules` 应被 gitignore。

真机安装后**不需要**这些 junction：DSH 的 profile 根目录（`~/.dsh/profiles/node_modules`）本身就挂着一份 `@deepseek-ai/*`，Node 从 `<profile>/desktop/node_modules/@dsh-external/dsh-notch-win/lib/` 往上走就能解析到 —— 这也是 `peerDependencies` 栏里那些包在运行时"不用装也有"的原因。

`test/host.test.mjs` 跑的是**真实**的 `apply()` 与真实的回环 HTTP，但它被关进了笼子：数据目录由 `DSH_NOTCH_DATA_DIR` 指到系统临时目录（跑完自动删），并且设了 `DSH_NOTCH_NO_LAUNCH=1`，所以**不会**碰你的 `%LOCALAPPDATA%\dsh-notch-win`、也不会真的弹出岛窗口。文件顶部有一条断言专门保证前者 —— 这条断言存在的原因见 `DESIGN.md` §7.11。

## 已知限制

| # | 限制 |
| :--- | :--- |
| R1 | ~~渲染半边能否 `fetch` 自建回环端口~~ **已解决**：DSH 0.2.1-rc.2 渲染进程的 `Origin` 是 `dsh-app://app`，原先被 `originPolicy` 403；现已放行并回显。设置页、焦点上报与跳转轮询走同一条通路。 |
| R1b | Chromium 的 Private Network Access 会拦 `file://` → 回环的带自定义头 POST；已在预检里回 `Access-Control-Allow-Private-Network: true`，实测仍被拦则去掉自定义头改为靠 `Origin` + `Host` 栅栏。 |
| R2 | 上下文占用：分母来自 DSH token-meter 的 `contextPressure` 投影 / `request/context` 的 `contextWindow`，分子按 `inputTokens + cacheReadTokens + cacheWriteTokens` 计。拿不到分母时退化为显示已用 token 数（如 `上下文 12.3k`），不猜百分比。 |
| R7 | 同机跑两个 DSH 实例时，第二个实例的岛/设置页可能连到先响应的那个宿主（第三方插件拿不到"自己的宿主 pid"）。两边页脚都显示 pid 与端口，不会悄悄连错。 |
| R8 | DSH 0.2.x 的 settings 服务是 `SettingsForms`：没有 `register`/`SettingsScope`，所以**岛内自带设置页**（以及 `POST /v1/config`）写入的配置只活在宿主内存里，**不落盘**。持久化请用 DSH 原生的「设置 → 插件」表单（DSH 依据插件导出的 `Config` 自动生成，改完会重载插件）。`health` 里的 `settings` 字段在 0.2.x 下报 `settings`（配置来自 profile 条目）而不是 `unavailable`。 |
| R9 | 渲染半边的 `dsh.client.inject` 仍列着 `dsh-client-runtime` / `dsh-client-ui-primitives` / `dsh-client-ui-slots`，这三个包在 DSH `0.2.1-rc.2` 里**不存在**（客户端运行时已改名/重组）。所以 0.2.x 下设置 tab 可能根本不出现；**不影响宿主半边、端点、岛 app 与跳转**。渲染半边适配是下一个独立任务。 |
| — | macOS 明确不做。宿主半边与协议可整体复用，将来做 `dsh-notch-mac` 只需换 `app/`。 |

## 权威参考

- `DESIGN.md` §5 —— DSH 侧硬约束（每条都有 `@deepseek-ai/*` 的 `file:line` 出处）
- `DESIGN.md` §7 —— 宿主半边（订阅、采纳扫描、懒计算、HTTP、安全栅栏、降级矩阵）
- `DESIGN.md` §8 —— 渲染半边（为什么是 `uiWorkspace.openSession`、设置页契约、只走一条配置通路）
- `DESIGN.md` §10 —— 快照协议 v1（字段表 + 错误码）
- `DESIGN.md` §14 —— 风险与未决项

## 贡献

见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。本仓库只接受 issue，**不接受 Pull Request**；
新开的 PR 会被自动关闭。改动前请先跑一遍 `npm test`，并保持
`lib/protocol.js` → `app/src/protocol.cjs` 的生成物同步（`npm run check-protocol`）。

## License

[MIT](./LICENSE) © 2026 dsh-notch-win contributors

本项目在早期阶段参考并改编了 [DSH DeepIsland](https://github.com/myYangyunfan/dsh-deepisland)（DSH 插件 `dsh-vibe-island`）的部分代码。其版权声明与 MIT 许可全文见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。