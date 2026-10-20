/**
 * 协议与元数据一致性测试。
 *
 * 存在的理由：协议常量是「宿主半边 ↔ 岛 app」的接口，一旦漂移，故障会表现为
 * app 静默画不出东西，而不是报错。所以把三件事钉死：
 * 1. 三个 version 字段一致；
 * 2. `app/src/protocol.cjs` 是 `lib/protocol.js` 的**当前**生成产物；
 * 3. `lib/protocol.js` 只含顶格 `export const`（生成器的前提）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, SOURCE, TARGET } from '../scripts/gen-app-protocol.mjs';
import * as P from '../lib/protocol.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

test('PLUGIN_VERSION 与 package.json / dsh.plugin.json 一致', () => {
  assert.equal(P.PLUGIN_VERSION, readJson('package.json').version);
  assert.equal(P.PLUGIN_VERSION, readJson('dsh.plugin.json').version);
});

test('插件 id 与 name 一致', () => {
  assert.equal(P.PLUGIN_ID, readJson('dsh.plugin.json').id);
  assert.equal(readJson('package.json').name, `@dsh-external/${P.PLUGIN_ID}`);
  assert.ok(readJson('dsh.plugin.json').main.includes('lib/index.js'));
});

test('状态取值只有 4 个，且每个都有色值', () => {
  assert.deepEqual(Object.keys(P.STATUS).sort(), ['done', 'idle', 'thinking', 'tool']);
  for (const status of Object.values(P.STATUS)) {
    assert.match(P.STATUS_COLOR[status], /^#[0-9A-F]{6}$/i, `${status} 缺少色值`);
    assert.equal(typeof P.STATUS_RANK[status], 'number', `${status} 缺少排序权重`);
  }
});

test('可变路由集合与路由表一致', () => {
  assert.deepEqual(
    [...P.MUTATING_ROUTES].sort(),
    [P.ROUTE.config, P.ROUTE.focus, P.ROUTE.jump, P.ROUTE.ack].sort(),
  );
  assert.equal(P.MUTATING_ROUTES.includes(P.ROUTE.state), false);
  assert.equal(P.MUTATING_ROUTES.includes(P.ROUTE.commands), false);
  assert.equal(P.MUTATING_ROUTES.includes(P.ROUTE.health), false);
});

test('lib/protocol.js 只含顶格 export const（生成器的前提）', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  // 先剥掉注释：文件头注释里提到过 `class` / `import` 这些词。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  for (const line of code.split(/\r?\n/)) {
    if (/^\s*export\b/.test(line)) {
      assert.ok(line.startsWith('export const '), `非法声明（生成器会漏掉）：${line}`);
    }
  }
  assert.equal(/^\s*import\b/m.test(code), false, 'protocol.js 不能有 import');
  assert.equal(/^\s*(?:async\s+)?function\b/m.test(code), false, 'protocol.js 不能有函数声明');
  assert.equal(/^\s*class\b/m.test(code), false, 'protocol.js 不能有 class');
});

test('app/src/protocol.cjs 没有过期', () => {
  assert.ok(fs.existsSync(TARGET), '缺少 app/src/protocol.cjs，请运行：npm run gen-protocol');
  assert.equal(
    fs.readFileSync(TARGET, 'utf8'),
    generate(),
    'app/src/protocol.cjs 与 lib/protocol.js 不一致，请运行：npm run gen-protocol',
  );
});

test('生成的副本在 CJS 下真的可用，且值与 ESM 侧逐项相等', async () => {
  const generated = generate();
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func -- 就是为了在 CJS 语义下求值
  new Function('exports', generated)(module.exports);

  for (const [key, value] of Object.entries(module.exports)) {
    assert.deepEqual(value, P[key], `${key} 在两个半边里不一致`);
  }
  assert.deepEqual(
    Object.keys(module.exports).sort(),
    Object.keys(P).sort(),
    '导出的键集合必须完全一致',
  );
});
