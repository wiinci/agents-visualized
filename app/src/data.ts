import type { LoadedDataset, LoopNode, LoopsDataset, NodeKind } from './types';

const REAL_URL = './data/loops.json';
const FIXTURE_URL = './data/loops.fixture.json';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Light structural check — enough to fail loudly on the wrong file, not a full validator. */
export function assertDataset(x: unknown, url: string): asserts x is LoopsDataset {
  if (!isRecord(x)) throw new Error(`${url}: not an object`);
  if (x.version !== 1) throw new Error(`${url}: version must be 1 (got ${String(x.version)})`);
  for (const k of ['generatedAt', 'source', 'hierarchy', 'stats', 'flows', 'delegation', 'loopModel'] as const) {
    if (!(k in x)) throw new Error(`${url}: missing top-level field "${k}"`);
  }
  const src = x.source;
  if (!isRecord(src) || typeof src.storage !== 'string') throw new Error(`${url}: source.storage must be a string`);
  const flows = x.flows;
  if (!isRecord(flows) || !Array.isArray(flows.nodes) || !Array.isArray(flows.links)) throw new Error(`${url}: flows.nodes/links must be arrays`);
  const lm = x.loopModel;
  if (!isRecord(lm) || !Array.isArray(lm.loops)) throw new Error(`${url}: loopModel.loops must be an array`);
  if (!isRecord(x.hierarchy) || typeof x.hierarchy.id !== 'string') throw new Error(`${url}: hierarchy must be a LoopNode`);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // SPA hosts answer missing files with index.html + 200; treat non-JSON as "file not present".
  const type = res.headers.get('content-type') ?? '';
  if (!/json/i.test(type)) throw new Error(`${url}: not found (server returned ${type || 'unknown content type'})`);
  return res.json();
}

/** Try the real dataset first; fall back to the fixture with an explicit note. */
export async function loadDataset(): Promise<LoadedDataset> {
  let realError = '';
  try {
    const json = await fetchJson(REAL_URL);
    assertDataset(json, REAL_URL);
    const isFixture = /fixture/i.test(json.source.storage);
    return { data: json, url: REAL_URL, isFixture, loadNote: isFixture ? 'data/loops.json is present but declares itself a fixture.' : 'Loaded data/loops.json.' };
  } catch (e) {
    realError = e instanceof Error ? e.message : String(e);
  }
  const json = await fetchJson(FIXTURE_URL);
  assertDataset(json, FIXTURE_URL);
  return { data: json, url: FIXTURE_URL, isFixture: true, loadNote: `data/loops.json unavailable (${realError}); showing the fixture.` };
}

// ---------------------------------------------------------------------------
// Derived indexes shared by several views (computed once, from observed data).

export interface StepRef { node: LoopNode; thread: LoopNode; turn: LoopNode; globalStepIndex: number }

const STEP_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['user-message', 'reasoning', 'text', 'tool-call', 'tool-result', 'task', 'wake']);

export function isStepKind(kind: NodeKind): boolean { return STEP_KINDS.has(kind); }

/** Flatten hierarchy into ordered steps per thread (worker threads are their own threads). */
export function collectThreads(root: LoopNode): Map<string, { thread: LoopNode; steps: StepRef[] }> {
  const out = new Map<string, { thread: LoopNode; steps: StepRef[] }>();
  const visitThread = (thread: LoopNode) => {
    const entry = { thread, steps: [] as StepRef[] };
    const tid = thread.meta?.threadId ?? thread.id;
    out.set(tid, entry);
    for (const turn of thread.children ?? []) {
      if (turn.kind !== 'turn') { if (turn.kind === 'thread' || turn.kind === 'worker-thread') visitThread(turn); continue; }
      for (const step of turn.children ?? []) {
        // real data nests worker threads directly under the dispatching turn
        if (step.kind === 'worker-thread' || step.kind === 'thread') { visitThread(step); continue; }
        if (isStepKind(step.kind)) entry.steps.push({ node: step, thread, turn, globalStepIndex: entry.steps.length });
        // nested worker threads under a dispatching task
        for (const c of step.children ?? []) if (c.kind === 'worker-thread' || c.kind === 'thread') visitThread(c);
      }
    }
  };
  const walk = (n: LoopNode) => {
    if (n.kind === 'thread' || n.kind === 'worker-thread') { visitThread(n); return; }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Map a step node to its Sankey stage id (same convention as SCHEMA.md flows). */
export function stageOf(node: LoopNode): string {
  switch (node.kind) {
    case 'user-message': return 'user';
    case 'reasoning': return 'reason';
    case 'tool-call': return `tool:${node.meta?.toolName ?? 'unknown'}`;
    case 'tool-result': return 'observe';
    case 'task': return 'delegate';
    case 'worker-thread': return 'worker';
    case 'wake': return 'wake';
    case 'text': return 'respond';
    default: return node.kind;
  }
}

/** Example step excerpts for each observed stage transition (for Sankey link tooltips). */
export function flowExamples(root: LoopNode, max = 3): Map<string, { from: LoopNode; to: LoopNode }[]> {
  const out = new Map<string, { from: LoopNode; to: LoopNode }[]>();
  for (const { steps } of collectThreads(root).values()) {
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i]!.node, b = steps[i + 1]!.node;
      const key = `stage:${stageOf(a)}->stage:${stageOf(b)}`;
      const arr = out.get(key) ?? [];
      if (arr.length < max) { arr.push({ from: a, to: b }); out.set(key, arr); }
    }
  }
  return out;
}

/** Count hierarchy nodes by kind (used to bridge documented phases to observed data). */
export function countKinds(root: LoopNode): Map<NodeKind, number> {
  const m = new Map<NodeKind, number>();
  const walk = (n: LoopNode) => { m.set(n.kind, (m.get(n.kind) ?? 0) + 1); for (const c of n.children ?? []) walk(c); };
  walk(root);
  return m;
}
