/**
 * @module @dsh-external/dsh-notch-win/launch
 *
 * 拉起岛 app 之前的**子进程环境**处理。看起来只是一个 env 复制，但这里踩过一个
 * 很典型的坑，必须单独成一模块并由单测钉住。
 *
 * ## 为什么必须删掉 `ELECTRON_RUN_AS_NODE`
 *
 * DSH 桌面版（0.2.1-rc.2）用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以
 * 纯 Node 模式运行自己的宿主进程（见 DSH 进程环境）。插件如果直接
 * `spawn(appExe, [], { env: { ...process.env } })`，变量会一路传进岛 app：
 * 岛是 Electron 应用，拿到 `ELECTRON_RUN_AS_NODE=1` 后**不启动 Chromium**，
 * 而是把 `src/main.js` 当普通 Node 脚本执行 —— `require('electron')` 拿不到
 * `app` / `BrowserWindow`，第一行 `app.setPath(...)` 就抛错，进程立刻退出。
 *
 * 现象非常有迷惑性：
 * - 宿主 `host.log` 里明明写着 `已拉起岛 app：…\DSHNotch.exe`（spawn 成功）；
 * - 任务管理器里却找不到 `DSHNotch.exe`，窗口更不会出现；
 * - `%APPDATA%\dsh-notch-win`（Electron userData）的 mtime 也不更新 ——
 *   因为 Chromium 根本没起来。
 *
 * 所以：**子进程环境里绝不能带 `ELECTRON_RUN_AS_NODE`**。
 */

/**
 * 构造岛 app 的子进程环境。
 *
 * @param {NodeJS.ProcessEnv} base 宿主进程环境（默认 `process.env`）。
 * @param {string}  [dataDirPath] 数据目录覆盖（写进 `DSH_NOTCH_DATA_DIR`，让岛
 *                                和宿主找同一批 `endpoint-<pid>.json`）。
 * @returns {NodeJS.ProcessEnv}
 */
export function islandAppEnv(base = process.env, dataDirPath) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  if (typeof dataDirPath === 'string' && dataDirPath !== '') {
    env.DSH_NOTCH_DATA_DIR = dataDirPath;
  }
  return env;
}
