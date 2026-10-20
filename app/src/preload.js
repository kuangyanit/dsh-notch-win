'use strict';

/**
 * 渲染层与主进程之间唯一的桥。
 *
 * 这里顺便把 `protocol.cjs` 交给渲染层：渲染层是普通网页（`nodeIntegration:false`、
 * `contextIsolation:true`），**不能 require**，而协议常量又不该在项目里出现第三份
 * 手抄副本。所以由 preload 读 `protocol.cjs`（它就是 `lib/protocol.js` 的生成产物）
 * 并把常量对象暴露过去。
 */
const { contextBridge, ipcRenderer } = require('electron');

const P = require('./protocol.cjs');

function subscribe(channel, listener) {
  const wrapped = (_event, message) => listener(message);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('island', {
  /** 协议常量（全场唯一来源，见文件头）。 */
  protocol: { ...P },

  onSnapshot(listener) {
    return subscribe('island:snapshot', listener);
  },
  onPointer(listener) {
    return subscribe('island:pointer', listener);
  },

  jump(sessionId) {
    return ipcRenderer.invoke('island:jump', { sessionId });
  },
  ack(sessionId) {
    return ipcRenderer.invoke('island:ack', { sessionId });
  },
  setInteractive(value) {
    return ipcRenderer.invoke('island:set-interactive', value === true);
  },
  hide() {
    return ipcRenderer.invoke('island:hide');
  },
  show() {
    return ipcRenderer.invoke('island:show');
  },
  quit() {
    return ipcRenderer.invoke('island:quit');
  },
  openLog() {
    return ipcRenderer.invoke('island:open-log');
  },
  openDataDir() {
    return ipcRenderer.invoke('island:open-data-dir');
  },
  contextMenu() {
    return ipcRenderer.invoke('island:context-menu');
  },
});
