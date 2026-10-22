# 需求：子代理层级与待办聚合

> 状态：**首版已实现**（层级、名称、终态保留、完整待办聚合；子代理自己写的待办按 session 打标；父会话待办使用 `~` 前缀的高置信度语义推断标签）
> 范围：灵动岛 HUD 的会话层级、子代理命名、待办展示与生命周期
> 不涉及：宿主事件协议、DSH 源码、跳转通道本身

---

## 1. 背景

当前灵动岛支持：

- 当前会话的状态、耗时、轮次、工具数、上下文与累计 Token
- 会话列表与点击跳转（`uiWorkspace.openSession`）
- 子代理运行计数（父会话上的 `子代理 N`）
- 单条待办摘要（当前会话的 `todoText` + `done/total`）

在同时启用**子代理**和**待办**时，出现以下问题：

1. 子代理会话以独立会话的形式混在列表里，看不出它属于哪个父会话
2. 子代理行显示的是任务 prompt 标题（如“你是只读分析代理，不要修改”），而不是子代理真正的名称
3. 两个子代理 + 主会话会出现 3 个平级会话行；主会话被当成普通行时会显示待办计数
4. 子代理停止后，对应行立即消失，看不到“已完成/已停止”的终态
5. 待办只显示当前主会话的一条摘要，无法看到所有待办，也无法看出哪些待办与子代理有关

---

## 2. 现状与根因

### 2.1 现有数据其实够用

从 DSH 的 session projection 与事件流可以直接拿到：

| 数据 | 来源 | 说明 |
| :--- | :--- | :--- |
| 父子关系 | `session.header.origin === 'subagent'` + `header.parentSession` | 宿主 `enrich()` 已经在用 |
| 子代理名称（长） | `values.subagent.identity.label` | 例：`核查 DSH 运行时最小化节流与 openSession 语义（只读分析）` |
| 子代理名称（短） | 父会话 `values.agentTeam.members[].name` | 例：`dsh-runtime`、`jump-chain` |
| 子代理描述 | `values.agentTeam.members[].description` | 与长名称一致或接近 |
| 团队阶段 | `values.agentTeam.members[].phase` | 仅 `provisioning / active / failed`，**没有 completed** |
| 子代理完成态 | `values.subagentTiming.lastTurnCompleted` + `agent/status` + `turn/end reason` | 判断正常完成 / 被停止 |
| 完整待办 | `todo/write` 事件的 `data.todos`；或 `values.todos` | 数组，元素只有 `content` / `status` |
| 待办归属 | **没有字段** | 只能按“哪个 session 写了这条待办”归属，不能按单条 todo 归属 |

实测样本（本机，两个 continuable 子代理）：

```text
父会话 agentTeam.members:
  jump-chain    → 追踪仓库内跳转链路与最小化失败点（只读分析）  phase=active
  dsh-runtime   → 核查 DSH 运行时最小化节流与 openSession 语义（只读分析） phase=active

子会话 1 subagent.identity.label: 追踪仓库内跳转链路与最小化失败点（只读分析）
子会话 2 subagent.identity.label: 核查 DSH 运行时最小化节流与 openSession 语义（只读分析）

父会话 todos:
  梳理跳转链路...                       status=in_progress
  核查 DSH 运行时语义...                status=in_progress
  汇总证据链...                         status=pending
  给出修复方案...                       status=pending

两个子会话 todos: null
```

### 2.2 代理与待办的结构关系

DSH 里这是**三套彼此独立的结构**，只有第一套和第三套有“所属关系”，第二套只是团队名单：

```text
① Session / Agent 树
   agent.id 就是 session id

   session-root（主会话）
   ├─ todos: [ T1, T2, T3, T4 ]          ← 主代理调用 todo_write 写入
   └─ agentTeam.members
        ├─ child-A  name=dsh-runtime   description=核查 DSH…
        └─ child-B  name=jump-chain    description=追踪…

   child-A（header.origin=subagent，header.parentSession=session-root）
   └─ todos: null 或 [ TA1, TA2 ]        ← 只有 child-A 自己写 todo 才有

   child-B
   └─ todos: null 或 [ TB1 ]

② agentTeam.members
   只是子会话的名单元数据：id / name / description / phase
   没有指向 todo 的字段

③ 每个 session 自己的 todos
   TodoItem = { content, status }
   status ∈ pending | in_progress | completed
   没有 id、ownerId、agentId、parentTodoId
```

由此得到一条关键规则：

```text
待办的唯一归属键 = 写它的 session
不是 = 待办文本里提到的子代理
```

所以：

- `child-A` 自己写的 todo 可以可靠地打上 `[dsh-runtime]`
- 主会话写的“核查 DSH 运行时语义”仍然只属于主会话；即使文本里出现子代理描述，也没有结构化字段能证明它属于 `child-A`
- `agentTeam.members` 能告诉你“有哪些子代理、叫什么”，但不能告诉你“哪条 todo 属于它”

### 2.3 DSH 自己怎么知道完成，以及能关联到什么

子代理结束时，DSH 会往**父会话**追加一条 `user/message`，`data.source` 是结构化通知：

```json
{
  "kind": "subagent-settled",
  "form": "notice",
  "summary": "Background subagent <childId> finished...",
  "senderSessionId": "<childId>"
}
```

实测本次会话：

- `#423`：`Background subagent 33663da8... was stopped before it finished.`
- `#437`：`Background subagent e9138fda... was stopped before it finished.`
- 正常完成时，`settlementSummary()` 生成的是 `finished and will do no further work unless you send it more.`

所以 DSH **确实知道**：哪个子会话结束了、是正常完成还是被停止。但这条通知里**只有 `childId`，没有 todo id，也没有 todo 文本**。

现有可用的关联信号：

| 信号 | 关联 | 是否结构化 | 是否能定位到某条 todo |
| :--- | :--- | :--- | :--- |
| `spawn_teammate` tool call | 父 → 子（`name` / `description` / `prompt`） | 是 | **否**，参数里没有 todo 字段 |
| `team/member` | 父 → 子（`id` / `name` / `description` / `phase`） | 是 | **否** |
| `subagent/catalog` | 父 → 子（`childId` / `label` / `mode`） | 是 | **否** |
| `subagent-settled` | 子 → 父（`senderSessionId`） | 是 | **否** |
| `todo/write` | 会话 → todo 列表 | 是 | todo 本身没有 `ownerId` |
| `team/task`（团队任务板） | 任务 → `ownerId` / `ownerName` | 是 | 是，但它是**共享任务**，不是 `todo_write` 的列表 |
| todo 文本 ↔ 子代理名称/描述 | 语义相似 | **否** | 只能启发式猜测 |

关键结论：

```text
DSH 知道“子代理完成了”
DSH 不知道“这条 todo 属于哪个子代理”
```

**那 T1/T2 是怎么变成完成的？** 不是 DSH 自动改的，而是父代理收到 `subagent-settled` 通知后，由模型自己再次调用 `todo_write`，把对应项从 `in_progress` 改成 `completed`。本次会话里父 turn 在子代理结算后被 abort（`#450 turn/end reason=aborted`），模型没有机会更新 todo，所以 T1/T2 一直停在 `in_progress`，岛的待办计数也就仍是 `0/4`（实际两条 in_progress）。

这也是为什么当前的 `todo` 数据不能自动带子代理标签：**模型脑子里的对应关系没有落到任何结构化字段上**。

### 2.4 当前实现的问题点

| 位置 | 现状 | 后果 |
| :--- | :--- | :--- |
| `lib/index.js` `enrich()` | 只计算 `subagentRunning`，没有把 `parentSession`、`subagent.identity`、`agentTeam` 写入条目 | 渲染层无法分组、无法用真实名称 |
| `lib/state.js` `onDisposed()` | 收到 `agent/disposed` 直接删除条目 | 子代理停止后行立刻消失 |
| `lib/state.js` `todo/write` | 只存 `todoTotal/todoDone/todoText` | 丢失完整待办列表与每项状态 |
| `lib/state.js` `turn/start` | 不清空待办字段 | 待办跨轮残留（与 `todos` 投影在 turn/start 置 null 的语义不一致） |
| `app/src/renderer.js` `renderList()` | 所有条目平铺；`row-sub` 显示 `待办 x/y` | 子代理成为独立行；主会话被当行时出现待办计数 |
| `app/src/renderer.js` 待办区 | 只显示当前 primary 的一条 `todoText` + 计数 | 看不到全部待办，也看不到子代理归属 |
| 标题回落 | 子会话先取 `sessionTitle` / 首条消息 | 显示 prompt 标题而不是 `subagent.identity.label` |

### 2.5 语义关联：还可以利用的细节线索

没有任何字段直接写“T1 = jump-chain”，但一次 spawn 发生时，事件流里同时存在这些线索：

1. **同一个 assistant step**
   - `#286 assistant/message` 同时包含 `todo_write` 和两个 `spawn_teammate` tool-call
   - `#287 todo_write`、`#290/#295 spawn_teammate` 都属于 turn 12 / step 1
   - 同一 step 内、数量相等（2 个 `in_progress` ↔ 2 个 spawn）时，候选集很小

2. **顺序先验**
   - todo 顺序是 T1、T2；spawn 顺序是 `jump-chain`、`dsh-runtime`
   - 按顺序一对一匹配，本例正好正确；模型换序时会错，所以只能作为加分项，不能单独作为结论

3. **description / name 的语义重合**
   - T1：`梳理跳转链路…定位最小化时的失败点`
     ↔ `jump-chain` description：`追踪仓库内跳转链路与最小化失败点（只读分析）`
   - T2：`核查 DSH 运行时语义…最小化…节流与 openSession`
     ↔ `dsh-runtime` description：`核查 DSH 运行时最小化节流与 openSession 语义（只读分析）`
   - 短名 `jump-chain` / `dsh-runtime` 是英文 slug，对中文 todo 作用有限；description 更有用

4. **spawn prompt**
   - `spawn_teammate.prompt` 是完整任务，通常比 description 更长、更接近 todo 文本；把 prompt 也作为匹配文档
   - 子会话的 `titleInput.first.text` / `turnOutline.prompt` 就是这份 prompt，可作为补充文本

5. **`team/member` / `subagent/catalog`**
   - 把 spawn tool call 的 name/description 映射到 `childId`
   - 这是父 → 子的硬链接，不是父 todo → 子

6. **团队任务板（如果用了）**
   - `team/task` 的 `ownerId` / `ownerName` 是唯一真正的结构化任务归属
   - 但它是共享任务，不是 `todo_write` 的 todo

7. **`subagent-settled`**
   - 完成通知只给 `childId`；如果 spawn 时已经缓存了候选映射，就能把 child 的完成态回填到候选 todo 标签

一个可实现的匹配流程（建议在 **spawn 发生的 step** 做，而不是结算时再从头猜）：

```text
candidates = 当前 in_progress 的 todos
spawns     = 同一 step 内的 spawn_teammate 调用

if |candidates| == |spawns|:
    score(todo, spawn) =
        3.0 * 显式名称/ID命中
      + 2.0 * 关键词/语义重合(todo.content, spawn.description + spawn.prompt)
      + 1.0 * 同一 step
      + 0.5 * 顺序对齐
      - 2.0 * 歧义惩罚（best 与 second best 差距过小）

    用最大权匹配（贪心或匈牙利）一对一分配
    只保留 score >= 阈值的边，其余保持未关联
```

首版实现（当前代码）先采用最保守的一步：**只比较 todo 文本与子代理 label/名称的 token 相似度**，阈值 `≥ 0.2`，且最佳分比次佳分高 `≥ 0.08` 才显示 `~` 标签。同 step、数量匹配、顺序对齐作为后续增强（它们能提高置信度，但不是首版必需）。

置信度展示：

| 置信度 | 条件 | UI |
| :--- | :--- | :--- |
| 高（后续增强） | 显式提到子代理名称，或 description 原样出现在 todo 中 | `[jump-chain]` |
| 中（首版） | 文本 token 相似度达标，且明显高于其它候选 | `[~jump-chain]` |
| 低/歧义 | 只有模糊文本相似，或两个子代理都像 | 不打标签 |

注意：**纯字符 n-gram 相似度不够可靠**。用本次数据粗测，T1↔`jump-chain` 的字符 bigram Jaccard 只有 0.10，T1↔`dsh-runtime` 反而有 0.16；T2↔`dsh-runtime` 才是 0.49。需要先做关键词提取/中文分词，或使用 embedding，再用“最佳与次佳差距”过滤歧义。

最终原则：**启发式只用于展示 `~` 标签，不修改 todo 状态；父代理自己的 `todo_write` 永远是最高优先级。**

---

## 3. 可行性结论

| 需求 | 结论 | 说明 |
| :--- | :--- | :--- |
| 显示子代理归属与层级 | **可做** | `header.parentSession` + 父会话 `agentTeam.members` 足够 |
| 使用子代理真实名称 | **可做** | `subagent.identity.label` 是核心子代理数据，不依赖智能体团队；短名 `agentTeam.members[].name` 在团队模式下更友好 |
| 子代理不再作为顶级会话行 | **可做** | 纯渲染层与 DTO 结构调整 |
| 去除会话行的待办计数 | **可做** | 直接删掉 `row-sub` 的待办项即可 |
| 子代理停止后保留终态行 | **可做** | 需要改 `onDisposed`：子代理条目不立即删除，改为标记终态并保留 |
| 展示所有待办 | **可做** | `todo/write` 已经携带完整数组；无需新接口 |
| 待办关联到具体子代理 | **部分可做** | 没有 per-todo owner 字段。只能按“写这条待办的 session”关联；父会话待办中提到子代理的条目**无法结构化关联** |
| 子代理完成后待办显示 √ | **可做，但语义要定义** | `subagent-settled` 通知能确认子代理完成；可以给“子代理标签”加完成标记，但不能可靠地把父会话里的某条 todo 自动判给某个子代理 |

**关键限制**：如果父代理在 todo 里写“核查 DSH 运行时语义”，而子代理自己没有任何 `todo/write`，系统无法知道这条 todo 对应哪个子代理。可选路径只有：

- **A（可靠）**：子代理自己写待办，按 session 归属打标签；
- **B（启发式，已启用）**：用 todo 文本匹配子代理名称/描述，只作为视觉提示，统一加 `~` 前缀；低于阈值或最佳/次佳差距过小则不标；
- **C（结构化）**：使用 Agent Teams 的共享任务板（`team_task_*` / `team/task`），任务自带 `ownerId`/`ownerName`；但这是另一套列表，不是 `todo_write` 的 todo。

---

## 4. 目标与非目标

### 目标

1. 子代理按父子关系嵌套展示，永远能看出它属于哪个会话
2. 用子代理真实名称/短名替代 prompt 标题
3. 会话行只表达“状态 + 名称 + 耗时”，不再携带待办计数
4. 独立待办区展示当前轮次的全部待办；子代理写的待办带子代理标签
5. 子代理完成/停止后保留终态行，直到父会话确认或过期
6. 保持点击子代理行可跳转

### 非目标

- 不修改 DSH 的 session/todo 事件协议
- 不要求子代理必须使用 `todo_write`
- 不引入需要模型配合的新工具或提示词
- 不在本需求中实现团队任务板（`agentTeam.tasks`）的完整 UI

---

## 5. 交互设计

### 5.1 会话层级

```text
▼ dsh-notch-win / 显示项目目录结构          调用工具  3m08s
    ├─ dsh-runtime · 核查 DSH 运行时语义…    调用工具  2m44s
    └─ jump-chain · 追踪仓库内跳转链路…      调用工具  2m43s
  deepseek-harness / Install DSH Market plugin   空闲
  TheMonkeyKing / 西游记妖怪图录网页              空闲
```

规则：

- 顶级行 = 没有 `parentSession` 的根会话
- 当前根会话同时有待办和子代理时，HUD 分成 `待办` 与 `子代理 N` 两组；其他根会话留在下方列表
- 子代理行缩进在 `子代理` 组内，用 `├─` / `└─` 连接
- 子代理行显示短名（`agentTeam.members[].name`）优先；没有短名时用 `subagent.identity.label`；再退到标题/消息/shortId
- 长描述放 tooltip，避免行内过长
- 父行右侧保留 `子代理 N` 计数；子代理行不显示该计数
- 子代理不再出现在顶级列表；但点击缩进行仍执行跳转
- 表头承担当前树的根；点击子代理只更新选中态，子代理在自己组里用左侧细条/底色 + `当前` 标记，不改变表头文案
- 子代理的 id 可能以裸 uuid 或 `session-` 前缀出现，必须归一为同一条目，不能因点击复制出新的顶级行

### 5.2 表头

表头始终显示**当前会话树的根会话**。点击任意子代理只执行跳转，不改变主会话文案、状态或耗时；被选中的子代理只在 `子代理` 组里显示 `当前`。

```text
● 空闲  dsh-notch-win / 显示项目目录结构
```

这样不会出现“点一下子代理，顶部主会话标题就变了”的错误交互。

### 5.3 待办区

在表头与列表之间放独立待办区，展示**当前轮次**的聚合待办。

本次实测场景（主会话 4 条，两个子代理都没有自己的 todo）：

```text
待办  1/4
  ◐ 梳理跳转链路（岛 IPC → 宿主 /v1/jump → …）          [主会话]
  ◐ 核查 DSH 运行时语义…                                [主会话]
  ○ 汇总证据链…                                         [主会话]
  ○ 给出修复方案…                                       [主会话]
```

注意：这里第二条**不能**因为文本像子代理任务就打 `[dsh-runtime]`——它仍然是主会话写的 todo。

如果子代理自己写了 todo（场景 B）：

```text
待办  1/3
  ◐ 核查 DSH 运行时语义…                                [主会话]
  ◐ 阅读 app.asar 入口…                                 [dsh-runtime]
  ○ 汇总证据…                                           [dsh-runtime ✓]
```

最后一条表示：todo 本身仍可能是 pending，但它的**归属子代理**已经正常完成，所以在标签上打 ✓，不篡改 todo 的 status。

规则：

- 默认显示父会话 + 所有子代理的 `todos` 聚合
- 每条 todo 前面是状态图标：`○ pending` / `◐ in_progress` / `● completed`
- 标签规则：
  - 子代理自己写的 todo → 显示 `[子代理短名]`
  - 父会话写的 todo → 不显示可靠标签；若与某个子代理描述高置信度匹配，显示 `[~子代理名]`（`~` 表示推断）
  - 推断阈值：相似度 ≥ 0.2 且最佳分比次佳分高 ≥ 0.08，否则不打标签
- 子代理正常完成（`subagentTiming.lastTurnCompleted === true` 或 `turn/end reason=completed`）后：
  - 在它的标签后显示 `✓`，例如 `[dsh-runtime ✓]`
  - 不自动把该子代理的未完成 todo 改成 completed；如果希望“子项显示完成”，只对“子代理标签”加完成标记
- 子代理被停止（`aborted`）→ 标签显示 `[dsh-runtime 已停止]`，不显示 ✓
- 最多显示 N 条（建议 8）；超出显示 `还有 N 条`，点击/悬停展开
- `turn/start` 时清空上一轮待办，与 DSH `todos` 投影语义一致

### 5.4 终态子代理行

- 完成/停止的权威信号：
  - 父会话收到 `user/message` 且 `data.source.kind === 'subagent-settled'`，`senderSessionId` 即子会话 id
  - 辅以 `values.subagentTiming.lastTurnCompleted`、`agent/status`、`turn/end reason`
- `agent/status` 变为 idle 或收到 `agent/disposed` 时，不立即删除子代理条目
- 保留为终态行：
  - 正常完成：`已完成`（绿色/紫色按现有状态色）
  - 被停止：`已停止`（琥珀色，复用现有 stopped）
- `subagent-settled` 通知可能比 `agent/disposed` 更晚/更早到达，两者取“终态已确认”即可，重复通知幂等处理
- 保留时机：
  - 父会话下一轮开始，或用户 ack 父会话时移除
  - 或超过 `SUBAGENT_RETENTION_MS`（建议 5 分钟）后回收
- 父会话 ack 时：
  - 清空父会话的 `todos`（HUD 待办区隐藏）
  - 移除该父会话下**所有**子代理行（不只是终态行）
  - 设置 `acked` 抑制：在下一轮 `turn/start` 或新的 `todo/write` 之前，`enrich()` 不再从投影回填待办/子代理
- 终态行仍可点击跳转；若跳转失败，页脚显示原因，不静默失败

---

## 6. 功能需求

| ID | 需求 | 优先级 |
| :--- | :--- | :--- |
| FR-1 | 宿主把 `parentSession`、`origin`、`subagent.identity.label`、`agentTeam.members`、`subagentCatalog` 富化到条目/DTO | P0 |
| FR-2 | 渲染层按父子关系嵌套子代理行，不再把子代理作为顶级会话 | P0 |
| FR-3 | 子代理名称优先使用短名/identity label，不用 prompt 标题 | P0 |
| FR-4 | 会话行移除 `待办 x/y`，只保留状态、名称、耗时、必要的子代理计数 | P0 |
| FR-5 | 待办区展示当前轮次全部待办（父 + 子） | P0 |
| FR-6 | 子代理自己写的待办显示子代理标签 | P1 |
| FR-7 | 子代理完成/停止后在标签上显示终态标记 | P1 |
| FR-8 | 子代理停止后保留终态行，按父轮次/ack/超时回收 | P0 |
| FR-9 | 点击子代理行可跳转；失败有可见回执 | P1 |
| FR-10 | 待办超出高度时截断并显示剩余数量 | P1 |
| FR-11 | 表头在焦点为子代理时显示父子归属 | P1 |
| FR-12 | 消费父会话的 `subagent-settled` 通知，确认子代理完成/停止终态 | P0 |
| FR-13 | 对 todo 文本与子代理描述做语义匹配，只作为 `~` 提示且不修改状态 | P1（已实现） |
| FR-14 | 父会话 ack 时清空待办、移除全部子代理行，并抑制投影回填直到下一轮/新 todo | P0（已实现） |
| FR-15 | 会话 id 的裸 uuid / `session-` 前缀统一归一，点击子代理不能复制出顶级条目 | P0（已实现） |
| FR-16 | 仍挂着子代理行的父会话不能被空闲回收；焦点子代理保留在树里并显示“当前” | P0（已实现） |
| FR-17 | 根列表优先展示 primary 所属根；兄弟子代理按 createdAt 固定排序，点击不改变顺序 | P0（已实现） |
| FR-18 | 表头始终是根会话，点击子代理只跳转；待办与子代理分成 `待办` / `子代理 N` 两组 | P0（已实现） |
| FR-19 | 父会话被 dispose 且仍有子代理行时保留 idle 占位；子代理 parentId 缺失父条目时自动补占位 | P0（已实现） |
| FR-20 | 表头以下整块（待办 + 子代理 + 会话列表）共用一个滚动条，从表头下沿开始 | P0（已实现） |

---

## 7. 数据模型建议

条目新增字段（宿主内存 + DTO）：

```js
{
  parentId: string | null,        // 父会话 id
  isSubagent: boolean,
  subagentName: string | null,    // 短名（agentTeam.members[].name）
  subagentLabel: string | null,   // 长名（subagent.identity.label）
  agentPhase: 'provisioning' | 'active' | 'failed' | null,
  subagentFinished: boolean,      // 正常完成
  subagentStopped: boolean,       // 被停止
  todos: [{ content, status }],   // 当前轮次完整待办
  todoOwner: 'self' | 'subagent',
  retainedUntil: number | null,   // 终态行回收时间
}
```

规则：

- `turn/start`：清空 `todos`，重置 `subagentFinished/subagentStopped`
- `todo/write`：整表替换 `todos`（与 DSH 语义一致）
- `agent/disposed`：
  - 非子代理：维持现有删除行为
  - 子代理：不删除，标记终态；等父轮次/ack/超时回收
- `enrich()`：
  - 从 `session.header` 写 `parentId/isSubagent`
  - 从父会话 `values.agentTeam.members` 反查子代理短名/描述
  - 从子会话 `values.subagent.identity` 读长名
  - 从 `values.subagentTiming.lastTurnCompleted` 读完成态
  - 保留 `sessionProjections.snapshot()` 现有调用，不新增服务

---

## 8. 边界与风险

1. **父会话待办无法可靠归属子代理**：这是数据模型限制，不是实现问题。需产品确认是否接受“只按 session 归属”。
2. **父 todo 的 completed 状态依赖模型更新**：`subagent-settled` 只告诉父会话子代理结束了；T1/T2 是否变成 completed，取决于模型收到通知后是否再次调用 `todo_write`。岛不能替模型推断。
3. **子代理可能没有自己写 todo**：此时它只能以“子代理行 + 标签”形式出现，待办区不会出现它的条目。
4. **one-shot 子代理可能没有 label**：需要回退到 `agentTeam` 描述、`sessionTitle`、首条消息、shortId。
5. **嵌套子代理**：`parentSession` 可能指向另一个子代理；层级需要递归，最多建议 2–3 层，超出折叠。
6. **子代理被归档/销毁后跳转**：continuable 子代理会话通常可跳；one-shot 需实测，失败时给出页脚提示。
7. **高度**：HUD 展开最大约 452px；表头以下整块内容共用一个滚动容器（待办 + 子代理 + 会话列表），不再让各组各留 `max-height + overflow`。
8. **轮次语义**：`todos` 在每轮 `turn/start` 清空；不要跨轮聚合，否则会出现陈旧待办。
9. **性能**：所有数据都来自现有 `snapshot` 与事件，不增加轮询；层级计算在 `enrich()` 内 O(sessions)，可接受。

---

## 9. 验收场景

### 场景 A：两个子代理 + 四条待办（即本次实测场景）

1. 主会话有 4 条待办，启动 2 个 continuable 子代理
2. 灵动岛只显示 1 个顶级父行，下面嵌套 2 个子代理行
3. 子代理行显示 `dsh-runtime` / `jump-chain`（或 identity label），不是 prompt 标题
4. 父行右侧显示 `子代理 2`，任何行都不显示 `待办 x/y`
5. 待办区显示 4 条；父会话待办无子代理标签
6. 分别点击两个子代理行，DSH 都能切过去；表头显示父子归属
7. 停止第一个子代理：该行保留并显示 `已停止`，不立即消失
8. 子代理正常完成：其标签显示 `✓`；行保留到父会话 ack/下一轮

### 场景 B：子代理自己写待办

1. 子代理调用 `todo_write`
2. 待办区出现该子代理的条目，带 `[子代理短名]`
3. 子代理完成 → 标签显示 `✓`
4. 父会话待办不受影响

### 场景 C：无子代理

1. 不显示任何层级缩进
2. 待办区只显示父会话待办
3. 其余行为与现在一致

---

## 10. 开放问题

1. 表头在焦点为子代理时，采用“父标题 / 子代理短名”还是“子代理标题 + 属于父会话”？
2. 是否接受“只按 session 归属待办”，不做文本启发式？
3. 终态子代理行保留多久：父会话 ack / 下一轮 / 固定 5 分钟，选哪个？
4. 待办区最多显示几条，超出是滚动还是 `还有 N 条`？
5. 父会话 todo 文本中出现子代理名称时，是否需要可选的启发式标签？
