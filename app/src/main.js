'use strict';

/**
 * 岛 app 的主进程。
 *
 * 唯一职责：**当一块画布 + 一个跳转按钮**。
 * 状态机、配置、端口全在宿主半边（DSH 进程里），这里从 `/v1/state` 拿到一份
 * 现成的快照，转发给渲染层画出来；点某一行就把 `sessionId` POST 回去。
 *
 * 因此这个文件里没有：会话文件解析、zstd、projection、mtime 启发式、
 * 自更新、安装器。旧实现有 49KB 都在做那些事，而它们正是崩溃与"看不到状态"
 * 的来源。
 *
 * ## Windows 上必须做对的几件事（都有真机事故背景）
 *
 * | 事项 | 不做会怎样 |
 * | --- | --- |
 * | 窗口按最大展开态一次开好，展开只在窗口内改宽高 | 每次展开都触发 DWM 窗口动画，弹簧动画会抖 |
 * | `transparent` + `hasShadow:false` + `skipTaskbar` | 出现黑色方块 / 任务栏多一个图标 / 抢 Alt+Tab |
 * | `backgroundThrottling:false` | 失焦后 Chromium 把定时器降频，250ms 轮询变成半天不动 |
 * | 穿透为常态，指针进岛才临时接管（`forward:true`） | 岛会挡住它下面所有东西的点击 |
 * | 三道防线收回穿透（渲染层 mouseleave / 看门狗 / 隐藏时复位） | 渲染层漏发一次就永久挡住点击 |
 */
const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, screen, shell } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');

const P = require('./protocol.cjs');
const { findLiveHost } = require('./endpoint.js');
const { createHostClient } = require('./host-client.js');

/**
 * 窗口尺寸。按**最大展开态**一次开好，展开/收起由渲染层在窗口内部完成
 * （岛顶对齐、水平居中），窗口尺寸一个字节都不动 —— 于是没有 DWM 动画。
 */
const MAX_WINDOW = { w: 484, h: 460 };

/** 消息/日志里用的短 id：去掉 `session-` 前缀，避免只显示一个 "session-"。 */
function shortSessionId(id) {
  const s = String(id ?? '');
  const stripped = s.startsWith('session-') ? s.slice('session-'.length) : s;
  return stripped.slice(0, 8);
}

/** 连不上宿主时的重试节奏。 */
const POLL_OFFLINE_MS = 3000;
/** 穿透看门狗周期。 */
const WATCHDOG_MS = 500;

let win = null;
let tray = null;
let client = null;
let host = null;

let lastPayload = null;
let lastRev = null;
let rendererLoaded = false;
let interactive = false;
let requestedHidden = false;
let appliedScale = 1;

let pollTimer = null;
let watchdogTimer = null;
let quitting = false;

// ───────────────────────────── 窗口 ─────────────────────────────

function assetPath(name) {
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(process.resourcesPath || '', 'assets', name),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 把窗口摆到主显示器工作区顶端中间。只在启动、`scale` 变化、显示器几何变化
 * 时调用 —— **不参与展开动画**。
 */
function placeWindow(force = false) {
  if (!win || win.isDestroyed()) return;
  const width = Math.round(MAX_WINDOW.w * appliedScale);
  const height = Math.round(MAX_WINDOW.h * appliedScale);

  let area;
  try {
    area = screen.getPrimaryDisplay().workArea;
  } catch (error) {
    return;
  }
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = area.y;

  // 容差 2px：DPI 取整会让"设 484 读到 485"，没容差就会反复重设并触发 DWM 动画。
  const tolerance = 2;
  const bounds = win.getBounds();
  if (
    !force &&
    Math.abs(bounds.width - width) <= tolerance &&
    Math.abs(bounds.height - height) <= tolerance &&
    Math.abs(bounds.x - x) <= tolerance &&
    Math.abs(bounds.y - y) <= tolerance
  ) {
    return;
  }
  win.setBounds({ x, y, width, height });
}

function applyScale(scale) {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
  if (scale === appliedScale) return;
  appliedScale = scale;
  if (win && !win.isDestroyed()) {
    // zoomFactor 让岛"整体"变大变小（含字体），窗口同步放大 —— 两者的比例
    // 互相抵消，所以渲染层永远按 MAX_WINDOW 那一套 CSS 尺寸布局。
    try {
      win.webContents.setZoomFactor(scale);
    } catch (error) {
      /* 页面还没就绪 */
    }
  }
  placeWindow(true);
}

/**
 * 由**最新快照里的配置**决定显示与否。
 *
 * 配置从快照里来（`payload.config`），所以岛不需要读任何配置文件 ——
 * 你在 DSH 设置页改一下，下一次轮询（≤1s）就生效。
 */
function applyVisibility() {
  if (!win || win.isDestroyed()) return;

  const config = lastPayload && lastPayload.config ? lastPayload.config : null;
  const entries = lastPayload && Array.isArray(lastPayload.entries) ? lastPayload.entries : [];
  const live = entries.filter((entry) => entry.live === true).length;

  let visible = true;
  if (requestedHidden) visible = false;
  else if (config && config.enabled === false) visible = false;
  else if (config && config.hideWhenIdle === true && live === 0) visible = false;
  // 首帧还没到就先别露出来：透明窗口先出现的话，肉眼看到的是"空一下再弹出内容"。
  if (!rendererLoaded || lastPayload === null) visible = false;

  if (config) applyScale(config.scale);

  if (visible) {
    if (!win.isVisible()) win.showInactive(); // 不抢焦点
  } else if (win.isVisible()) {
    win.hide();
    releasePointer('hidden');
  }
}

// ───────────────────────── 指针 / 点击穿透 ─────────────────────────

/** 收回穿透（岛不可点），并让渲染层丢掉悬停态。三道防线的公共出口。 */
function releasePointer(reason) {
  interactive = false;
  if (win && !win.isDestroyed()) {
    try {
      win.setIgnoreMouseEvents(true, { forward: true });
    } catch (error) {
      /* 窗口正在销毁 */
    }
    if (rendererLoaded) win.webContents.send('island:pointer', { interactive: false, reason });
  }
}

/**
 * 看门狗：指针已经不在窗口里了，若 `interactive` 还是 true 就强制收回。
 * 存在的理由是渲染层可能因为收不到 `mouseleave` 而"忘了"发 false，
 * 那种状态下岛会永久挡住它下面所有东西的点击。
 */
function watchdog() {
  if (!interactive || !win || win.isDestroyed()) return;
  let point;
  let bounds;
  try {
    point = screen.getCursorScreenPoint();
    bounds = win.getBounds();
  } catch (error) {
    return;
  }
  const inside =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height;
  if (!inside) releasePointer('watchdog');
}

// ───────────────────────────── 轮询 ─────────────────────────────

function sendSnapshot(payload) {
  if (!rendererLoaded || !win || win.isDestroyed()) return;
  win.webContents.send('island:snapshot', { ok: true, payload });
}

function sendOffline(message) {
  if (!rendererLoaded || !win || win.isDestroyed()) return;
  win.webContents.send('island:snapshot', { ok: false, error: message });
}

function markOffline(message) {
  host = null;
  if (client) client.base = null;
  lastRev = null;
  sendOffline(message);
  applyVisibility();
}

/**
 * 一拍。
 *
 * 间隔是**动态**的：有会话在执行（或指针正悬在岛上）时 250ms，
 * 全空闲时 1000ms，连不上宿主时 3000ms。空闲时上限就是 1 拍/秒。
 */
async function tick() {
  if (quitting) return;
  let delay = P.STATE_POLL_IDLE_MS;

  try {
    if (host === null || !client.connected) {
      const found = await findLiveHost((port) => client.probe(port));
      if (!found) {
        markOffline('没有正在运行的 DSH 宿主半边');
        schedule(POLL_OFFLINE_MS);
        return;
      }
      host = found;
      client.base = `http://127.0.0.1:${found.port}`;
      lastRev = null; // 换了宿主：去重游标必须重置
    }

    const payload = await client.state(lastRev);
    if (payload && payload.unchanged === true) {
      // 内容没变：不惊动渲染层，但可见性仍要重算（例如 hideWhenIdle 刚满足）。
      applyVisibility();
    } else if (payload) {
      lastRev = payload.rev;
      lastPayload = payload;
      sendSnapshot(payload);
      applyVisibility();
    }

    const entries = lastPayload && Array.isArray(lastPayload.entries) ? lastPayload.entries : [];
    const busy = entries.some((entry) => entry.live === true);
    delay = busy || interactive ? P.STATE_POLL_ACTIVE_MS : P.STATE_POLL_IDLE_MS;
  } catch (error) {
    markOffline(`与宿主的连接断了：${error && error.message ? error.message : error}`);
    delay = POLL_OFFLINE_MS;
  }

  schedule(delay);
}

function schedule(delay) {
  if (quitting) return;
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    void tick();
  }, delay);
}

// ───────────────────────────── 创建 ─────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: Math.round(MAX_WINDOW.w * appliedScale),
    height: Math.round(MAX_WINDOW.h * appliedScale),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    title: 'DSHNotch',
    icon: assetPath('icon.png') || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ⚠️ 不能省：窗口失焦/被遮挡时 Chromium 会把定时器降频。
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 穿透为常态。`forward:true` 让 mousemove 继续进渲染层 —— 命中判定靠它。
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 岛只有一个窗口：任何"打开新窗口/导航走"都拒掉。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
    try {
      win.webContents.setZoomFactor(appliedScale);
    } catch (error) {
      /* 忽略 */
    }
    // 首拍通常比 loadFile 更早，那时发出去的消息没有订阅者会被静默丢掉；
    // 而 rev 去重意味着内容不变就再也不会补发 —— 岛会白屏到第一次状态变化。
    // 所以这里必须补发，并清掉去重游标保证下一拍一定发。
    if (lastPayload) sendSnapshot(lastPayload);
    else lastRev = null;
    applyVisibility();
  });

  win.on('closed', () => {
    win = null;
    releasePointer('window-closed');
  });

  placeWindow(true);
}

function showFromSecondInstance() {
  requestedHidden = false;
  if (win && !win.isDestroyed()) {
    win.showInactive();
  }
  lastRev = null;
  schedule(0);
}

function createTray() {
  const icon = assetPath('tray.png');
  if (!icon) return;
  try {
    tray = new Tray(nativeImage.createFromPath(icon));
  } catch (error) {
    return; // 托盘只是逃生口，建不起来不影响岛
  }
  tray.setToolTip('DSHNotch');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示', click: () => showFromSecondInstance() },
      {
        label: '隐藏',
        click: () => {
          requestedHidden = true;
          applyVisibility();
        },
      },
      { type: 'separator' },
      { label: '打开配置目录', click: openDataDir },
      { label: '打开宿主日志', click: openHostLog },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showFromSecondInstance());
}

function openDataDir() {
  shell.openPath(require('./endpoint.js').dataDir());
}

function openHostLog() {
  const file = lastPayload && lastPayload.runtime ? lastPayload.runtime.logFile : null;
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
  else openDataDir();
}

// ───────────────────────────── IPC ─────────────────────────────

function registerIpc() {
  /** 点岛上的某一行 → 让 DSH 切过去。 */
  ipcMain.handle('island:jump', async (_event, payload) => {
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (sessionId === '') return { ok: false, message: '缺少 sessionId' };
    if (lastPayload && lastPayload.config && lastPayload.config.jumpEnabled === false) {
      return { ok: false, message: '跳转已在设置里关闭' };
    }
    try {
      const result = await client.jump(sessionId);
      schedule(0); // 立刻回一拍，让界面马上反映"已切过去"
      return { ok: true, message: `已请求切换到 ${shortSessionId(sessionId)}`, seq: result && result.seq };
    } catch (error) {
      // 跳不动时至少把 id 放进剪贴板：用户还能自己在 DSH 里找。
      try {
        clipboard.writeText(sessionId);
        return {
          ok: false,
          message: `跳转失败（会话 id 已复制）：${error && error.message ? error.message : error}`,
        };
      } catch (clipboardError) {
        return { ok: false, message: `跳转失败：${error && error.message ? error.message : error}` };
      }
    }
  });

  /** 点表头确认“已完成/已停止”，把它刷回空闲。 */
  ipcMain.handle('island:ack', async (_event, payload) => {
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (sessionId === '') return { ok: false, message: '缺少 sessionId' };
    try {
      await client.ack(sessionId);
      schedule(0); // 立刻回一拍，把状态刷成空闲
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    }
  });

  /** 指针进岛/出岛 → 切点击穿透。判定在渲染层（它有岛的当前矩形）。 */
  ipcMain.handle('island:set-interactive', (_event, value) => {
    interactive = value === true;
    if (win && !win.isDestroyed()) {
      try {
        win.setIgnoreMouseEvents(!interactive, { forward: true });
      } catch (error) {
        /* 忽略 */
      }
    }
    return true;
  });

  ipcMain.handle('island:hide', () => {
    requestedHidden = true;
    applyVisibility();
    return true;
  });

  ipcMain.handle('island:show', () => {
    requestedHidden = false;
    applyVisibility();
    schedule(0);
    return true;
  });

  ipcMain.handle('island:quit', () => {
    app.quit();
    return true;
  });

  ipcMain.handle('island:open-log', () => {
    openHostLog();
    return true;
  });

  ipcMain.handle('island:open-data-dir', () => {
    openDataDir();
    return true;
  });

  /** 右键菜单：岛本身没有别的交互，这几项就是全部。 */
  ipcMain.handle('island:context-menu', () => {
    if (!win || win.isDestroyed()) return false;
    const config = lastPayload && lastPayload.config ? lastPayload.config : null;
    Menu.buildFromTemplate([
      {
        label: config && config.enabled === false ? '已停用（在 DSH 设置里开启）' : '停用灵动岛',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: '隐藏到托盘',
        click: () => {
          requestedHidden = true;
          applyVisibility();
        },
      },
      { label: '打开宿主日志', click: openHostLog },
      { label: '打开配置目录', click: openDataDir },
      { type: 'separator' },
      { label: '退出岛 app', click: () => app.quit() },
    ]).popup({ window: win });
    return true;
  });
}

// ───────────────────────────── 生命周期 ─────────────────────────────

// **必须**先把自己的 userData 挪开，再抢单实例锁。
// Electron 的单实例锁就落在 userData 里，而本 app 的 productName 也叫 `DSHNotch`，
// 打包后默认 userData 同样是 `%APPDATA%\DSHNotch` —— 与其它同样叫 DSHNotch 的
// app **撞在一起**。共用一个 userData 的后果：谁先启动谁活，
// 后启动的那个静默退出（连窗口都不建），表现为"重启了但岛没出现"，且不报错。
// 顺带把 GPU 缓存/Cache 也分开，免得两个 app 互相污染。
//
// 目录必须**先建好**：Chromium 的 process singleton 需要往 userData 里写锁文件，
// 目录不存在时 requestSingleInstanceLock() 会失败（错误是 "Lock file can not be
// created: 系统找不到指定的路径"），随后 app.quit()，表现同样是"静默退出"。
const userDataDir = path.join(app.getPath('appData'), 'dsh-notch-win');
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);

// 不锁的话，宿主每次启动都会再拉起一个岛，两个岛叠在一起。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showFromSecondInstance());

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    client = createHostClient();
    registerIpc();
    createWindow();
    createTray();

    screen.on('display-metrics-changed', () => placeWindow());
    screen.on('display-added', () => placeWindow());
    screen.on('display-removed', () => placeWindow());

    watchdogTimer = setInterval(watchdog, WATCHDOG_MS);
    watchdogTimer.unref?.();

    schedule(0);
  });

  app.on('before-quit', () => {
    quitting = true;
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (watchdogTimer !== null) clearInterval(watchdogTimer);
  });
}
