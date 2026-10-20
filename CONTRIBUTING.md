# Contributing

欢迎提交 issue。本仓库**不接受 Pull Request**（新开的 PR 会被自动关闭），请用 issue
描述问题或建议。这个项目的很多约束来自 DSH 自身的实现细节，**动手前请先读
[`DESIGN.md`](./DESIGN.md)**（尤其是 §5 的硬约束和 §7 的宿主半边设计），能省掉不少返工。

## 环境

- Windows 10/11。项目只支持 Windows，macOS 明确不做。
- Node.js 22+（当前开发/验证用的是 Node 24）。
- 真机联调需要安装 DSH 0.2.x。

根目录没有运行期依赖，但跑测试需要 `node_modules/@deepseek-ai/*`。最省事的做法是
指向本机 DSH 的 profile：

```text
node_modules/@deepseek-ai/<pkg>  →  ~/.dsh/profiles/node_modules/@deepseek-ai/<pkg>
```

没有 DSH 的环境可以退回 `npm install`（peerDependencies 会被装上），效果相同。

## 常用命令

```bash
npm test                 # 全部单测（node --test）
npm run check-protocol   # 断言 app/src/protocol.cjs 与 lib/protocol.js 一致
npm run gen-protocol     # 重新生成 app/src/protocol.cjs

cd app
npm install
npm start                # 开发模式启动岛（需要已运行的 DSH 宿主）
npm run dist:dir:nosign  # 构建 app/dist/win-unpacked
```

> 在 DSH 自带的 pwsh 沙箱里 `npm test` 可能因 `spawn EPERM` 失败（Node test runner
> 需要 spawn 子进程）。改用单进程模式：
> `node --test --test-isolation=none "test/**/*.test.mjs"`。

## 代码结构

| 路径 | 说明 |
| :--- | :--- |
| `lib/state.js` | 纯状态机：零 I/O、零 DSH 依赖，事件进、快照出 |
| `lib/index.js` | 宿主半边：订阅 DSH 事件、富化、回环 HTTP、拉起岛 app |
| `lib/server.js` / `lib/protocol.js` | HTTP 栅栏与协议常量（**常量的唯一出处**） |
| `lib/client.js` | 渲染半边（设置页） |
| `app/src/` | Electron 岛 app：主进程、预加载、渲染层 |
| `test/` | `node --test` 单测；`host.test.mjs` 跑真实 `apply()` + 回环 HTTP |

## 改动约定

- **状态机改动**：在 `test/state.test.mjs` 补合成事件用例；不要引入 I/O 或 DSH import。
- **宿主行为改动**：优先在 `test/host.test.mjs` 用真实 `apply()` 与 HTTP 验证，而不是只测辅助函数。
- **协议常量**：只改 `lib/protocol.js`，然后 `npm run gen-protocol`；`check-protocol` 必须通过。
- **渲染层**：保持「骨架只建一次、之后只改文本与属性」的纪律，不要整块 `innerHTML` 重建；
  UI 改动请附一张截图（折叠态 + 展开态）。
- **注释与文档**：解释“为什么”（尤其是 DSH 约束），不要叙述代码本身；行为变了就同步
  `README.md` / `DESIGN.md` / 本文件。
- **提交前**：`npm test` 必须全绿，`npm run check-protocol` 必须通过。

## 提交 issue

- 一个 issue 只描述一件事；说明现象、复现步骤和期望行为。
- UI 问题请附截图或录屏；行为问题请附 DSH 版本、`host.log` 相关片段。
- 不要提交 `node_modules/`、`app/dist/`、`.tmp-test/` 等本地产物，见 [`.gitignore`](./.gitignore)。

## License

贡献即表示同意以 [MIT](./LICENSE) 许可发布。
