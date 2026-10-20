/**
 * 配置层测试。重点：
 * 1. `DEFAULTS` 必须与 schema 的 `.default()` 同源（hand-copy 一定会漂移）；
 * 2. 非法值必须在**落盘之前**被拒（这是 `/v1/config` 返回 400 的依据）；
 * 3. settings 服务缺席时必须如实报告 `persisted=false`，而不是假装写成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, DEFAULTS, NS, createConfigStore, project, resolveConfig } from '../lib/config.js';

test('DEFAULTS 就是从 schema 对空对象求值得到的', () => {
  assert.deepEqual(DEFAULTS, ConfigSchema({}));
});

test('字段集合与默认值符合 DESIGN.md §10 的 8 项', () => {
  assert.deepEqual(Object.keys(DEFAULTS).sort(), [
    'appPath',
    'autoLaunchApp',
    'enabled',
    'expandOnHover',
    'glowEffect',
    'hideWhenIdle',
    'jumpEnabled',
    'scale',
  ]);
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.hideWhenIdle, false);
  assert.equal(DEFAULTS.jumpEnabled, true);
  assert.equal(DEFAULTS.expandOnHover, true);
  assert.equal(DEFAULTS.glowEffect, true);
  assert.equal(DEFAULTS.scale, 1);
  assert.equal(DEFAULTS.autoLaunchApp, true);
  assert.equal(DEFAULTS.appPath, '');
});

test('namespace 就是插件 id', () => {
  assert.equal(NS, 'dsh-notch-win');
});

test('seed：用宿主交来的配置播种（0.2.x），空对象保持 defaults', () => {
  const store = createConfigStore({ log: null });
  assert.equal(store.source, 'defaults');

  assert.equal(store.seed({}), false, '空对象不算用户配置');
  assert.equal(store.seed(null), false);
  assert.equal(store.source, 'defaults');

  assert.equal(store.seed({ scale: 1.2 }), true);
  assert.equal(store.source, 'settings');
  assert.equal(store.config.scale, 1.2);
  assert.equal(store.config.enabled, true, '未提供的键保持默认');

  // 非法存量值在 seed 阶段就抛；已采纳的旧值不被污染
  assert.throws(() => store.seed({ scale: 9 }), /expected number/);
  assert.equal(store.config.scale, 1.2);
});

test('project 丢掉未知键与显式 undefined', () => {
  assert.deepEqual(project({ scale: 1.2, junk: 1, appPath: undefined, enabled: undefined }), {
    scale: 1.2,
  });
  assert.deepEqual(project(null), {});
  assert.deepEqual(project('nope'), {});
});

test('resolveConfig 用默认值补齐，并拒绝非法值', () => {
  const resolved = resolveConfig({ scale: 1.4 });
  assert.equal(resolved.scale, 1.4);
  assert.equal(resolved.enabled, true);

  assert.throws(() => resolveConfig({ scale: 9 }), /expected number/);
  assert.throws(() => resolveConfig({ scale: 0.1 }), /expected number/);
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /expected boolean/);
});

test('settings 服务缺席：值落内存，并如实报告 persisted=false', async () => {
  const store = createConfigStore({ log: null });
  assert.equal(store.available, false);
  assert.equal(store.source, 'defaults');
  assert.deepEqual(store.config, DEFAULTS);

  const result = await store.set({ scale: 1.2 });
  assert.equal(result.persisted, false, '不能假装写成功');
  assert.equal(result.config.scale, 1.2);
  assert.equal(store.source, 'memory');
  assert.equal(store.config.enabled, true, '未提供的键保持默认');
});

test('settings 缺席时非法值依然被拒，且不污染内存状态', async () => {
  const store = createConfigStore({ log: null });
  await assert.rejects(() => store.set({ scale: 9 }), /expected number/);
  assert.equal(store.config.scale, DEFAULTS.scale);
  assert.equal(store.source, 'defaults');
});

test('订阅者在写入后收到通知', async () => {
  const store = createConfigStore({ log: null });
  const seen = [];
  const off = store.on((config, source) => seen.push([config.scale, source]));

  await store.set({ scale: 1.3 });
  off();
  await store.set({ scale: 1.1 });

  assert.deepEqual(seen, [[1.3, 'memory']]);
});

test('监听器抛出不打断其他监听器', async () => {
  const store = createConfigStore({ log: null });
  const seen = [];
  store.on(() => {
    throw new Error('boom');
  });
  store.on((config) => seen.push(config.scale));

  await store.set({ scale: 1.2 });
  assert.deepEqual(seen, [1.2]);
});

test('接了 settings 之后走 scope.update 并回读（只落一个 patch）', async () => {
  const store = createConfigStore({ log: null });
  const writes = [];
  const watchers = new Set();
  let value = { ...DEFAULTS };

  const scope = {
    get: () => value,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    async update(patch) {
      writes.push(patch);
      value = { ...value, ...patch };
      for (const fn of watchers) fn(value, value);
    },
  };

  const off = store.attach(scope);
  assert.equal(store.available, true);
  assert.equal(store.source, 'settings');

  const result = await store.set({ hideWhenIdle: true, junk: 'x' });
  assert.equal(result.persisted, true);
  assert.deepEqual(writes, [{ hideWhenIdle: true }], '脏键不会进入 patch');
  assert.equal(store.config.hideWhenIdle, true);
  assert.equal(store.source, 'settings');

  // settings 里已有的非法存量值不能把插件搞崩
  value = { ...value, scale: 99 };
  const store2 = createConfigStore({ log: null });
  store2.attach(scope);
  assert.equal(store2.config.scale, DEFAULTS.scale, '退回默认值而不是抛');

  off();
});
