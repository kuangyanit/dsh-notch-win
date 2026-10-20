/**
 * @module @dsh-external/dsh-notch-win/paths
 *
 * 文件系统落点。刻意集中在一个文件里，因为「插件随手在别处拼路径」正是
 * 旧实现把日志写进 `%APPDATA%\DSHNotch\`、配置写进 `client-config.json`、
 * 端点写进 `bridge.json` 三个互不相同位置的原因。
 *
 * 本模块是**宿主半边专用**（用了 `node:fs` / `node:os`），渲染半边不得引用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_EXE_NAME,
  ENDPOINT_PREFIX,
  ENDPOINT_SUFFIX,
  PLUGIN_ID,
} from './protocol.js';

/** 本包根目录（`lib/` 的上一级）。 */
export function pluginRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/**
 * `%LOCALAPPDATA%\<PLUGIN_ID>`。
 *
 * 用 LOCALAPPDATA 而不是 APPDATA(Roaming)：这里放的是运行时端点与诊断日志，
 * 不该跟着漫游配置文件走。
 *
 * `DSH_NOTCH_DATA_DIR` 可以整体覆盖它（测试与无头调试用）。**必须**有这条覆盖，
 * 因为端到端测试跑的是真实的 `apply()`：没有它，测试就会往用户真实的
 * `host.log` 里写诊断行（其中还有"跳过拉起岛 app"这种一看就像真实行为的行），
 * 也会往真实目录里丢 `endpoint-<pid>.json`。见 `test/host.test.mjs`。
 */
export function dataDir() {
  const override = process.env.DSH_NOTCH_DATA_DIR;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  const base =
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, PLUGIN_ID);
}

export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logFilePath() {
  return path.join(dataDir(), 'host.log');
}

export function prevLogFilePath() {
  return path.join(dataDir(), 'host.prev.log');
}

export function endpointFilePath(pid) {
  return path.join(dataDir(), `${ENDPOINT_PREFIX}${pid}${ENDPOINT_SUFFIX}`);
}

export function endpointFilePattern() {
  return /^endpoint-(\d+)\.json$/;
}

/**
 * 岛 app 可执行文件的候选路径，按优先级排列。
 *
 * 因为设计上砍掉了「自动下载 + 校验 + 安装」（DESIGN.md §3-D5），
 * 这里必须给出一个确定且可解释的查找顺序，而不是"猜"：
 *
 *   1. 用户在设置页填的 `appPath`
 *   2. `%LOCALAPPDATA%\<PLUGIN_ID>\<APP_EXE_NAME>`（把 exe 或整个 portable 目录丢这儿）
 *   3. `<包根>/app/dist/win-unpacked/<APP_EXE_NAME>`（`npm run dist:dir` 的产物）
 *   4. `<包根>/app/dist/<APP_EXE_NAME>`（把 exe 直接放到 dist 的手工布局）
 */
export function appExeCandidates(configuredPath) {
  const out = [];
  const push = (p) => {
    if (typeof p === 'string' && p.trim() !== '' && !out.includes(p)) out.push(p);
  };
  push(configuredPath);
  push(path.join(dataDir(), APP_EXE_NAME));
  push(path.join(pluginRoot(), 'app', 'dist', 'win-unpacked', APP_EXE_NAME));
  push(path.join(pluginRoot(), 'app', 'dist', APP_EXE_NAME));
  return out;
}

/** 返回第一个真实存在的候选路径；都不存在则返回 null。 */
export function resolveAppExe(configuredPath) {
  for (const candidate of appExeCandidates(configuredPath)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 权限/竞态：当作不存在继续往下找 */
    }
  }
  return null;
}
