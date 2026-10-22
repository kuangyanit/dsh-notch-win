/**
 * 状态机单测。零 I/O、零 DSH 依赖 —— 直接喂合成事件。
 *
 * 这是 P1 的验收口径：如果这里全绿，宿主侧的状态计算就是对的，不必等 app 做完。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../lib/protocol.js';
import {
  buildStable,
  createState,
  ingest,
  revOf,
  shortId,
  summarizeCall,
  tick,
} from '../lib/state.js';

const T0 = 1_700_000_000_000;

const event = (type, data, seq) => ({ type, seq, time: T0, data });
const status = (agentId, value) => ({ kind: 'status', agentId, status: value });
const sessionEvent = (sessionId, type, data, seq) => ({
  kind: 'event',
  sessionId,
  event: event(type, data, seq),
});

function env(overrides = {}) {
  return {
    pid: 4242,
    port: 47411,
    startedAt: T0,
    appExe: null,
    appExists: false,
    logFile: null,
    settingsError: null,
    config: { enabled: true, scale: 1 },
    configSource: 'defaults',
    ...overrides,
  };
}

const snapshot = (state, at = T0) => buildStable(state, env());

test('running 把条目推进 thinking 并开始计时', () => {
  const state = createState();
  assert.equal(ingest(state, status('s1', 'running'), T0), true);

  const [entry] = snapshot(state).entries;
  assert.equal(entry.status, 'thinking');
  assert.equal(entry.live, true);
  assert.equal(entry.elapsedFrom, T0);
  assert.equal(entry.glow, P.STATUS_COLOR.thinking);
});

test('tool/call 切到 tool，tool/result 配对后回到 thinking', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, sessionEvent('s1', 'step/start', { turn: 1, step: 1 }, 1), T0 + 10);
  ingest(
    state,
    sessionEvent(
      's1',
      'tool/call',
      { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor', arguments: '{"file_path":"lib/state.js"}' },
      2,
    ),
    T0 + 20,
  );

  let entry = snapshot(state).entries[0];
  assert.equal(entry.status, 'tool');
  assert.equal(entry.toolName, 'str_replace_editor');
  assert.equal(entry.toolCount, 1);
  assert.equal(entry.turn, 1);
  assert.equal(entry.step, 1);
  assert.equal(entry.detailText, 'str_replace_editor · lib/state.js');

  // 配对信息在 message.content[0].toolCallId —— tool/result 负载里没有 callId。
  ingest(
    state,
    sessionEvent(
      's1',
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
      },
      3,
    ),
    T0 + 30,
  );

  entry = snapshot(state).entries[0];
  assert.equal(entry.status, 'thinking');
  assert.equal(entry.toolName, null);
  assert.equal(entry.toolCount, 1);
});

test('两个并行 tool/call：先回一个仍在 tool', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  const call = (callId, seq) =>
    ingest(state, sessionEvent('s1', 'tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' }, seq), T0 + seq);
  const result = (callId, seq) =>
    ingest(
      state,
      sessionEvent(
        's1',
        'tool/result',
        { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: callId }] } },
        seq,
      ),
      T0 + seq,
    );

  call('a', 1);
  call('b', 2);
  result('a', 3);
  assert.equal(snapshot(state).entries[0].status, 'tool');
  result('b', 4);
  assert.equal(snapshot(state).entries[0].status, 'thinking');
});

test('done 不会定时回 idle，必须 ack 才清状态', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, status('s1', 'idle'), T0 + 1000);

  let entry = snapshot(state).entries[0];
  assert.equal(entry.status, 'done');
  assert.equal(entry.live, true, 'done 在确认前仍算 live');
  assert.equal(entry.elapsedFrom, T0, '确认前保留最终耗时');

  // 旧的 6s 窗口过了也不自动回 idle
  assert.equal(tick(state, T0 + 1000 + P.DONE_HOLD_MS), false);
  assert.equal(snapshot(state).entries[0].status, 'done');

  // 用户点击确认后才回 idle
  assert.equal(ingest(state, { kind: 'ack', sessionId: 's1' }, T0 + 2000), true);
  entry = snapshot(state).entries[0];
  assert.equal(entry.status, 'idle');
  assert.equal(entry.live, false);
  assert.equal(entry.elapsedFrom, null, 'ack 后清掉计时');
});

test('turn/end reason=aborted 标记为已停止，ack 后清掉', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    sessionEvent('s1', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 1),
    T0 + 10,
  );
  ingest(state, status('s1', 'idle'), T0 + 20);

  let [entry] = snapshot(state).entries;
  assert.equal(entry.status, 'done');
  assert.equal(entry.stopped, true);
  assert.equal(entry.glow, '#E0A800');

  ingest(state, { kind: 'ack', sessionId: 's1' }, T0 + 30);
  [entry] = snapshot(state).entries;
  assert.equal(entry.status, 'idle');
  assert.equal(entry.stopped, false);
});

test('turn/end 不改变状态（agent 可能接着下一轮）', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, sessionEvent('s1', 'turn/end', { turn: 1, reason: 'success' }, 1), T0 + 10);
  assert.equal(snapshot(state).entries[0].status, 'thinking');
});

test('seq 回退被忽略（会话恢复会重放历史）', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, sessionEvent('s1', 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, 5), T0 + 10);
  const before = snapshot(state).entries[0].toolCount;

  assert.equal(
    ingest(state, sessionEvent('s1', 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }, 4), T0 + 20),
    false,
  );
  const after = snapshot(state).entries[0];
  assert.equal(after.toolCount, before);
  assert.equal(after.toolName, 'bash');
});

test('todo/write 给出总量、完成数与当前待办', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    sessionEvent(
      's1',
      'todo/write',
      {
        todos: [
          { content: '写状态机', status: 'completed' },
          { content: '写单测', status: 'in_progress' },
          { content: '接 app', status: 'pending' },
        ],
      },
      1,
    ),
    T0 + 10,
  );

  const [entry] = snapshot(state).entries;
  assert.equal(entry.todoTotal, 3);
  assert.equal(entry.todoDone, 1);
  assert.equal(entry.todoText, '写单测', '优先 in_progress');
});

test('assistant/message 的 usage 与 contextLimit 一起给出占用比例', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, { kind: 'meta', sessionId: 's1', contextLimit: 200_000 }, T0 + 5);
  ingest(
    state,
    sessionEvent('s1', 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 50_000, outputTokens: 10 } }, 1),
    T0 + 10,
  );
  assert.equal(snapshot(state).entries[0].contextFraction, 0.25);
});

test('request/context 给分母，usage 的 cache 读写也算进上下文压力', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, sessionEvent('s1', 'request/context', { contextWindow: 128_000 }, 1), T0 + 5);
  ingest(
    state,
    sessionEvent(
      's1',
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {},
        usage: { inputTokens: 10_000, cacheReadTokens: 2_000, cacheWriteTokens: 500, outputTokens: 10 },
      },
      2,
    ),
    T0 + 10,
  );
  const [entry] = snapshot(state).entries;
  assert.equal(entry.contextTokens, 12_500);
  assert.equal(entry.contextLimit, 128_000);
  assert.equal(entry.contextFraction, 0.098);
});

test('没有 contextLimit 时占用比例是 null，而不是猜一个数', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    sessionEvent('s1', 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 50_000, outputTokens: 10 } }, 1),
    T0 + 10,
  );
  assert.equal(snapshot(state).entries[0].contextFraction, null);
});

test('meta 回填累计 token，原样透传到 DTO', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    {
      kind: 'meta',
      sessionId: 's1',
      tokenTotal: 214_183,
      tokenInput: 151_864,
      tokenOutput: 62_319,
      tokenCacheRead: 5_765_248,
      tokenCacheWrite: 0,
    },
    T0 + 10,
  );
  const [entry] = snapshot(state).entries;
  assert.equal(entry.tokenTotal, 214_183);
  assert.equal(entry.tokenInput, 151_864);
  assert.equal(entry.tokenOutput, 62_319);
  assert.equal(entry.tokenCacheRead, 5_765_248);
  assert.equal(entry.tokenCacheWrite, 0);
});

test('累计 token 的坏值不覆盖已有值', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, { kind: 'meta', sessionId: 's1', tokenTotal: 100, tokenOutput: 10 }, T0 + 10);
  ingest(
    state,
    { kind: 'meta', sessionId: 's1', tokenTotal: -1, tokenInput: Number.NaN, tokenOutput: '42' },
    T0 + 20,
  );
  const [entry] = snapshot(state).entries;
  assert.equal(entry.tokenTotal, 100);
  assert.equal(entry.tokenInput, null);
  assert.equal(entry.tokenOutput, 10);
});

test('meta 回填工作区名与完整路径，超长名截断', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    {
      kind: 'meta',
      sessionId: 's1',
      workspace: 'dsh-notch-win',
      workspacePath: 'D:\\software\\opendocde\\p4\\dsh-notch-win',
    },
    T0 + 10,
  );
  let [entry] = snapshot(state).entries;
  assert.equal(entry.workspace, 'dsh-notch-win');
  assert.equal(entry.workspacePath, 'D:\\software\\opendocde\\p4\\dsh-notch-win');

  ingest(state, { kind: 'meta', sessionId: 's1', workspace: 'x'.repeat(40) }, T0 + 20);
  [entry] = snapshot(state).entries;
  assert.equal(entry.workspace, 'x'.repeat(31) + '…');
  assert.equal(entry.workspacePath, 'D:\\software\\opendocde\\p4\\dsh-notch-win', '空路径不覆盖旧值');
});

test('meta 回填子代理层级、名称与完整待办', () => {
  const state = createState();
  ingest(
    state,
    {
      kind: 'meta',
      sessionId: 'session-child',
      parentId: 'session-parent',
      isSubagent: true,
      subagentName: 'jump-chain',
      subagentLabel: '追踪仓库内跳转链路与最小化失败点（只读分析）',
      subagentState: 'running',
      todos: [
        { content: '阅读 app.asar 入口', status: 'in_progress' },
        { content: '汇总证据', status: 'pending' },
      ],
    },
    T0,
  );
  const entry = snapshot(state).entries.find((item) => item.id === 'session-child');
  assert.equal(entry.parentId, 'session-parent');
  assert.equal(entry.isSubagent, true);
  assert.equal(entry.subagentName, 'jump-chain');
  assert.equal(entry.subagentLabel, '追踪仓库内跳转链路与最小化失败点（只读分析）');
  assert.equal(entry.subagentState, 'running');
  assert.equal(entry.todos.length, 2);
  assert.equal(entry.todoTotal, 2);
  assert.equal(entry.todoText, '阅读 app.asar 入口');
});

test('turn/start 清空上一轮待办', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(
    state,
    sessionEvent(
      's1',
      'todo/write',
      { todos: [{ content: 'T1', status: 'in_progress' }, { content: 'T2', status: 'completed' }] },
      1,
    ),
    T0 + 10,
  );
  assert.equal(snapshot(state).entries[0].todos.length, 2);

  ingest(state, sessionEvent('s1', 'turn/start', { turn: 2 }, 2), T0 + 20);
  const [entry] = snapshot(state).entries;
  assert.equal(entry.todos.length, 0);
  assert.equal(entry.todoTotal, 0);
  assert.equal(entry.todoText, null);
});

test('焦点使用裸 uuid 时复用已有 session- 条目', () => {
  const state = createState();
  ingest(
    state,
    { kind: 'meta', sessionId: 'session-child', parentId: 'session-parent', isSubagent: true, subagentName: 'jump-chain' },
    T0,
  );
  ingest(state, { kind: 'focus', sessionId: 'child' }, T0 + 10);
  const snapshotState = snapshot(state);
  assert.equal(snapshotState.primaryId, 'session-child');
  assert.equal(snapshotState.entries.length, 1, '不能为同一个 uuid 复制出顶级条目');
});

test('subagent-settled 标记终态，disposed 后保留，父 ack 清理', () => {
  const state = createState();
  ingest(state, status('session-parent', 'running'), T0);
  ingest(
    state,
    {
      kind: 'meta',
      sessionId: 'session-child',
      parentId: 'session-parent',
      isSubagent: true,
      subagentName: 'jump-chain',
    },
    T0 + 5,
  );

  ingest(
    state,
    sessionEvent(
      'session-parent',
      'user/message',
      {
        role: 'user',
        content: [{ type: 'text', text: 'Background subagent child finished and will do no further work.' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          senderSessionId: 'child',
          summary: 'Background subagent child finished and will do no further work.',
        },
      },
      1,
    ),
    T0 + 10,
  );

  let child = snapshot(state).entries.find((entry) => entry.id === 'session-child');
  assert.equal(child.subagentState, 'finished');
  assert.equal(child.status, 'done');
  assert.ok(child.retainedUntil > T0);

  ingest(state, { kind: 'disposed', agentId: 'session-child' }, T0 + 20);
  child = snapshot(state).entries.find((entry) => entry.id === 'session-child');
  assert.ok(child, '子代理停止后不能立即从列表消失');
  assert.equal(child.subagentState, 'finished');

  ingest(
    state,
    sessionEvent('session-parent', 'todo/write', { todos: [{ content: 'T1', status: 'completed' }] }, 2),
    T0 + 25,
  );
  ingest(
    state,
    { kind: 'meta', sessionId: 'session-child2', parentId: 'session-parent', isSubagent: true, subagentName: 'other' },
    T0 + 26,
  );
  ingest(state, status('session-parent', 'idle'), T0 + 30);
  ingest(state, { kind: 'ack', sessionId: 'session-parent' }, T0 + 40);
  const afterAck = snapshot(state);
  assert.equal(
    afterAck.entries.some((entry) => entry.id === 'session-child'),
    false,
    '父会话 ack 后清理终态子代理',
  );
  assert.equal(
    afterAck.entries.some((entry) => entry.id === 'session-child2'),
    false,
    '父会话 ack 后清理未标记终态的子代理行',
  );
  assert.deepEqual(
    afterAck.entries.find((entry) => entry.id === 'session-parent').todos,
    [],
    '父会话 ack 后清空待办',
  );
  assert.equal(state.sessions.get('session-parent').acked, true);
});

test('subagent-settled 的 stopped 摘要不能被 finished 误判', () => {
  const state = createState();
  ingest(state, status('session-parent', 'running'), T0);
  ingest(
    state,
    { kind: 'meta', sessionId: 'session-child', parentId: 'session-parent', isSubagent: true, subagentName: 'dsh-runtime' },
    T0 + 5,
  );
  ingest(
    state,
    sessionEvent(
      'session-parent',
      'user/message',
      {
        role: 'user',
        content: [{ type: 'text', text: 'Background subagent child was stopped before it finished.' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          senderSessionId: 'child',
          summary: 'Background subagent child was stopped before it finished.',
        },
      },
      1,
    ),
    T0 + 10,
  );
  const child = snapshot(state).entries.find((entry) => entry.id === 'session-child');
  assert.equal(child.subagentState, 'stopped');
});

test('标题三级回落：cwd 先到，首条用户消息后来居上', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, { kind: 'meta', sessionId: 's1', label: 'dsh-notch-win', labelSource: 'cwd' }, T0 + 5);
  assert.equal(snapshot(state).entries[0].label, 'dsh-notch-win');

  ingest(
    state,
    sessionEvent('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: '把设置页接到原生插件分区' }] }, 1),
    T0 + 10,
  );
  assert.equal(snapshot(state).entries[0].label, '把设置页接到原生插件分区');

  // 后续用户消息不再改标题
  ingest(
    state,
    sessionEvent('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: '再改一处' }] }, 2),
    T0 + 20,
  );
  assert.equal(snapshot(state).entries[0].label, '把设置页接到原生插件分区');
});

test('DSH 会话标题优先于首条用户消息；焦点会补建没有事件的条目', () => {
  const state = createState();
  ingest(state, { kind: 'focus', sessionId: 'idle-x' }, T0);
  const focused = snapshot(state);
  assert.equal(focused.primaryId, 'idle-x');
  assert.ok(
    focused.entries.some((entry) => entry.id === 'idle-x'),
    '焦点会话必须出现在 entries 里，否则岛会回落到第一条旧会话',
  );

  ingest(
    state,
    sessionEvent('idle-x', 'user/message', { role: 'user', content: [{ type: 'text', text: '首条用户消息' }] }, 1),
    T0 + 10,
  );
  assert.equal(snapshot(state).entries.find((entry) => entry.id === 'idle-x').label, '首条用户消息');

  ingest(
    state,
    sessionEvent('idle-x', 'session/title', { title: '灵动岛App未随dsh启动排查' }, 2),
    T0 + 20,
  );
  assert.equal(
    snapshot(state).entries.find((entry) => entry.id === 'idle-x').label,
    '灵动岛App未随dsh启动排查',
  );

  // 标题之后的用户消息不能把它覆盖回首条消息
  ingest(
    state,
    sessionEvent('idle-x', 'user/message', { role: 'user', content: [{ type: 'text', text: '后续消息' }] }, 3),
    T0 + 30,
  );
  assert.equal(
    snapshot(state).entries.find((entry) => entry.id === 'idle-x').label,
    '灵动岛App未随dsh启动排查',
  );
});

test('没有标题时回落到 shortId', () => {
  const state = createState();
  ingest(state, status('session-abcdef123456', 'running'), T0);
  const [entry] = snapshot(state).entries;
  assert.equal(entry.label, 'abcdef12');
  assert.equal(entry.shortId, 'abcdef12');
  assert.equal(shortId('session-abcdef123456'), 'abcdef12');
  assert.equal(shortId('ses_xyz'), 'ses_xyz');
});

test('排序：正在干活的优先，其次主会话，最后最近更新；上限按 MAX_ENTRIES', () => {
  const state = createState();
  ingest(state, status('idle-a', 'running'), T0);
  ingest(state, status('idle-b', 'running'), T0);
  ingest(state, status('done-a', 'running'), T0);
  ingest(state, status('done-a', 'idle'), T0 + 1);
  ingest(state, { kind: 'focus', sessionId: 'idle-b' }, T0);

  let entries = snapshot(state).entries;
  assert.deepEqual(entries.map((e) => e.id), ['idle-b', 'idle-a', 'done-a']);
  assert.equal(snapshot(state).primaryId, 'idle-b');

  for (let i = 0; i < 70; i += 1) ingest(state, status(`extra-${i}`, 'running'), T0);
  assert.equal(snapshot(state).entries.length, P.MAX_ENTRIES);
});

test('rev 只在可见内容变化时改变', () => {
  const state = createState();
  const env0 = env();
  ingest(state, status('s1', 'running'), T0);
  const first = revOf(buildStable(state, env0));

  assert.equal(revOf(buildStable(state, env0)), first, '同一状态必须得到同一个 rev');

  // 新会话开始执行**是**可见变化
  ingest(state, status('s2', 'running'), T0);
  const second = revOf(buildStable(state, env0));
  assert.notEqual(second, first);

  // 但重复的 running 不是
  assert.equal(ingest(state, status('s2', 'running'), T0 + 1), false);
  assert.equal(revOf(buildStable(state, env0)), second, '重复的 running 不算变化');

  // 只有在被忽略的会话上发生的、不影响展示的事件才不算变化
  ingest(state, sessionEvent('s1', 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, 1), T0 + 2);
  assert.notEqual(revOf(buildStable(state, env0)), second);

  // buildStable 只挑已知字段：env 上多余的键不许渗进 rev
  const a = buildStable(state, env0);
  const b = buildStable(state, { ...env0, notAStableField: T0 + 999 });
  assert.equal(revOf(a), revOf(b));
});

test('disposed 移除条目并清掉焦点', () => {
  const state = createState();
  ingest(state, status('s1', 'running'), T0);
  ingest(state, { kind: 'focus', sessionId: 's1' }, T0);
  assert.equal(ingest(state, { kind: 'disposed', agentId: 's1' }), true);
  assert.equal(snapshot(state).entries.length, 0);
  assert.equal(snapshot(state).primaryId, null);
  assert.equal(ingest(state, { kind: 'disposed', agentId: 's1' }), false);
});

test('父会话 disposed 时若还有子代理，保留父占位而不是删掉', () => {
  const state = createState();
  ingest(state, status('parent', 'running'), T0);
  ingest(
    state,
    { kind: 'meta', sessionId: 'child', parentId: 'parent', isSubagent: true, subagentName: 'jump-chain' },
    T0 + 5,
  );
  ingest(state, { kind: 'disposed', agentId: 'parent' }, T0 + 10);

  const entries = snapshot(state).entries;
  assert.ok(entries.some((entry) => entry.id === 'parent'), '父占位必须保留');
  assert.equal(entries.find((entry) => entry.id === 'parent').status, 'idle');
  assert.ok(entries.some((entry) => entry.id === 'child'));
});

test('陈旧的空闲条目会被回收，live 条目永不回收', () => {
  const state = createState();
  ingest(state, status('live', 'running'), T0);
  ingest(state, { kind: 'created', agentId: 'stale' }, T0);
  tick(state, T0 + P.EVICT_IDLE_MS + 1);

  const ids = snapshot(state).entries.map((e) => e.id);
  assert.deepEqual(ids, ['live']);
});

test('有空闲子代理时父会话不会被单独回收', () => {
  const state = createState();
  ingest(state, { kind: 'meta', sessionId: 'parent', workspace: 'demo' }, T0);
  ingest(
    state,
    { kind: 'meta', sessionId: 'child', parentId: 'parent', isSubagent: true, subagentName: 'jump-chain' },
    T0 + P.EVICT_IDLE_MS + 5,
  );
  tick(state, T0 + P.EVICT_IDLE_MS + 10);

  const ids = snapshot(state).entries.map((entry) => entry.id);
  assert.ok(ids.includes('parent'), '父会话不能先于子代理被回收');
  assert.ok(ids.includes('child'));
});

test('summarizeCall 只取一个参数值并截断', () => {
  assert.equal(summarizeCall('bash', '{\"command\":\"npm test\",\"timeout\":10}'), 'bash · npm test');
  assert.equal(
    summarizeCall('str_replace_editor', '{\"file_path\":\"lib/state.js\",\"old_str\":\"x\"}'),
    'str_replace_editor · lib/state.js',
  );
  assert.equal(summarizeCall('bash', 'not json'), 'bash');
  assert.equal(summarizeCall('bash', '{\"command\":\"' + 'x'.repeat(500) + '\"}').length <= P.DETAIL_MAX, true);
  assert.equal(
    summarizeCall('bash', JSON.stringify({ command: 'a\nb' })),
    'bash · a b',
    '控制字符/换行必须被折叠成单个空格',
  );
  assert.equal(summarizeCall('bash', JSON.stringify({ command: 'a\u0000b' })), 'bash · a b');
});

test('未知事件类型与畸形负载都不会抛，也不会建条目', () => {
  const state = createState();
  assert.equal(ingest(state, sessionEvent('s1', 'assistant/chunk', { chunk: 'x' }, 1), T0), false);
  assert.equal(ingest(state, { kind: 'event', sessionId: 's1', event: null }, T0), false);
  assert.equal(ingest(state, { kind: 'event', sessionId: 's1', event: { type: 'nope' } }, T0), false);
  assert.equal(ingest(state, null, T0), false);
  assert.equal(ingest(state, { kind: '不存在' }, T0), false);
  assert.equal(snapshot(state).entries.length, 0);
});
