// Generates public/data/loops.fixture.json — a SYNTHETIC dataset shaped exactly
// like SCHEMA.md. It is used only when ../data/loops.json (real data, produced
// by the pipeline worker) is absent. Nothing here is observed from Obvious;
// the storage text says so.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/data/loops.fixture.json');

const est = (chars) => Math.ceil(chars / 4);
const T0 = Date.parse('2026-09-03T14:00:00Z');
let clock = T0;
const tick = (ms) => new Date((clock += ms)).toISOString();

// --- synthetic transcript ----------------------------------------------------
const PROJECT_ID = 'prj_FIXTURE0';
const ORCH = 'th_FIXTUREorch';
const W1 = 'th_FIXTUREwrk1';
const W2 = 'th_FIXTUREwrk2';

const lorem = (n, seed) => {
  const words = ['loop', 'turn', 'context', 'tool', 'result', 'reason', 'plan', 'observe', 'respond', 'delegate', 'wake', 'agent', 'thread', 'step', 'prompt', 'chars', 'tokens', 'schema', 'sankey', 'hierarchy'];
  const outWords = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280;
    outWords.push(words[s % words.length]);
  }
  return outWords.join(' ');
};

// Each turn: user message, then a script of assistant steps.
// kind: 'reasoning' | 'text' | 'tool-call' | 'tool-result' | 'task' (delegation)
const orchTurns = [
  {
    user: 'FIXTURE user message 1: Build a D3.js data visualization (Sankey or similar) that maps out agent loops and the internal loops Obvious follows, in TypeScript.',
    steps: [
      { kind: 'reasoning', text: 'FIXTURE reasoning: the request has two halves — a data pipeline and a visualization app. Orient first: list existing artifacts and check where turn data lives. ' + lorem(60, 1) },
      { kind: 'tool-call', toolName: 'execute-command', input: { command: 'ls -la ~/.obvious/ && obvious threads list --limit=20' }, summary: 'List local state and project threads' },
      { kind: 'tool-result', text: JSON.stringify({ stdout: 'total 0\n(empty)\n[{"id":"th_FIXTUREorch","name":"main","type":"conversation"}]', exitCode: 0 }, null, 2) },
      { kind: 'reasoning', text: 'FIXTURE reasoning: no local persistence; the SDK is the source. Write a shared schema so two workers can build in parallel. ' + lorem(40, 2) },
      { kind: 'tool-call', toolName: 'write-file', input: { path: '/home/user/work/agents-visualized/SCHEMA.md', content: '# agents-visualized — shared data contract\n' + lorem(300, 3) }, summary: 'Write SCHEMA.md' },
      { kind: 'tool-result', text: JSON.stringify({ created: true, bytesWritten: 7873 }) },
      { kind: 'tool-call', toolName: 'obvious-sdk', input: { command: 'obvious tasks create --title="Extract loop dataset (pipeline)" --assignee=agent' }, summary: 'Create pipeline task' },
      { kind: 'tool-result', text: JSON.stringify({ id: 'todo_FIXTURE_pipe', status: 'todo' }) },
      { kind: 'task', id: 'todo_FIXTURE_pipe', title: 'Extract loop dataset (pipeline)', assignee: 'agent', status: 'in_progress', thread: W1, prompt: 'FIXTURE dispatch prompt: read SCHEMA.md in full, then read every thread in the project via the SDK and write data/loops.json conforming to it. ' + lorem(120, 4) },
      { kind: 'tool-call', toolName: 'obvious-sdk', input: { command: 'obvious tasks create --title="Build D3 + TypeScript agent-loop visualization app" --assignee=agent' }, summary: 'Create app task' },
      { kind: 'tool-result', text: JSON.stringify({ id: 'todo_FIXTURE_app', status: 'todo' }) },
      { kind: 'task', id: 'todo_FIXTURE_app', title: 'Build D3 + TypeScript agent-loop visualization app', assignee: 'agent', status: 'in_progress', thread: W2, prompt: 'FIXTURE dispatch prompt: build a Vite + TypeScript + D3 app at app/ that renders the dataset described in SCHEMA.md with hover/focus tooltips on every node. ' + lorem(150, 5) },
      { kind: 'text', text: 'FIXTURE closing message: I wrote the shared schema and dispatched two workers (pipeline and app). I will report back when both complete.' },
    ],
  },
  {
    user: 'FIXTURE user message 2: Depict all information that you can (turns, agents, context size, prompt size, with hover-enabled text content for all these).',
    steps: [
      { kind: 'reasoning', text: 'FIXTURE reasoning: extend the contract — every step node must carry chars, tokensEst, contextChars, promptChars and fullText. Steer both workers. ' + lorem(50, 6) },
      { kind: 'tool-call', toolName: 'edit-file', input: { path: '/home/user/work/agents-visualized/SCHEMA.md', edits: [{ type: 'search-replace', search: 'meta?: {', replace: 'meta?: { chars: number; tokensEst: number; contextChars?: number; promptChars?: number;' }] }, summary: 'Add size fields to schema' },
      { kind: 'tool-result', text: JSON.stringify({ linesAdded: 12, linesRemoved: 2 }) },
      { kind: 'tool-call', toolName: 'obvious-sdk', input: { command: 'obvious threads sendMessage --recipientThreadId=th_FIXTUREwrk1 --content="Schema updated: add size fields"' }, summary: 'Steer pipeline worker' },
      { kind: 'tool-result', text: JSON.stringify({ delivered: true }) },
      { kind: 'text', text: 'FIXTURE closing message: schema extended with sizes and hover text; both workers steered.' },
    ],
  },
  {
    user: 'FIXTURE wake: task todo_FIXTURE_pipe reported success — data/loops.json written (1 thread, 3 turns).',
    wake: true,
    steps: [
      { kind: 'reasoning', text: 'FIXTURE reasoning: review the worker output against the acceptance criteria before closing the task. ' + lorem(30, 7) },
      { kind: 'tool-call', toolName: 'read-file', input: { path: '/home/user/work/agents-visualized/data/loops.json', limit: 80 }, summary: 'Review dataset head' },
      { kind: 'tool-result', text: '{\n  "version": 1,\n  "generatedAt": "2026-09-03T15:58:00Z",\n  ' + lorem(200, 8) },
      { kind: 'tool-call', toolName: 'obvious-sdk', input: { command: 'obvious tasks update --taskId=todo_FIXTURE_pipe --status=completed' }, summary: 'Close pipeline task' },
      { kind: 'tool-result', text: JSON.stringify({ id: 'todo_FIXTURE_pipe', status: 'completed' }) },
      { kind: 'text', text: 'FIXTURE closing message: pipeline output reviewed and accepted; waiting on the app worker.' },
    ],
  },
];

const workerTurns = {
  [W1]: [
    {
      user: 'FIXTURE dispatch prompt: read SCHEMA.md in full, then read every thread in the project via the SDK and write data/loops.json conforming to it. ' + lorem(120, 4),
      steps: [
        { kind: 'reasoning', text: 'FIXTURE worker reasoning: read the schema, then enumerate threads and page messages. ' + lorem(40, 9) },
        { kind: 'tool-call', toolName: 'read-file', input: { path: '/home/user/work/agents-visualized/SCHEMA.md' }, summary: 'Read schema' },
        { kind: 'tool-result', text: '# agents-visualized — shared data contract\n' + lorem(400, 10) },
        { kind: 'tool-call', toolName: 'execute-command', input: { command: 'node pipeline/extract.mjs > data/loops.json' }, summary: 'Run extractor' },
        { kind: 'tool-result', text: JSON.stringify({ stdout: 'wrote data/loops.json (threads=1 messages=42)', exitCode: 0 }) },
        { kind: 'tool-call', toolName: 'execute-command', input: { command: 'node pipeline/validate.mjs data/loops.json' }, summary: 'Validate output' },
        { kind: 'tool-result', text: JSON.stringify({ stdout: 'ERROR: stats.turns[0].contextCharsAtEnd missing', exitCode: 1 }), isError: true },
        { kind: 'reasoning', text: 'FIXTURE worker reasoning: validation failed on a missing field; fix the reducer and re-run. ' + lorem(20, 11) },
        { kind: 'tool-call', toolName: 'execute-command', input: { command: 'node pipeline/extract.mjs > data/loops.json && node pipeline/validate.mjs data/loops.json' }, summary: 'Re-run extractor and validator' },
        { kind: 'tool-result', text: JSON.stringify({ stdout: 'OK', exitCode: 0 }) },
        { kind: 'text', text: 'FIXTURE worker report: data/loops.json written and validated.' },
      ],
    },
  ],
  [W2]: [
    {
      user: 'FIXTURE dispatch prompt: build a Vite + TypeScript + D3 app at app/ that renders the dataset described in SCHEMA.md with hover/focus tooltips on every node. ' + lorem(150, 5),
      steps: [
        { kind: 'reasoning', text: 'FIXTURE worker reasoning: read the schema and the Modern Web Guidance skill first. ' + lorem(30, 12) },
        { kind: 'tool-call', toolName: 'read-file', input: { path: '/home/user/work/agents-visualized/SCHEMA.md' }, summary: 'Read schema' },
        { kind: 'tool-result', text: '# agents-visualized — shared data contract\n' + lorem(400, 13) },
        { kind: 'tool-call', toolName: 'execute-command', input: { command: 'npx -y modern-web-guidance@latest search "tooltip popover anchor positioning"' }, summary: 'Search guidance' },
        { kind: 'tool-result', text: JSON.stringify([{ id: 'position-aware-tooltips', similarity: 0.82 }, { id: 'interest-triggered-tooltips', similarity: 0.69 }], null, 2) },
        { kind: 'tool-call', toolName: 'write-file', input: { path: '/home/user/work/agents-visualized/app/src/main.ts', content: 'import * as d3 from "d3";\n' + lorem(250, 14) }, summary: 'Write app entry' },
        { kind: 'tool-result', text: JSON.stringify({ created: true, bytesWritten: 5120 }) },
        { kind: 'tool-call', toolName: 'execute-command', input: { command: 'npm run build' }, summary: 'Build' },
        { kind: 'tool-result', text: JSON.stringify({ stdout: 'vite v6 building for production...\n✓ built in 1.8s', exitCode: 0 }) },
        { kind: 'text', text: 'FIXTURE worker report: app builds; six views render from the fixture.' },
      ],
    },
  ],
};

// --- build hierarchy ---------------------------------------------------------
const stepStage = (s) =>
  s.kind === 'user-message' ? 'user'
  : s.kind === 'reasoning' ? 'reason'
  : s.kind === 'tool-call' ? `tool:${s.meta.toolName}`
  : s.kind === 'tool-result' ? 'observe'
  : s.kind === 'task' ? 'delegate'
  : s.kind === 'worker-thread' ? 'worker'
  : s.kind === 'wake' ? 'wake'
  : 'respond';

const textNode = (id, name, kind, text, extra) => {
  const chars = text.length;
  const truncated = chars > 6000;
  return {
    id, name, kind,
    value: kind === 'tool-call' ? 1 : chars,
    meta: {
      chars, tokensEst: est(chars),
      excerpt: text.slice(0, 400),
      fullText: truncated ? text.slice(0, 6000) : text,
      truncated,
      ...extra,
    },
  };
};

const flowCounts = new Map(); // "a|b|kind" -> count
const flowNodeCounts = new Map(); // stage -> count
const flowExamples = new Map();
const addFlow = (a, b, kind) => {
  const k = `${a}|${b}|${kind}`;
  flowCounts.set(k, (flowCounts.get(k) ?? 0) + 1);
};
const bump = (stage, kind) => {
  const cur = flowNodeCounts.get(stage) ?? { count: 0, kind };
  cur.count += 1;
  flowNodeCounts.set(stage, cur);
};

const statsTurns = [];
const toolAgg = new Map();
const agentAgg = new Map();
const touchAgent = (agent, key, n = 1) => {
  const a = agentAgg.get(agent) ?? { agent, threads: new Set(), turns: 0, toolCalls: 0, chars: 0, tokensEst: 0 };
  if (key === 'thread') a.threads.add(n); else a[key] += n;
  agentAgg.set(agent, a);
};

function buildThread(threadId, name, agent, turns, workerNodesByTask) {
  let context = 0;
  const turnNodes = [];
  turns.forEach((t, turnIndex) => {
    const startedAt = tick(1000);
    const steps = [];
    let stepIndex = 0;
    const push = (n) => { n.meta.stepIndex = stepIndex++; n.meta.turnIndex = turnIndex; n.meta.threadId = threadId; n.meta.contextChars = context; n.meta.contextTokensEst = est(context); n.meta.createdAt = tick(800 + (n.meta.chars % 700)); context += n.meta.chars; steps.push(n); };

    const userKind = t.wake ? 'wake' : 'user-message';
    const u = textNode(`${threadId}/turn-${turnIndex}/step-0`, t.wake ? 'wake notice' : 'user message', userKind, t.user, { role: 'user', agent: t.wake ? 'orchestrator' : 'user', promptChars: t.user.length, messageId: `msg_FIXTURE_${threadId}_${turnIndex}_u` });
    push(u);
    let toolCalls = 0;
    let lastCallId = null;
    for (const s of t.steps) {
      const id = `${threadId}/turn-${turnIndex}/step-${stepIndex}`;
      if (s.kind === 'reasoning') push(textNode(id, 'reasoning', 'reasoning', s.text, { role: 'assistant', agent }));
      else if (s.kind === 'text') push(textNode(id, 'closing message', 'text', s.text, { role: 'assistant', agent }));
      else if (s.kind === 'tool-call') {
        const json = JSON.stringify(s.input, null, 2);
        lastCallId = `call_FIXTURE_${threadId}_${turnIndex}_${stepIndex}`;
        const n = textNode(id, s.toolName, 'tool-call', json, { role: 'assistant', agent, toolName: s.toolName, toolCallId: lastCallId, summary: s.summary, promptChars: JSON.stringify(s.input).length });
        push(n); toolCalls++;
        const ta = toolAgg.get(s.toolName) ?? { toolName: s.toolName, calls: 0, promptChars: 0, resultChars: 0, errors: 0 };
        ta.calls++; ta.promptChars += n.meta.promptChars; toolAgg.set(s.toolName, ta);
      } else if (s.kind === 'tool-result') {
        const prev = steps[steps.length - 1];
        const n = textNode(id, `result: ${prev?.meta.toolName ?? 'tool'}`, 'tool-result', s.text, { role: 'tool', agent, toolName: prev?.meta.toolName, toolCallId: lastCallId, isError: !!s.isError });
        push(n);
        const ta = toolAgg.get(prev?.meta.toolName);
        if (ta) { ta.resultChars += n.meta.chars; if (s.isError) ta.errors++; }
      } else if (s.kind === 'task') {
        const n = textNode(id, s.title, 'task', s.prompt, { role: 'assistant', agent, status: s.status, assignee: s.assignee, taskId: s.id, promptChars: s.prompt.length });
        n.value = 1;
        const wt = workerNodesByTask.get(s.id);
        if (wt) n.children = [wt];
        push(n);
      }
    }
    // flows
    for (let i = 0; i < steps.length; i++) {
      const a = steps[i];
      bump(stepStage(a), a.kind);
      const b = steps[i + 1];
      if (b) {
        const kind = b.kind === 'tool-result' ? 'tool' : a.kind === 'task' ? 'delegation' : 'sequence';
        addFlow(stepStage(a), stepStage(b), kind);
        const k = `${stepStage(a)}|${stepStage(b)}`;
        if (!flowExamples.has(k)) flowExamples.set(k, b.meta.excerpt);
      }
      if (a.kind === 'task') {
        addFlow('delegate', 'worker', 'delegation');
        bump('worker', 'worker-thread');
        addFlow('worker', 'wake', 'wake');
        bump('wake', 'wake');
      }
    }
    // if this turn was triggered by a wake, the wake precedes reason
    const chars = steps.reduce((s, n) => s + n.meta.chars, 0);
    const turnNode = {
      id: `${threadId}/turn-${turnIndex}`,
      name: `turn ${turnIndex + 1}`,
      kind: 'turn',
      value: chars,
      meta: { agent, threadId, turnIndex, chars, tokensEst: est(chars), contextChars: steps[0].meta.contextChars, promptChars: t.user.length, createdAt: startedAt, excerpt: t.user.slice(0, 400), fullText: t.user.slice(0, 6000), truncated: false },
      children: steps,
    };
    turnNodes.push(turnNode);
    statsTurns.push({ threadId, turnIndex, agent, startedAt, endedAt: steps[steps.length - 1].meta.createdAt, steps: steps.length, toolCalls, chars, tokensEst: est(chars), contextCharsAtEnd: context, userPromptChars: t.user.length });
    touchAgent(agent, 'turns', 1); touchAgent(agent, 'toolCalls', toolCalls); touchAgent(agent, 'chars', chars); touchAgent(agent, 'tokensEst', est(chars)); touchAgent(agent, 'thread', threadId);
    touchAgent('user', 'chars', t.user.length); touchAgent('user', 'tokensEst', est(t.user.length)); touchAgent('user', 'thread', threadId);
  });
  const chars = turnNodes.reduce((s, n) => s + n.meta.chars, 0);
  return {
    id: threadId, name, kind: 'thread', value: chars,
    meta: { agent, threadId, chars, tokensEst: est(chars), contextChars: 0, createdAt: turnNodes[0].meta.createdAt, excerpt: `${name} — ${turnNodes.length} turns`, fullText: `${name} — ${turnNodes.length} turns, ${chars} chars total.` },
    children: turnNodes,
  };
}

// Worker threads first so they can nest under the dispatching task node.
const workerNodesByTask = new Map();
const w1 = buildThread(W1, 'worker: pipeline', 'worker:agent', workerTurns[W1], new Map());
w1.kind = 'worker-thread'; w1.meta.promptChars = workerTurns[W1][0].user.length; w1.meta.status = 'completed'; w1.meta.assignee = 'agent';
workerNodesByTask.set('todo_FIXTURE_pipe', w1);
const w2 = buildThread(W2, 'worker: app', 'worker:agent', workerTurns[W2], new Map());
w2.kind = 'worker-thread'; w2.meta.promptChars = workerTurns[W2][0].user.length; w2.meta.status = 'in_progress'; w2.meta.assignee = 'agent';
workerNodesByTask.set('todo_FIXTURE_app', w2);
const orch = buildThread(ORCH, 'orchestrator', 'orchestrator', orchTurns, workerNodesByTask);

const totalChars = orch.meta.chars + w1.meta.chars + w2.meta.chars;
const hierarchy = {
  id: PROJECT_ID, name: 'agents-visualized (FIXTURE)', kind: 'project', value: totalChars,
  meta: { agent: 'orchestrator', chars: totalChars, tokensEst: est(totalChars), excerpt: 'Synthetic fixture project', fullText: 'Synthetic fixture project. Replace by dropping the real data/loops.json produced by the pipeline worker.' },
  children: [orch],
};

// --- flows -------------------------------------------------------------------
const flowNodes = [...flowNodeCounts.entries()].map(([stage, v]) => ({ id: `stage:${stage}`, name: stage.startsWith('tool:') ? stage.slice(5) : stage, stage, kind: v.kind, count: v.count }));
const flowLinks = [...flowCounts.entries()].map(([k, value]) => { const [a, b, kind] = k.split('|'); return { source: `stage:${a}`, target: `stage:${b}`, value, kind }; });

// --- delegation ---------------------------------------------------------------
const mkWake = (taskId, thread, status, text) => textNode(`${taskId}/wake`, `wake: ${status}`, 'wake', text, { agent: 'orchestrator', status, threadId: ORCH, taskId });
const taskNode = (id, title, assignee, status, thread, prompt, wakeText) => {
  const n = textNode(`task:${id}`, title, 'task', prompt, { agent: 'orchestrator', status, assignee, taskId: id, promptChars: prompt.length, createdAt: new Date(T0 + 60_000).toISOString() });
  n.value = 1;
  const wt = { id: `task:${id}/${thread}`, name: `worker thread ${thread}`, kind: 'worker-thread', value: 1, meta: { agent: `worker:${assignee}`, threadId: thread, status, assignee, chars: prompt.length, tokensEst: est(prompt.length), promptChars: prompt.length, excerpt: prompt.slice(0, 400), fullText: prompt, truncated: false } };
  n.children = wakeText ? [wt, mkWake(`task:${id}`, thread, status, wakeText)] : [wt];
  return n;
};
const rootPrompt = orchTurns[0].user;
const delegation = {
  id: 'task:root', name: 'agents-visualized: D3 + TypeScript visualization of Obvious agent loops (FIXTURE)', kind: 'task', value: 1,
  meta: { agent: 'orchestrator', status: 'in_progress', assignee: 'obvious', chars: rootPrompt.length, tokensEst: est(rootPrompt.length), promptChars: rootPrompt.length, excerpt: rootPrompt.slice(0, 400), fullText: rootPrompt, truncated: false, createdAt: new Date(T0).toISOString() },
  children: [
    taskNode('todo_FIXTURE_pipe', 'Extract loop dataset (pipeline)', 'agent', 'completed', W1, workerTurns[W1][0].user, orchTurns[2].user),
    taskNode('todo_FIXTURE_app', 'Build D3 + TypeScript agent-loop visualization app', 'agent', 'in_progress', W2, workerTurns[W2][0].user, null),
    (() => { const p = 'FIXTURE: integrate real data, verify guidance, host the app.'; const n = textNode('task:todo_FIXTURE_host', 'Integrate live data and host', 'task', p, { agent: 'orchestrator', status: 'blocked', assignee: 'agent', taskId: 'todo_FIXTURE_host', promptChars: p.length }); n.value = 1; return n; })(),
  ],
};

// --- documented loop model (verbatim from SCHEMA.md) ---------------------------
const loopModel = {
  loops: [
    {
      id: 'turn', name: 'Turn loop', description: 'One user message and everything the assistant does until the closing message.',
      phases: [
        { id: 'receive', name: 'receive', description: 'user message', observedKinds: ['user-message'] },
        { id: 'orient', name: 'orient', description: 'search/list existing artifacts, read context', observedKinds: ['reasoning', 'tool-call'] },
        { id: 'plan', name: 'plan', description: 'create/update tasks in the task tree', observedKinds: ['tool-call', 'task'] },
        { id: 'act', name: 'act', description: 'tool calls', observedKinds: ['tool-call'] },
        { id: 'observe', name: 'observe', description: 'tool results; repeat act↔observe', observedKinds: ['tool-result'] },
        { id: 'respond', name: 'respond', description: 'single closing message; earlier text folds into an activity log', observedKinds: ['text'] },
      ],
      edges: [
        { from: 'receive', to: 'orient', kind: 'next' }, { from: 'orient', to: 'plan', kind: 'next' }, { from: 'plan', to: 'act', kind: 'next' },
        { from: 'act', to: 'observe', kind: 'next' }, { from: 'observe', to: 'act', kind: 'repeat', label: 'repeat' }, { from: 'observe', to: 'respond', kind: 'next' },
        { from: 'respond', to: 'receive', kind: 'exit', label: 'closing message' },
      ],
    },
    {
      id: 'delegation', name: 'Delegation loop', description: 'Decompose, dispatch workers, sleep, wake on notices, review, steer or close, synthesize.',
      phases: [
        { id: 'decompose', name: 'decompose', description: 'split into self-contained deliverables', observedKinds: ['reasoning'] },
        { id: 'dispatch', name: 'dispatch', description: 'tasks create + tasks start; worker runs its own Turn loop in its own thread', observedKinds: ['task', 'worker-thread'] },
        { id: 'sleep', name: 'sleep', description: 'orchestrator ends turn; never polls', observedKinds: ['text'] },
        { id: 'wake', name: 'wake', description: 'completion / needs_input / failure notice', observedKinds: ['wake'] },
        { id: 'review', name: 'review', description: 'read result vs acceptance criteria', observedKinds: ['tool-call', 'tool-result'] },
        { id: 'steer', name: 'steer', description: 'send back for rework; repeat', observedKinds: ['tool-call'] },
        { id: 'close', name: 'close', description: 'tasks update --status=completed', observedKinds: ['tool-call'] },
        { id: 'synthesize', name: 'synthesize', description: 'present in own words', observedKinds: ['text'] },
      ],
      edges: [
        { from: 'decompose', to: 'dispatch', kind: 'next' }, { from: 'dispatch', to: 'sleep', kind: 'next' }, { from: 'sleep', to: 'wake', kind: 'next' },
        { from: 'wake', to: 'review', kind: 'next' }, { from: 'review', to: 'steer', kind: 'next' }, { from: 'steer', to: 'wake', kind: 'repeat', label: 'rework' },
        { from: 'review', to: 'close', kind: 'next' }, { from: 'close', to: 'synthesize', kind: 'next' }, { from: 'synthesize', to: 'decompose', kind: 'exit' },
      ],
    },
    {
      id: 'skill', name: 'Skill loop', description: 'Match a domain skill, load it, follow it every turn, unload.',
      phases: [
        { id: 'match', name: 'match', description: 'task domain has a skill', observedKinds: ['reasoning'] },
        { id: 'load', name: 'load', description: 'skills load', observedKinds: ['tool-call'] },
        { id: 'follow', name: 'follow', description: 'skill instructions injected every turn', observedKinds: ['reasoning', 'tool-call'] },
        { id: 'unload', name: 'unload', description: 'skills unload', observedKinds: ['tool-call'] },
      ],
      edges: [
        { from: 'match', to: 'load', kind: 'next' }, { from: 'load', to: 'follow', kind: 'next' }, { from: 'follow', to: 'unload', kind: 'next' }, { from: 'unload', to: 'match', kind: 'exit' },
      ],
    },
    {
      id: 'memory', name: 'Memory loop', description: 'After each turn facts and summaries are extracted, stored, and injected into the next turn.',
      phases: [
        { id: 'extract', name: 'extract', description: 'after each turn: facts + summaries auto-extracted', observedKinds: ['text'] },
        { id: 'store', name: 'store', description: 'persist facts and summaries', observedKinds: [] },
        { id: 'inject', name: 'inject', description: 'Active Memory in next turn\'s context', observedKinds: ['user-message'] },
        { id: 'use', name: 'use', description: 'agent applies remembered facts', observedKinds: ['reasoning'] },
      ],
      edges: [
        { from: 'extract', to: 'store', kind: 'next' }, { from: 'store', to: 'inject', kind: 'next' }, { from: 'inject', to: 'use', kind: 'next' }, { from: 'use', to: 'extract', kind: 'repeat', label: 'next turn' },
      ],
    },
    {
      id: 'human', name: 'Human-in-the-loop', description: 'Gated actions wait for a human decision before the agent continues.',
      phases: [
        { id: 'gate', name: 'gate', description: 'propose-plan / ask-user / confirmation-gated 🔒 action', observedKinds: ['tool-call'] },
        { id: 'notify', name: 'notify', description: 'user is notified of the pending decision', observedKinds: ['text'] },
        { id: 'decide', name: 'decide', description: 'approve / edit / reject', observedKinds: ['user-message'] },
        { id: 'wake', name: 'wake', description: 'agent is woken with the decision', observedKinds: ['wake'] },
        { id: 'continue', name: 'continue', description: 'agent continues its turn', observedKinds: ['reasoning', 'tool-call'] },
      ],
      edges: [
        { from: 'gate', to: 'notify', kind: 'next' }, { from: 'notify', to: 'decide', kind: 'next' }, { from: 'decide', to: 'wake', kind: 'next' }, { from: 'wake', to: 'continue', kind: 'next' }, { from: 'continue', to: 'gate', kind: 'exit' },
      ],
    },
  ],
};

const dataset = {
  version: 1,
  generatedAt: new Date(T0 + 3 * 3600_000).toISOString(),
  source: {
    projectId: PROJECT_ID,
    threadIds: [ORCH, W1, W2],
    messageCount: statsTurns.reduce((s, t) => s + t.steps, 0),
    storage: 'FIXTURE — synthetic data generated by app/scripts/make-fixture.mjs so the app can render before the pipeline finishes. Nothing here was read from Obvious; ids, texts and sizes are invented and shaped to SCHEMA.md. The real dataset is produced by the pipeline worker at data/loops.json from server-side thread messages read via the Obvious SDK.',
  },
  hierarchy,
  stats: {
    turns: statsTurns,
    agents: [...agentAgg.values()].map((a) => ({ ...a, threads: a.threads.size })),
    tools: [...toolAgg.values()],
  },
  flows: { nodes: flowNodes, links: flowLinks },
  delegation,
  loopModel,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(dataset, null, 2));
console.log(`wrote ${out}: ${flowNodes.length} flow nodes, ${flowLinks.length} links, ${statsTurns.length} turns`);
