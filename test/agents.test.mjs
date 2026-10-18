import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, reviewDecision } from '../src/agents.mjs';

const run = { goal: '写一篇自我介绍', workspace: 'E:\\agent work', limits: { maxSteps: 3, maxRounds: 3, maxMinutes: 20 } };

test('missing personal facts stops as blocked after one review', async () => {
  let calls = 0;
  const result = await runAgentLoop(run, {
    dataDir: '.', key: 'test', signal: new AbortController().signal, emit: () => {},
    codex: async () => ++calls === 1 ? '查看个人资料，再起草' : 'BLOCKED\n请提供称呼和一项个人经历。',
    execute: async ({ emit }) => { emit('tool', { name: 'list_files', result: '' }); return { text: '目录没有个人资料', steps: 1 }; }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(calls, 2);
  assert.match(result.answer, /请提供称呼/);
});

test('tool budget is shared across rounds', async () => {
  const budgets = [];
  let calls = 0;
  const result = await runAgentLoop(run, {
    dataDir: '.', key: 'test', signal: new AbortController().signal, emit: () => {},
    codex: async () => ++calls === 1 ? '执行计划' : 'CONTINUE\n还需完成可执行步骤',
    execute: async ({ limits, emit }) => { budgets.push(limits.maxSteps); emit('tool', { name: 'web_search', result: '无关结果' }); return { text: '未完成', steps: Math.min(2, limits.maxSteps) }; }
  });
  assert.deepEqual(budgets, [3, 1]);
  assert.equal(result.status, 'limit_reached');
});

test('review decision accepts the three terminal states', () => {
  assert.equal(reviewDecision('DONE\n已完成'), 'DONE');
  assert.equal(reviewDecision('BLOCKED：缺少用户资料'), 'BLOCKED');
  assert.equal(reviewDecision('CONTINUE\n继续'), 'CONTINUE');
});
