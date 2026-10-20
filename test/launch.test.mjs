/**
 * 岛 app 子进程环境的测试。这条是真实事故的回归钉：
 *
 * DSH 桌面版用 `ELECTRON_RUN_AS_NODE=1` 跑自己的宿主进程，插件若原样继承
 * 环境去 spawn Electron 岛，岛会以纯 Node 模式执行 main.js、立刻退出 ——
 * host.log 写着“已拉起”，但窗口永远不出现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { islandAppEnv } from '../lib/launch.js';

test('拉起岛 app 前必须删掉 ELECTRON_RUN_AS_NODE', () => {
  const env = islandAppEnv(
    { ELECTRON_RUN_AS_NODE: '1', PATH: 'C:\\Windows', DSH_HOME: 'C:\\Users\\x\\.dsh' },
    'C:\\data\\dsh-notch-win',
  );

  assert.equal('ELECTRON_RUN_AS_NODE' in env, false, '带这个变量 Electron 会退化成纯 Node');
  assert.equal(env.PATH, 'C:\\Windows', '其它环境变量必须原样保留');
  assert.equal(env.DSH_HOME, 'C:\\Users\\x\\.dsh');
  assert.equal(env.DSH_NOTCH_DATA_DIR, 'C:\\data\\dsh-notch-win');
});

test('不带 dataDir 覆盖时保持原样，且不改动入参', () => {
  const base = { ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' };
  const env = islandAppEnv(base);

  assert.equal(env.NODE_ENV, 'production');
  assert.equal('DSH_NOTCH_DATA_DIR' in env, false);
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1', '不能修改调用方传进来的对象');
});
