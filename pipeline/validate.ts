// Structural validation of data/loops.json against SCHEMA.md.
// Library use: `validateDataset(ds)` returns a list of problems (empty == valid).
// CLI use: `npx tsx pipeline/validate.ts [path]` — exits 1 on problems.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoopNode, LoopsDataset, NodeKind } from './types.js';

const NODE_KINDS: ReadonlySet<string> = new Set<NodeKind>([
  'project', 'thread', 'turn', 'user-message', 'reasoning', 'text', 'tool-call', 'tool-result', 'task', 'worker-thread', 'wake', 'phase',
]);
const STEP_KINDS: ReadonlySet<string> = new Set<NodeKind>(['user-message', 'reasoning', 'text', 'tool-call', 'tool-result', 'wake']);
const LINK_KINDS = new Set(['sequence', 'delegation', 'wake', 'tool']);
const EDGE_KINDS = new Set(['next', 'repeat', 'exit']);
const AGENT_RE = /^(user|orchestrator|worker:.+)$/;
const FULL_TEXT_CAP = 6000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

export function validateDataset(ds: LoopsDataset): string[] {
  const problems: string[] = [];
  const p = (msg: string) => problems.push(msg);

  if (ds.version !== 1) p(`version must be 1 (got ${String(ds.version)})`);
  if (!isStr(ds.generatedAt) || Number.isNaN(Date.parse(ds.generatedAt))) p('generatedAt must be an ISO date string');
  if (!ds.source || !isStr(ds.source.projectId)) p('source.projectId missing');
  if (!Array.isArray(ds.source?.threadIds)) p('source.threadIds must be an array');
  if (!isNum(ds.source?.messageCount)) p('source.messageCount must be a number');
  if (!isStr(ds.source?.storage) || ds.source.storage.length < 40) p('source.storage must be a descriptive paragraph');

  // --- hierarchy / delegation nodes ---
  const ids = new Set<string>();
  const seenThreads = new Set<string>();
  const walk = (n: LoopNode, path: string, tree: string) => {
    if (!isStr(n.id) || !n.id) { p(`${tree} ${path}: missing id`); return; }
    if (ids.has(n.id)) p(`${tree} ${path}: duplicate id ${n.id}`);
    ids.add(n.id);
    if (!isStr(n.name)) p(`${tree} ${n.id}: missing name`);
    if (!NODE_KINDS.has(n.kind)) p(`${tree} ${n.id}: invalid kind ${String(n.kind)}`);
    if (!isNum(n.value) || n.value < 0) p(`${tree} ${n.id}: value must be a non-negative number`);
    const m = n.meta;
    if (!m) { p(`${tree} ${n.id}: meta is required`); }
    else {
      if (!isNum(m.chars) || m.chars < 0) p(`${tree} ${n.id}: meta.chars missing`);
      if (!isNum(m.tokensEst)) p(`${tree} ${n.id}: meta.tokensEst missing`);
      else if (isNum(m.chars) && m.tokensEst !== Math.ceil(m.chars / 4)) p(`${tree} ${n.id}: tokensEst != ceil(chars/4)`);
      if (!isStr(m.agent) || !AGENT_RE.test(m.agent)) p(`${tree} ${n.id}: meta.agent invalid (${String(m.agent)})`);
      if (m.fullText !== undefined) {
        if (!isStr(m.fullText)) p(`${tree} ${n.id}: fullText must be a string`);
        else if (m.fullText.length > FULL_TEXT_CAP) p(`${tree} ${n.id}: fullText exceeds ${FULL_TEXT_CAP} chars`);
        if (m.excerpt !== undefined && isStr(m.excerpt) && m.excerpt.length > 400) p(`${tree} ${n.id}: excerpt exceeds 400 chars`);
      }
      if (STEP_KINDS.has(n.kind)) {
        if (!isNum(m.contextChars)) p(`${tree} ${n.id}: step node missing meta.contextChars`);
        if (!isNum(m.contextTokensEst)) p(`${tree} ${n.id}: step node missing meta.contextTokensEst`);
        if (!isStr(m.threadId) || !isNum(m.turnIndex) || !isNum(m.stepIndex)) p(`${tree} ${n.id}: step node missing threadId/turnIndex/stepIndex`);
        if (!isStr(m.fullText)) p(`${tree} ${n.id}: step node missing meta.fullText`);
        if (n.kind === 'tool-call' && (!isStr(m.toolName) || !isNum(m.promptChars))) p(`${tree} ${n.id}: tool-call needs toolName + promptChars`);
        if (n.kind === 'user-message' && !isNum(m.promptChars)) p(`${tree} ${n.id}: user-message needs promptChars`);
      }
      if (n.kind === 'worker-thread' && !isNum(m.promptChars)) p(`${tree} ${n.id}: worker-thread needs promptChars (dispatch prompt length)`);
      if (n.kind === 'thread' || n.kind === 'worker-thread') { if (tree === 'hierarchy' && isStr(m.threadId)) seenThreads.add(m.threadId); }
      if (n.kind === 'turn' && !isNum(m.promptChars)) p(`${tree} ${n.id}: turn needs promptChars (user prompt length)`);
      if (JSON.stringify(m).includes('"providerOptions"')) p(`${tree} ${n.id}: providerOptions leaked into meta`);
    }
    if (n.children) {
      if (!Array.isArray(n.children)) p(`${tree} ${n.id}: children must be an array`);
      else {
        n.children.forEach((c, i) => walk(c, `${path}/${i}`, tree));
        const sum = n.children.reduce((s, c) => s + (isNum(c.value) ? c.value : 0), 0);
        if (n.children.length && isNum(n.value) && n.value !== sum) p(`${tree} ${n.id}: container value ${n.value} != sum of children ${sum}`);
      }
    }
  };
  if (!ds.hierarchy) p('hierarchy missing'); else { walk(ds.hierarchy, 'root', 'hierarchy'); if (ds.hierarchy.kind !== 'project') p('hierarchy root must be kind project'); }
  if (!ds.delegation) p('delegation missing'); else walk(ds.delegation, 'root', 'delegation');

  for (const tid of ds.source?.threadIds ?? []) if (!seenThreads.has(tid)) p(`thread ${tid} listed in source.threadIds but absent from hierarchy`);
  for (const tid of seenThreads) if (!(ds.source?.threadIds ?? []).includes(tid)) p(`thread ${tid} in hierarchy but missing from source.threadIds`);

  // --- stats ---
  if (!ds.stats) p('stats missing');
  else {
    for (const t of ds.stats.turns ?? []) {
      for (const k of ['threadId', 'agent', 'startedAt'] as const) if (!isStr(t[k])) p(`stats.turns ${t.threadId}/${t.turnIndex}: ${k} missing`);
      for (const k of ['turnIndex', 'steps', 'toolCalls', 'chars', 'tokensEst', 'contextCharsAtEnd', 'userPromptChars'] as const) if (!isNum(t[k])) p(`stats.turns ${t.threadId}/${t.turnIndex}: ${k} missing`);
      if (!ids.has(`${t.threadId}/turn-${t.turnIndex}`)) p(`stats.turns references unknown turn ${t.threadId}/turn-${t.turnIndex}`);
    }
    for (const a of ds.stats.agents ?? []) {
      if (!isStr(a.agent) || !AGENT_RE.test(a.agent)) p(`stats.agents: invalid agent ${String(a.agent)}`);
      for (const k of ['threads', 'turns', 'toolCalls', 'chars', 'tokensEst'] as const) if (!isNum(a[k])) p(`stats.agents ${a.agent}: ${k} missing`);
    }
    for (const t of ds.stats.tools ?? []) {
      if (!isStr(t.toolName)) p('stats.tools: toolName missing');
      for (const k of ['calls', 'promptChars', 'resultChars', 'errors'] as const) if (!isNum(t[k])) p(`stats.tools ${t.toolName}: ${k} missing`);
    }
  }

  // --- flows ---
  if (!ds.flows) p('flows missing');
  else {
    const fids = new Set<string>();
    for (const n of ds.flows.nodes ?? []) {
      if (!isStr(n.id) || !n.id.startsWith('stage:')) p(`flows.nodes: id must start with "stage:" (${String(n.id)})`);
      if (fids.has(n.id)) p(`flows.nodes: duplicate id ${n.id}`); fids.add(n.id);
      if (!isStr(n.stage) || n.id !== `stage:${n.stage}`) p(`flows.nodes ${n.id}: id/stage mismatch`);
      if (!NODE_KINDS.has(n.kind)) p(`flows.nodes ${n.id}: invalid kind`);
      if (!isNum(n.count)) p(`flows.nodes ${n.id}: count missing`);
    }
    for (const l of ds.flows.links ?? []) {
      if (!fids.has(l.source)) p(`flows.links: source ${l.source} not in flows.nodes`);
      if (!fids.has(l.target)) p(`flows.links: target ${l.target} not in flows.nodes`);
      if (!isNum(l.value) || l.value <= 0) p(`flows.links ${l.source}→${l.target}: value must be > 0`);
      if (!LINK_KINDS.has(l.kind)) p(`flows.links ${l.source}→${l.target}: invalid kind ${String(l.kind)}`);
    }
  }

  // --- loopModel ---
  if (!ds.loopModel || !Array.isArray(ds.loopModel.loops)) p('loopModel.loops missing');
  else {
    const expected = ['turn', 'delegation', 'skill', 'memory', 'human'];
    const got = ds.loopModel.loops.map((l) => l.id);
    for (const e of expected) if (!got.includes(e)) p(`loopModel missing loop ${e}`);
    for (const l of ds.loopModel.loops) {
      const pids = new Set(l.phases.map((ph) => ph.id));
      if (pids.size !== l.phases.length) p(`loopModel ${l.id}: duplicate phase ids`);
      for (const ph of l.phases) for (const k of ph.observedKinds) if (!NODE_KINDS.has(k)) p(`loopModel ${l.id}/${ph.id}: invalid observedKind ${k}`);
      for (const e of l.edges) {
        if (!pids.has(e.from)) p(`loopModel ${l.id}: edge from unknown phase ${e.from}`);
        if (!pids.has(e.to)) p(`loopModel ${l.id}: edge to unknown phase ${e.to}`);
        if (!EDGE_KINDS.has(e.kind)) p(`loopModel ${l.id}: invalid edge kind ${String(e.kind)}`);
      }
    }
  }

  return problems;
}

// ---- CLI ----
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..', 'data', 'loops.json');
  const ds = JSON.parse(readFileSync(file, 'utf8')) as LoopsDataset;
  const problems = validateDataset(ds);
  const countNodes = (n: LoopNode): number => 1 + (n.children ?? []).reduce((s, c) => s + countNodes(c), 0);
  const summary = {
    file, valid: problems.length === 0, problems: problems.length,
    threads: ds.source.threadIds.length, messages: ds.source.messageCount,
    hierarchyNodes: countNodes(ds.hierarchy), delegationNodes: countNodes(ds.delegation),
    turns: ds.stats.turns.length, agents: ds.stats.agents.map((a) => a.agent), tools: ds.stats.tools.length,
    flowNodes: ds.flows.nodes.length, flowLinks: ds.flows.links.length, loops: ds.loopModel.loops.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (problems.length) { console.error(problems.map((x) => ' - ' + x).join('\n')); process.exit(1); }
}
