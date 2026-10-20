'use strict';

/**
 * 端点发现：找到**还活着**的宿主半边。
 *
 * ## 为什么不是"直接连 47411"
 *
 * 旧实现在固定端口上「复用已在本机运行的桥」。日志里能看到它复用了**已经死掉**
 * 的宿主（`复用已在本机运行的桥 127.0.0.1:47311（宿主 pid 19704）`），于是跳转
 * 再也没有生效，而且没有任何提示。
 *
 * 这里改成：宿主每实例写一份 `endpoint-<pid>.json`，app 逐个
 *
 * 1. **pid 还活着吗**（`process.kill(pid, 0)`）—— 死了就把文件删掉，顺手清理；
 * 2. **`/v1/health` 回的 pid 与文件名里的 pid 一致吗** —— 挡住 pid 复用和
 *    "端口被别人抢了"；
 * 3. **协议版本对得上吗** —— 挡住旧实现（47311）和其它插件。
 *
 * 三条都过了才连。多开 DSH 时取 `startedAt` 最新的那个（DESIGN.md R7 记录了这个
 * 限制：同机多实例时岛只跟其中一个）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('./protocol.cjs');

/**
 * 与宿主半边 `lib/paths.js` 的 `dataDir()` **逐字一致**（含 `DSH_NOTCH_DATA_DIR` 覆盖，
 * 宿主拉起本 app 时会把这个变量传进来）。任何一边改了这里，`test/app.test.mjs`
 * 里"数据目录与宿主半边一致"那条会立刻红。
 */
function dataDir() {
  const override = process.env.DSH_NOTCH_DATA_DIR;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, P.PLUGIN_ID);
}

const FILE_RE = new RegExp(
  `^${P.ENDPOINT_PREFIX}(\\d+)${P.ENDPOINT_SUFFIX.replace(/\./g, '\\.')}$`,
);

/** 读出所有**格式合法**的端点文件（不在这里判断活性）。 */
function readEndpoints() {
  let names;
  try {
    names = fs.readdirSync(dataDir());
  } catch (error) {
    // 目录不存在是正常的（DSH 还没启动过）：不是错误。
    return [];
  }

  const found = [];
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (match === null) continue;
    const file = path.join(dataDir(), name);
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!payload || typeof payload !== 'object') continue;
      if (payload.protocol !== P.PROTOCOL_VERSION) continue;
      if (!Number.isInteger(payload.port) || payload.port <= 0) continue;
      found.push({
        file,
        pid: Number(match[1]),
        port: payload.port,
        startedAt: Number(payload.startedAt) || 0,
        version: payload.version || null,
      });
    } catch (error) {
      // 写到一半 / 手改坏了：跳过。删掉它反而会误伤正在写的那个。
    }
  }
  return found;
}

/**
 * 进程还在吗。
 *
 * 只有明确是 `ESRCH`（没有这个进程）才算死亡 —— 其它错误（例如权限不足）
 * 一律当作**还活着**，因为我们接下来会真的去探测 HTTP，误删一份活着的端点
 * 文件比多留一份死文件糟糕得多。
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

/**
 * @param probe `async (port) => health | null`，由调用方提供（便于单测注入）。
 * @returns `{ port, pid, version, startedAt, health }` 或 `null`。
 */
async function findLiveHost(probe) {
  const candidates = readEndpoints().sort((a, b) => b.startedAt - a.startedAt);

  for (const candidate of candidates) {
    if (!isPidAlive(candidate.pid)) {
      try {
        fs.rmSync(candidate.file, { force: true });
      } catch (error) {
        /* 删不掉也无所谓，下次再来 */
      }
      continue;
    }

    let health = null;
    try {
      health = await probe(candidate.port);
    } catch (error) {
      health = null;
    }
    if (!health) continue;
    // 端口可能被另一个进程占着（pid 复用 / 端口回收）：必须两个 pid 对得上。
    if (health.pid !== candidate.pid) continue;
    if (health.protocol !== P.PROTOCOL_VERSION) continue;

    return { ...candidate, health };
  }

  return null;
}

module.exports = { dataDir, findLiveHost, isPidAlive, readEndpoints };
