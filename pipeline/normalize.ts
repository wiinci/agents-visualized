// Normalizes raw SDK records (threads, messages, tasks, memory facts) into the LoopsDataset contract.
import type {
  AgentStat, FlowLink, FlowNode, LoopNode, LoopNodeMeta, LoopsDataset, NodeKind, RawMemoryFact, RawMessage, RawPart,
  RawTask, RawThread, Stage, ToolStat, TurnStat,
} from './types.js';
import { loopModel } from './loopModel.js';

export const FULL_TEXT_CAP = 6000;
export const EXCERPT_LEN = 400;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const tokensEst = (chars: number): number => Math.ceil(chars / 4);

/** Deep-strip `providerOptions` (contains model signatures) from any JSON value. */
export function stripProviderOptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripProviderOptions) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'providerOptions') continue;
      out[k] = stripProviderOptions(v);
    }
    return out as T;
  }
  return value;
}

function hover(text: string): Pick<LoopNodeMeta, 'excerpt' | 'fullText' | 'truncated'> {
  const truncated = text.length > FULL_TEXT_CAP;
  return {
    excerpt: text.slice(0, EXCERPT_LEN),
    fullText: truncated ? text.slice(0, FULL_TEXT_CAP) : text,
    truncated,
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? ''; } catch { return String(v); }
}
function prettyJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? ''; } catch { return String(v); }
}

function partsOf(msg: RawMessage): RawPart[] {
  const c = msg.content;
  if (Array.isArray(c)) return c as RawPart[];
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (c && typeof c === 'object') return [c as RawPart];
  return [];
}

/** Concatenated text of all text-ish parts in a message. */
function messageText(msg: RawMessage): string {
  return partsOf(msg)
    .map((p) => (typeof p.text === 'string' ? p.text : typeof p.content === 'string' ? p.content : ''))
    .filter(Boolean)
    .join('\n');
}

/** Collect every value under a given key anywhere in a JSON tree. */
function deepCollect(value: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((v) => deepCollect(v, key, out)); return out; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key && typeof v === 'string') out.push(v);
      deepCollect(v, key, out);
    }
  }
  return out;
}

const THREAD_ID_RE = /\bth_[A-Za-z0-9]+\b/g;
const TASK_ID_RE = /\btodo_[A-Za-z0-9]+\b/g;

/**
 * A user-role message that is not from the human: completion / needs_input / failure notice, thread message,
 * or any user-role message whose `type` is not plain text. Heuristic — recorded in meta.wakeDetection.
 */
function detectWake(msg: RawMessage, text: string): string | null {
  if (msg.role !== 'user') return null;
  if (msg.type && msg.type !== 'text') return `role=user,type=${msg.type}`;
  if (/<thread-message\b|<task-(?:completion|update|notice|result)\b|<completion-notice\b|<wake\b/i.test(text)) return 'tagged-notice';
  if (/^\s*\[?(?:task|worker|subtask|delegate)\b[^\n]{0,160}\b(?:completed|failed|needs[_ ]input|succeeded|reported|finished)\b/i.test(text)) return 'status-notice';
  return null;
}

// ---------------------------------------------------------------------------
// per-thread normalization
// ---------------------------------------------------------------------------

export interface ThreadInput { thread: RawThread; messages: RawMessage[] }

interface StepInfo {
  node: LoopNode;
  stage: Stage;
  delegateThreadIds: string[]; // set on tool-result steps that carry dispatch results
  wakeThreadIds: string[];     // set on wake steps that reference worker threads
  wakeTaskIds: string[];
}

interface TurnBuild {
  node: LoopNode;
  steps: StepInfo[];
  startedAt: string;
  endedAt?: string;
  userPromptChars: number;
  contextCharsAtEnd: number;
  dispatchedThreadIds: string[];
}

interface ThreadBuild {
  thread: RawThread;
  node: LoopNode;
  agent: string;
  turns: TurnBuild[];
  messageCount: number;
  partTypes: Record<string, number>;
  firstUserText: string | null;
}

function agentForThread(t: RawThread, tasks: RawTask[]): string {
  const bound = tasks.find((task) => (task.assignees ?? []).some((a) => a.agentId === t.id));
  const isWorker = !!t.parentThreadId || (bound && bound.parentId !== null);
  if (!isWorker) return 'orchestrator';
  const assignee = (bound?.assignees ?? []).find((a) => a.agentId === t.id)?.type ?? 'agent';
  return `worker:${assignee}`;
}

function buildThread(input: ThreadInput, agent: string): ThreadBuild {
  const { thread, messages } = input;
  const ordered = messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.createdAt < b.m.createdAt ? -1 : a.m.createdAt > b.m.createdAt ? 1 : a.i - b.i))
    .map((x) => x.m);

  const partTypes: Record<string, number> = {};
  const turns: TurnBuild[] = [];
  let contextChars = 0; // cumulative chars of everything earlier in this thread
  let current: TurnBuild | null = null;
  let firstUserText: string | null = null;
  // toolCallId -> createdAt of the call, for durationMs on results
  const callTimes = new Map<string, string>();

  const openTurn = (startedAt: string, turnIndex: number): TurnBuild => {
    const node: LoopNode = {
      id: `${thread.id}/turn-${turnIndex}`,
      name: `turn ${turnIndex + 1}`,
      kind: 'turn',
      value: 0,
      meta: { chars: 0, tokensEst: 0, agent, threadId: thread.id, turnIndex, createdAt: startedAt },
      children: [],
    };
    const t: TurnBuild = { node, steps: [], startedAt, userPromptChars: 0, contextCharsAtEnd: contextChars, dispatchedThreadIds: [] };
    turns.push(t);
    return t;
  };

  for (const msg of ordered) {
    const parts = partsOf(msg);
    const text = messageText(msg);
    const wakeReason = detectWake(msg, text);
    const startsTurn = msg.role === 'user' && !wakeReason;

    if (startsTurn || current === null) current = openTurn(msg.createdAt, turns.length);
    const turn = current;
    const turnIndex = turns.length - 1;

    if (msg.role === 'user' && !wakeReason && firstUserText === null) firstUserText = text;

    // A wake notice is one step for the whole message (system-authored user-role message).
    if (wakeReason) {
      partTypes['wake-notice'] = (partTypes['wake-notice'] ?? 0) + 1;
      const chars = text.length || safeJson(stripProviderOptions(msg.content)).length;
      const stepIndex = turn.steps.length;
      const referenced = [...new Set(text.match(THREAD_ID_RE) ?? [])].filter((id) => id !== thread.id);
      const referencedTasks = [...new Set(text.match(TASK_ID_RE) ?? [])];
      const node: LoopNode = {
        id: `${thread.id}/turn-${turnIndex}/step-${stepIndex}`,
        name: 'wake',
        kind: 'wake',
        value: chars,
        meta: {
          role: msg.role, createdAt: msg.createdAt, chars, tokensEst: tokensEst(chars),
          contextChars, contextTokensEst: tokensEst(contextChars),
          agent, threadId: thread.id, turnIndex, stepIndex, messageId: msg.id,
          partType: msg.type ?? 'text', wakeDetection: wakeReason,
          referencedThreadIds: referenced, referencedTaskIds: referencedTasks,
          ...hover(text || prettyJson(stripProviderOptions(msg.content))),
        },
      };
      turn.steps.push({ node, stage: 'wake', delegateThreadIds: [], wakeThreadIds: referenced, wakeTaskIds: referencedTasks });
      contextChars += chars;
      turn.endedAt = msg.createdAt;
      continue;
    }

    for (const rawPart of parts) {
      const part = stripProviderOptions(rawPart);
      const ptype = typeof part.type === 'string' ? part.type : typeof part;
      partTypes[ptype] = (partTypes[ptype] ?? 0) + 1;
      const stepIndex = turn.steps.length;
      const id = `${thread.id}/turn-${turnIndex}/step-${stepIndex}`;
      const base: LoopNodeMeta = {
        role: msg.role, createdAt: msg.createdAt, chars: 0, tokensEst: 0,
        contextChars, contextTokensEst: tokensEst(contextChars),
        agent: msg.role === 'user' ? 'user' : agent,
        threadId: thread.id, turnIndex, stepIndex, messageId: msg.id, partType: ptype,
      };

      let node: LoopNode;
      let stage: Stage;
      let delegateThreadIds: string[] = [];

      if (msg.role === 'user' && (ptype === 'text' || typeof part.text === 'string')) {
        const t = String(part.text ?? '');
        const chars = t.length;
        turn.userPromptChars += chars;
        node = { id, name: 'user message', kind: 'user-message', value: chars, meta: { ...base, chars, tokensEst: tokensEst(chars), promptChars: chars, ...hover(t) } };
        stage = 'user';
      } else if (ptype === 'reasoning') {
        const t = String(part.text ?? '');
        const chars = t.length;
        node = { id, name: 'reasoning', kind: 'reasoning', value: chars, meta: { ...base, chars, tokensEst: tokensEst(chars), ...hover(t) } };
        stage = 'reason';
      } else if (ptype === 'text') {
        const t = String(part.text ?? '');
        const chars = t.length;
        node = { id, name: msg.role === 'assistant' ? 'assistant text' : `${msg.role} text`, kind: 'text', value: chars, meta: { ...base, chars, tokensEst: tokensEst(chars), ...hover(t) } };
        stage = 'respond';
      } else if (ptype === 'tool-call') {
        const toolName = String(part.toolName ?? 'unknown');
        const inputJson = safeJson(part.input ?? null);
        const chars = inputJson.length;
        const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
        if (toolCallId) callTimes.set(toolCallId, msg.createdAt);
        const cmd = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>).command : undefined;
        // Dispatch = an `obvious tasks start` SDK call. Confirmed later if its result carries delegateThreadId.
        const isDispatchCall = toolName === 'obvious-sdk' && typeof cmd === 'string' && /^\s*(?:obvious\s+)?tasks\s+start\b/.test(cmd);
        node = {
          id, name: `tool: ${toolName}`, kind: 'tool-call', value: 1,
          meta: {
            ...base, toolName, toolCallId, summary: typeof part.summary === 'string' ? part.summary : undefined,
            silent: part.silent, chars, tokensEst: tokensEst(chars), promptChars: chars,
            isDispatch: isDispatchCall || undefined,
            ...hover(prettyJson(part.input ?? null)),
          },
        };
        stage = isDispatchCall ? 'delegate' : (`tool:${toolName}` as Stage);
      } else if (ptype === 'tool-result') {
        const toolName = String(part.toolName ?? 'unknown');
        const output = part.output ?? part.result ?? null;
        const outJson = safeJson(output);
        const chars = outJson.length;
        const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
        const outType = output && typeof output === 'object' ? (output as Record<string, unknown>).type : undefined;
        const value = output && typeof output === 'object' ? (output as Record<string, unknown>).value : undefined;
        const isError = Boolean(
          part.isError === true ||
          (typeof outType === 'string' && /error/i.test(outType)) ||
          (value && typeof value === 'object' && (value as Record<string, unknown>).success === false),
        );
        delegateThreadIds = [...new Set(deepCollect(output, 'delegateThreadId'))];
        const started = toolCallId ? callTimes.get(toolCallId) : undefined;
        const durationMs = started ? Math.max(0, Date.parse(msg.createdAt) - Date.parse(started)) : undefined;
        node = {
          id, name: `result: ${toolName}`, kind: 'tool-result', value: chars,
          meta: {
            ...base, toolName, toolCallId, isError, durationMs, chars, tokensEst: tokensEst(chars),
            outputType: outType, delegateThreadIds: delegateThreadIds.length ? delegateThreadIds : undefined,
            ...hover(prettyJson(output)),
          },
        };
        stage = 'observe';
      } else {
        // Unknown part type — keep it generically rather than dropping it.
        const json = safeJson(part);
        const chars = json.length;
        node = { id, name: `${ptype}`, kind: 'text', value: chars, meta: { ...base, chars, tokensEst: tokensEst(chars), unknownPartType: true, ...hover(prettyJson(part)) } };
        stage = msg.role === 'user' ? 'user' : 'respond';
      }

      turn.steps.push({ node, stage, delegateThreadIds, wakeThreadIds: [], wakeTaskIds: [] });
      turn.dispatchedThreadIds.push(...delegateThreadIds);
      contextChars += node.meta!.chars;
    }
    turn.endedAt = msg.createdAt;
  }

  // finalize turns
  for (const t of turns) {
    // promote any tool-call whose result carries delegateThreadId to a dispatch (result-confirmed, tool-agnostic)
    for (const s of t.steps) {
      if (s.node.kind !== 'tool-result' || s.delegateThreadIds.length === 0) continue;
      const call = t.steps.find((x) => x.node.kind === 'tool-call' && x.node.meta?.toolCallId === s.node.meta?.toolCallId);
      if (call) { call.stage = 'delegate'; call.node.meta!.isDispatch = true; call.node.meta!.delegateThreadIds = s.delegateThreadIds; }
    }
    // the last assistant text of a turn is the closing message; earlier text is activity-log narration
    const lastText = [...t.steps].reverse().find((x) => x.node.kind === 'text' && x.node.meta?.role === 'assistant');
    for (const s of t.steps) if (s.node.kind === 'text' && s.node.meta?.role === 'assistant') s.node.meta!.closing = s === lastText;
    const own = t.steps.reduce((s, x) => s + x.node.meta!.chars, 0);
    const toolCalls = t.steps.filter((x) => x.node.kind === 'tool-call').length;
    t.node.children = t.steps.map((s) => s.node);
    t.node.value = t.steps.reduce((s, x) => s + x.node.value, 0);
    const last = t.steps[t.steps.length - 1];
    t.contextCharsAtEnd = last ? last.node.meta!.contextChars! + last.node.meta!.chars : t.contextCharsAtEnd;
    const first = t.steps[0]?.node.meta?.excerpt;
    t.node.name = first ? `turn ${t.node.meta!.turnIndex! + 1}: ${first.slice(0, 60).replace(/\s+/g, ' ')}` : t.node.name;
    Object.assign(t.node.meta!, {
      chars: own, tokensEst: tokensEst(own), promptChars: t.userPromptChars,
      contextChars: t.node.meta!.contextChars ?? 0, // context at turn start
      contextCharsAtEnd: t.contextCharsAtEnd, contextTokensEstAtEnd: tokensEst(t.contextCharsAtEnd),
      steps: t.steps.length, toolCalls, endedAt: t.endedAt,
      durationMs: t.endedAt ? Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt)) : undefined,
      dispatchedThreadIds: t.dispatchedThreadIds.length ? [...new Set(t.dispatchedThreadIds)] : undefined,
    });
    t.node.meta!.contextChars = t.steps[0]?.node.meta?.contextChars ?? 0;
    t.node.meta!.contextTokensEst = tokensEst(t.node.meta!.contextChars!);
  }

  const totalChars = turns.reduce((s, t) => s + t.node.meta!.chars, 0);
  const node: LoopNode = {
    id: thread.id,
    name: thread.name ?? thread.id,
    kind: agent === 'orchestrator' ? 'thread' : 'worker-thread',
    value: turns.reduce((s, t) => s + t.node.value, 0),
    meta: {
      chars: totalChars, tokensEst: tokensEst(totalChars), agent, threadId: thread.id,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, status: thread.agentStatus ?? undefined,
      threadType: thread.type, threadSource: thread.source, parentThreadId: thread.parentThreadId,
      messageCount: ordered.length, turns: turns.length,
      toolCalls: turns.reduce((s, t) => s + (t.node.meta!.toolCalls as number), 0),
      contextCharsAtEnd: contextChars, contextTokensEstAtEnd: tokensEst(contextChars),
      partTypes,
    },
    children: turns.map((t) => t.node),
  };

  return { thread, node, agent, turns, messageCount: ordered.length, partTypes, firstUserText };
}

// ---------------------------------------------------------------------------
// dataset assembly
// ---------------------------------------------------------------------------

export interface NormalizeInput {
  projectId: string;
  projectName?: string;
  threads: ThreadInput[];
  tasks: RawTask[];
  memory: RawMemoryFact[];
  generatedAt?: string;
}

export interface NormalizeReport {
  threads: number; messages: number; turns: number; toolCalls: number; steps: number;
  partTypes: Record<string, number>;
  dispatchPromptSources: Record<string, string>;
  orphanWorkerThreads: string[];
}

export function normalize(input: NormalizeInput): { dataset: LoopsDataset; report: NormalizeReport } {
  const { projectId, tasks, memory } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  const builds = input.threads.map((t) => buildThread(t, agentForThread(t.thread, tasks)));
  const byId = new Map(builds.map((b) => [b.thread.id, b]));

  // --- dispatch prompts & attachment of worker threads to the dispatching turn ---
  // Source of truth for prompt text: the worker thread's first user-role message. Cross-reference: the
  // orchestrator's `tasks start` tool-call whose result carries delegateThreadId=<worker>.
  const dispatchedIn = new Map<string, { turn: TurnBuild; orchestrator: ThreadBuild; toolCallId?: string }>();
  for (const b of builds) {
    for (const turn of b.turns) {
      for (const step of turn.steps) {
        for (const tid of step.delegateThreadIds) {
          if (!dispatchedIn.has(tid)) dispatchedIn.set(tid, { turn, orchestrator: b, toolCallId: step.node.meta?.toolCallId as string | undefined });
        }
      }
    }
  }

  const dispatchPromptSources: Record<string, string> = {};
  const taskByThread = new Map<string, RawTask>();
  for (const task of tasks) for (const a of task.assignees ?? []) if (a.agentId && byId.has(a.agentId)) taskByThread.set(a.agentId, task);

  for (const b of builds) {
    if (b.agent === 'orchestrator') continue;
    const task = taskByThread.get(b.thread.id);
    const dispatch = dispatchedIn.get(b.thread.id);
    const src = b.firstUserText !== null
      ? (dispatch ? 'worker-thread-first-message (cross-referenced with orchestrator tasks start tool-call)' : 'worker-thread-first-message')
      : (task?.description ? 'task-description (no worker message yet)' : 'unavailable');
    dispatchPromptSources[b.thread.id] = src;
    const promptText = b.firstUserText ?? task?.description ?? '';
    Object.assign(b.node.meta!, {
      promptChars: promptText.length,
      promptTokensEst: tokensEst(promptText.length),
      dispatchPromptSource: src,
      dispatchPrompt: hover(promptText).fullText,
      dispatchPromptTruncated: promptText.length > FULL_TEXT_CAP,
      taskId: task?.id, taskStatus: task?.status, taskTitle: task?.title,
      assignee: b.agent.replace(/^worker:/, ''),
      dispatchedByThreadId: dispatch?.orchestrator.thread.id ?? b.thread.parentThreadId ?? undefined,
      dispatchedInTurn: dispatch ? dispatch.turn.node.meta!.turnIndex : undefined,
      dispatchToolCallId: dispatch?.toolCallId,
    });
  }

  // --- hierarchy: project → root threads → turns → steps (+ nested worker threads) ---
  const attached = new Set<string>();
  const orphanWorkerThreads: string[] = [];
  for (const b of builds) {
    if (b.agent === 'orchestrator') continue;
    const d = dispatchedIn.get(b.thread.id);
    if (d) { d.turn.node.children!.push(b.node); attached.add(b.thread.id); }
  }
  // nested worker threads contribute to container `value` (sum of children) but not to meta.chars (own text)
  const resum = (n: LoopNode): number => {
    if (!n.children || n.children.length === 0) return n.value;
    n.value = n.children.reduce((s, c) => s + resum(c), 0);
    if (n.meta) n.meta.subtreeValue = n.value;
    return n.value;
  };

  const rootChildren: LoopNode[] = [];
  for (const b of builds) {
    if (b.agent === 'orchestrator') rootChildren.push(b.node);
    else if (!attached.has(b.thread.id)) {
      // fallback: parentThreadId known but no dispatch call found in that parent → sibling under project
      orphanWorkerThreads.push(b.thread.id);
      b.node.meta!.attachment = 'sibling-under-project (dispatching turn not identified)';
      rootChildren.push(b.node);
    }
  }
  rootChildren.sort((a, c) => String(a.meta?.createdAt ?? '').localeCompare(String(c.meta?.createdAt ?? '')));

  const messageCount = builds.reduce((s, b) => s + b.messageCount, 0);
  const projectChars = builds.reduce((s, b) => s + b.node.meta!.chars, 0);
  const memoryCategories: Record<string, number> = {};
  for (const f of memory) memoryCategories[f.category] = (memoryCategories[f.category] ?? 0) + 1;

  const hierarchy: LoopNode = {
    id: projectId,
    name: input.projectName ?? projectId,
    kind: 'project',
    value: 0,
    meta: {
      chars: projectChars, tokensEst: tokensEst(projectChars), agent: 'orchestrator',
      threads: builds.length, messages: messageCount,
      turns: builds.reduce((s, b) => s + b.turns.length, 0),
      memory: {
        count: memory.length,
        categories: memoryCategories,
        facts: memory.map((f) => ({ id: f.id, category: f.category, entityKey: f.entityKey ?? null, source: f.source ?? null, chars: f.content.length, tokensEst: tokensEst(f.content.length), ...hover(f.content) })),
        note: 'Memory loop (observed facts from `obvious memory list`). Facts are extracted server-side after turns; not tied to a specific step.',
      },
    },
    children: rootChildren,
  };
  resum(hierarchy);

  // --- stats ---
  const turnStats: TurnStat[] = [];
  const agentAgg = new Map<string, AgentStat & { threadIds: Set<string> }>();
  const bump = (agent: string) => {
    let a = agentAgg.get(agent);
    if (!a) { a = { agent, threads: 0, turns: 0, toolCalls: 0, chars: 0, tokensEst: 0, threadIds: new Set() }; agentAgg.set(agent, a); }
    return a;
  };
  const toolAgg = new Map<string, ToolStat>();
  let totalSteps = 0; let totalToolCalls = 0;
  const partTypes: Record<string, number> = {};

  for (const b of builds) {
    for (const [k, v] of Object.entries(b.partTypes)) partTypes[k] = (partTypes[k] ?? 0) + v;
    bump(b.agent).threadIds.add(b.thread.id);
    for (const t of b.turns) {
      const m = t.node.meta!;
      turnStats.push({
        threadId: b.thread.id, turnIndex: m.turnIndex!, agent: b.agent, startedAt: t.startedAt, endedAt: t.endedAt,
        steps: t.steps.length, toolCalls: m.toolCalls as number, chars: m.chars, tokensEst: m.tokensEst,
        contextCharsAtEnd: t.contextCharsAtEnd, userPromptChars: t.userPromptChars,
      });
      const a = bump(b.agent); a.turns += 1;
      totalSteps += t.steps.length;
      for (const s of t.steps) {
        const sm = s.node.meta!;
        const ag = bump(sm.agent);
        ag.chars += sm.chars; ag.tokensEst += sm.tokensEst;
        if (s.node.kind === 'tool-call') {
          ag.toolCalls += 1; totalToolCalls += 1;
          const name = String(sm.toolName);
          const ts = toolAgg.get(name) ?? { toolName: name, calls: 0, promptChars: 0, resultChars: 0, errors: 0 };
          ts.calls += 1; ts.promptChars += sm.promptChars ?? 0; toolAgg.set(name, ts);
        } else if (s.node.kind === 'tool-result') {
          const name = String(sm.toolName);
          const ts = toolAgg.get(name) ?? { toolName: name, calls: 0, promptChars: 0, resultChars: 0, errors: 0 };
          ts.resultChars += sm.chars; if (sm.isError) ts.errors += 1; toolAgg.set(name, ts);
        }
      }
    }
  }
  const agents: AgentStat[] = [...agentAgg.values()].map(({ threadIds, ...a }) => ({ ...a, threads: threadIds.size }));
  const tools: ToolStat[] = [...toolAgg.values()].sort((a, b) => b.calls - a.calls);

  // --- flows (Sankey): consecutive step-stage transitions within each turn + delegation/wake edges ---
  const flowNodes = new Map<string, FlowNode>();
  const flowLinks = new Map<string, FlowLink>();
  const stageKind = (stage: Stage, kind: NodeKind): NodeKind => (stage === 'delegate' ? 'task' : stage === 'worker' ? 'worker-thread' : kind);
  const fnode = (stage: Stage, kind: NodeKind): string => {
    const id = `stage:${stage}`;
    const n = flowNodes.get(id) ?? { id, name: stage, stage, kind: stageKind(stage, kind), count: 0 };
    flowNodes.set(id, n);
    return id;
  };
  const link = (source: string, target: string, kind: FlowLink['kind'], v = 1) => {
    const key = `${source}→${target}|${kind}`;
    const l = flowLinks.get(key) ?? { source, target, value: 0, kind };
    l.value += v; flowLinks.set(key, l);
  };
  for (const b of builds) {
    for (const t of b.turns) {
      let prev: string | null = null;
      for (const s of t.steps) {
        const id = fnode(s.stage, s.node.kind);
        flowNodes.get(id)!.count += 1;
        if (prev && prev !== id) {
          const isTool = s.stage.startsWith('tool:') || prev.startsWith('stage:tool:');
          link(prev, id, isTool ? 'tool' : 'sequence');
        } else if (prev === id) {
          link(prev, id, 'sequence'); // self-transition (e.g. text→text) kept so counts stay honest; UI may drop cycles
        }
        prev = id;
        if (s.stage === 'delegate') {
          // delegate → worker for each worker thread this call dispatched (resolved from the following result)
          const idx = t.steps.indexOf(s);
          const result = t.steps.slice(idx + 1).find((x) => x.node.kind === 'tool-result' && x.node.meta?.toolCallId === s.node.meta?.toolCallId);
          const workers = result?.delegateThreadIds ?? [];
          if (workers.length) {
            const w = fnode('worker', 'worker-thread');
            flowNodes.get(w)!.count += workers.length;
            link(id, w, 'delegation', workers.length);
          }
        }
        if (s.stage === 'wake') {
          const w = fnode('worker', 'worker-thread');
          link(w, id, 'wake', Math.max(1, s.wakeThreadIds.length));
        }
      }
    }
  }

  // --- delegation tree: root task → subtasks → worker threads ---
  const taskNodes = new Map<string, LoopNode>();
  for (const task of tasks) {
    const workerThreads = (task.assignees ?? []).map((a) => a.agentId).filter((id): id is string => !!id && byId.has(id));
    const worker = workerThreads.map((id) => byId.get(id)!);
    const desc = task.description ?? '';
    const promptChars = worker[0]?.node.meta?.promptChars as number | undefined;
    const agent = worker[0]?.agent ?? ((task.assignees ?? [])[0]?.type ? `worker:${(task.assignees ?? [])[0]!.type}` : 'orchestrator');
    const text = [task.title, desc, task.completionNote ? `\n\nCompletion note:\n${task.completionNote}` : ''].filter(Boolean).join('\n\n');
    taskNodes.set(task.id, {
      id: task.id, name: task.title, kind: 'task', value: Math.max(1, desc.length),
      meta: {
        chars: text.length, tokensEst: tokensEst(text.length), agent, status: task.status, priority: task.priority,
        createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt,
        durationMs: task.completedAt ? Math.max(0, Date.parse(task.completedAt) - Date.parse(task.createdAt)) : undefined,
        assignee: (task.assignees ?? []).map((a) => a.displayName ?? a.type).join(', ') || undefined,
        promptChars, taskSource: task.source, parentId: task.parentId, workerThreadIds: workerThreads,
        completionNote: task.completionNote ?? undefined,
        ...hover(text),
      },
      children: [],
    });
  }
  for (const task of tasks) {
    const n = taskNodes.get(task.id)!;
    for (const tid of n.meta!.workerThreadIds as string[]) {
      const wb = byId.get(tid)!;
      if (wb.agent === 'orchestrator') continue; // the root task is assigned to the orchestrator thread itself
      n.children!.push({
        id: `${task.id}/${tid}`, name: wb.thread.name ?? tid, kind: 'worker-thread', value: wb.node.value,
        meta: { ...wb.node.meta!, hierarchyNodeId: wb.thread.id },
      });
    }
  }
  const delegationRoots: LoopNode[] = [];
  for (const task of tasks) {
    const n = taskNodes.get(task.id)!;
    if (task.parentId && taskNodes.has(task.parentId)) taskNodes.get(task.parentId)!.children!.push(n);
    else delegationRoots.push(n);
  }
  const delegation: LoopNode = {
    id: `${projectId}/delegation`, name: 'delegation', kind: 'project', value: 0,
    meta: { chars: 0, tokensEst: 0, agent: 'orchestrator', tasks: tasks.length, orchestratorThreadIds: builds.filter((b) => b.agent === 'orchestrator').map((b) => b.thread.id) },
    children: delegationRoots,
  };
  resum(delegation);

  const workerCount = builds.filter((b) => b.agent !== 'orchestrator').length;
  const storage =
    `Obvious keeps no on-disk turn store: ~/.obvious/ on the project sandbox exists but is empty (unlike Claude's .claude or Codex's .codex). ` +
    `All observed data here was read server-side through the Obvious SDK (\`require('obvious').sdk\`, project ${projectId}) at ${generatedAt}: ` +
    `threads.list (${builds.length} threads, paged 100 at a time), threads.listMessages per thread (${messageCount} messages; each message is {id, threadId, role, type, content: Part[], createdAt, updatedAt}; ` +
    `part types encountered: ${Object.entries(partTypes).map(([k, v]) => `${k}×${v}`).join(', ')}), tasks.list/tasks.get (${tasks.length} tasks; delegation tree via parentId and assignees[].agentId = worker thread id), ` +
    `and memory.list (${memory.length} facts, categories: ${Object.keys(memoryCategories).join(', ') || 'none'}; stored in hierarchy.meta.memory). ` +
    `providerOptions (model signatures) were stripped from every part. Worker dispatch prompts are NOT exposed by tasks.get (only title/description); ` +
    `they were recovered from each worker thread's first user-role message, which matches the --prompt argument of the orchestrator's \`tasks start\` tool-call ` +
    `(${workerCount} worker threads: ${Object.values(dispatchPromptSources).filter((s) => s.startsWith('worker-thread-first-message')).length} recovered from first message). ` +
    `Turns = one user-role message plus everything until the next; contextChars = cumulative chars of all earlier parts in the same thread; tokensEst = ceil(chars/4), an estimate. ` +
    `Wake nodes are user-role messages detected as system notices (heuristic, see meta.wakeDetection).`;

  const dataset: LoopsDataset = {
    version: 1,
    generatedAt,
    source: { projectId, threadIds: builds.map((b) => b.thread.id), messageCount, storage },
    hierarchy,
    stats: { turns: turnStats, agents, tools },
    flows: { nodes: [...flowNodes.values()], links: [...flowLinks.values()] },
    delegation,
    loopModel,
  };

  return {
    dataset,
    report: {
      threads: builds.length, messages: messageCount, turns: turnStats.length, toolCalls: totalToolCalls, steps: totalSteps,
      partTypes, dispatchPromptSources, orphanWorkerThreads,
    },
  };
}
