/**
 * @module @dsh-external/dsh-notch-win/log
 *
 * 诊断日志。DSH 以 GUI 方式启动时宿主的 console 输出看不到，所以必须有文件那份。
 *
 * 两条纪律：
 * 1. **绝不在事件热路径里写日志。** `session/event` 是同步 emit，每条事件都落盘
 *    会把 DSH 拖慢。本模块只在生命周期节点（启动 / 配置 / 端口 / 跳转 / 异常）调用。
 * 2. **绝不记会话正文、工具参数、配置值以外的任何内容。** 跳转只记 sessionId 前 8 位。
 *
 * 与旧实现的差别：旧实现每次 DSH 启动**截断重写**诊断日志，于是上一次崩溃的现场
 * 永远看不到。这里改成轮转 —— 旧文件重命名为 `host.prev.log`，保留一轮。
 */
import fs from 'node:fs';
import { ensureDataDir, logFilePath, prevLogFilePath } from './paths.js';

const TAG = '[dsh-notch-win]';

let filePath = null;

function rotate() {
  if (filePath !== null) return filePath;
  try {
    ensureDataDir();
    const current = logFilePath();
    if (fs.existsSync(current)) {
      try {
        fs.renameSync(current, prevLogFilePath());
      } catch {
        try {
          fs.rmSync(current, { force: true });
        } catch {
          /* 轮转失败不影响本次运行 */
        }
      }
    }
    filePath = current;
  } catch {
    filePath = '';
  }
  return filePath;
}

function write(line) {
  const target = rotate();
  if (!target) return;
  try {
    fs.appendFileSync(target, line + '\n', 'utf8');
  } catch {
    /* 日志失败不能影响宿主 */
  }
}

function stamp() {
  try {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '?';
  }
}

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 创建日志句柄。`apply()` 一开始就调用它，因此会立刻落一行启动头 ——
 * 这行本身就是「插件是否被加载」的证据（旧实现的诊断日志正是干这个用的）。
 */
export function createLog() {
  rotate();
  write(`=== DSH 启动 ${stamp()} ===`);
  return {
    get path() {
      return filePath || null;
    },
    info(...args) {
      const msg = args.map(fmt).join(' ');
      write(`${stamp()} INFO  ${msg}`);
      try {
        console.log(TAG, msg);
      } catch {
        /* ignore */
      }
    },
    warn(...args) {
      const msg = args.map(fmt).join(' ');
      write(`${stamp()} WARN  ${msg}`);
      try {
        console.warn(TAG, msg);
      } catch {
        /* ignore */
      }
    },
    error(...args) {
      const msg = args.map(fmt).join(' ');
      write(`${stamp()} ERROR ${msg}`);
      try {
        console.error(TAG, msg);
      } catch {
        /* ignore */
      }
    },
  };
}
