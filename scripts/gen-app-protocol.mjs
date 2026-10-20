/**
 * 从 lib/protocol.js 生成 app/src/protocol.cjs。
 *
 * 为什么需要生成而不是共享：Electron 主进程是 CJS（`app/package.json` 没有
 * `"type": "module"`，且 preload 在沙箱下必须是 CJS），而 `lib/protocol.js` 是 ESM。
 * 两份文件必须逐字等价，所以这里用机械变换，而不是手抄 —— 手抄一定会漂移。
 *
 *   node scripts/gen-app-protocol.mjs          写入
 *   node scripts/gen-app-protocol.mjs --check  只校验（CI / npm test 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SOURCE = path.join(ROOT, 'lib', 'protocol.js');
export const TARGET = path.join(ROOT, 'app', 'src', 'protocol.cjs');

const HEADER = [
  '/**',
  ' * ⚠️ 本文件由 `npm run gen-protocol` 从 `lib/protocol.js` **生成**，请不要手改。',
  ' * `test/protocol.test.mjs` 会断言它没有过期。',
  ' *',
  ' * 生成原因：Electron 主进程是 CJS，不能直接 import ESM 的 `lib/protocol.js`。',
  ' * 两者必须逐字等价，因此用机械变换而不是手抄。',
  ' */',
  '',
].join('\n');

/** 把 ESM 的 `export const` 声明机械转成「CJS 赋值 + 同名局部绑定」。 */
export function generate() {
  const source = fs.readFileSync(SOURCE, 'utf8');
  const out = [];
  let declarations = 0;

  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('export const ')) {
      // 生成 `const NAME = exports.NAME = <字面量>;` —— 既挂到 exports，
      // 又留下同名局部绑定。必须留局部绑定：protocol.js 里有
      // `MUTATING_ROUTES = [ROUTE.jump, ...]` 这种**文件内互相引用**，
      // 只写 `exports.ROUTE = ...` 会得到 "ROUTE is not defined"。
      out.push(line.replace(/^export const (\w+)/, 'const $1 = exports.$1'));
      declarations += 1;
      continue;
    }
    if (/^\s*export\b/.test(line)) {
      throw new Error(
        `lib/protocol.js 只允许顶格的 \`export const NAME = <字面量>;\`，但发现了：${line.trim()}`,
      );
    }
    out.push(line);
  }

  if (declarations === 0) throw new Error('lib/protocol.js 里没有找到任何 export const 声明');
  return `${HEADER}${out.join('\n')}`;
}

function main() {
  const check = process.argv.includes('--check');
  const next = generate();
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null;

  if (check) {
    if (current === next) {
      console.log('app/src/protocol.cjs 与 lib/protocol.js 一致');
      return;
    }
    console.error('app/src/protocol.cjs 已过期，请运行：npm run gen-protocol');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, next, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, TARGET)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
