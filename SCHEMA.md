# agents-visualized — shared data contract

Two workers build against this file. Pipeline writes `data/loops.json`; app reads it. Do not change field names without updating this file.

## Where Obvious stores turn/context data (verified 2026-09-03)

- `~/.obvious/` exists on the project sandbox but is EMPTY. Obvious does not persist turn data to disk (unlike `.claude` / `.codex`).
- Turn data lives server-side and is read via the SDK:
  - `obvious threads list` → threads in this project (id, name, type, parentThreadId, agentStatus)
  - `obvious threads listMessages --threadId=th_... --limit=100 --offset=N` → messages. Each message: `{ id, threadId, role: 'user'|'assistant'|..., type, content: Part[], createdAt, updatedAt }`
  - `Part` types observed: `text` `{type:'text', text}`, `reasoning` `{type:'reasoning', text}`, `tool-call` `{type:'tool-call', toolName, toolCallId, input, summary, silent}`, `tool-result` (shape: inspect it — may include toolCallId, output/result, isError). There may be others; handle unknown types generically.
  - `obvious tasks list` / `tasks get --taskId=` → delegation tree (id, parentId, status, assignee, title, createdAt/updatedAt, completionNote).
  - `obvious memory list --category=...` → extracted facts (the memory loop).
- Environment: `PROJECT_ID`, `API_TOKEN` (5-min TTL — re-read `process.env.API_TOKEN` per call), `require('obvious')` gives `{ sdk }` with `sdk.threads.list({})`, `sdk.threads.listMessages({threadId, limit, offset})`, `sdk.tasks.list({})`, etc. Run `obvious help threads.listMessages` for exact params.
- Strip `providerOptions` (contains signatures). Keep FULL text for hover tooltips (`meta.fullText`), capped at 6000 chars per node with `meta.truncated: true` when cut; `meta.excerpt` is the first 400 chars.
- Worker dispatch prompts: `obvious tasks get --taskId=` may expose the start prompt / description; if the prompt isn't exposed, use the worker thread's first message text as the prompt and say so in `source.storage`.

## Output file: `/home/user/work/agents-visualized/data/loops.json`

```ts
export type NodeKind =
  | 'project' | 'thread' | 'turn'          // structure
  | 'user-message' | 'reasoning' | 'text' | 'tool-call' | 'tool-result'  // observed steps
  | 'task' | 'worker-thread' | 'wake'      // delegation loop
  | 'phase';                                // documented (not observed) loop phases

export interface LoopNode {
  id: string;            // globally unique, stable (e.g. "th_SMvQXb8b/turn-3/step-7")
  name: string;          // short human label
  kind: NodeKind;
  value: number;         // weight: chars of text for text/reasoning; 1 for tool calls; sum for containers
  meta?: {
    role?: string; toolName?: string; toolCallId?: string; summary?: string;
    createdAt?: string; durationMs?: number; status?: string; assignee?: string;
    isError?: boolean;
    // --- sizes (REQUIRED on every step node; containers carry sums) ---
    chars: number;                 // raw characters of this node's text / JSON payload
    tokensEst: number;             // Math.ceil(chars / 4) — label as estimate in UI
    contextChars?: number;         // cumulative chars of everything earlier in the same thread (context size at this point)
    contextTokensEst?: number;
    promptChars?: number;          // tool-call: JSON.stringify(input).length; worker-thread/task: dispatch prompt length; user-message: message length
    // --- identity ---
    agent: string;                 // 'user' | 'orchestrator' | 'worker:<assignee>' (e.g. 'worker:agent')
    threadId?: string; turnIndex?: number; stepIndex?: number; messageId?: string;
    // --- hover content ---
    excerpt?: string;              // first 400 chars
    fullText?: string;             // full text for hover tooltip, ≤ 6000 chars
    truncated?: boolean;
    [k: string]: unknown;
  };
  children?: LoopNode[];
}

export type Stage =
  | 'user' | 'reason' | 'tool:<toolName>' | 'observe' | 'delegate' | 'worker' | 'wake' | 'respond';

export interface FlowNode { id: string; name: string; stage: Stage; kind: NodeKind; count: number }
export interface FlowLink { source: string; target: string; value: number; kind: 'sequence' | 'delegation' | 'wake' | 'tool' }

export interface LoopsDataset {
  version: 1;
  generatedAt: string;                 // ISO
  source: {
    projectId: string;
    threadIds: string[];
    messageCount: number;
    storage: string;                   // one-paragraph honest description of where the data came from (see above)
  };
  /** Observed: project → threads → turns → steps. A "turn" = one user message + everything the assistant did until the next user message. Worker threads (parentThreadId set, or created by a task) appear as `worker-thread` nodes nested under the orchestrator turn that dispatched them when that can be determined, otherwise as siblings under the project. */
  hierarchy: LoopNode;
  /** Observed: per-turn and per-agent totals for summary panels. */
  stats: {
    turns: Array<{ threadId: string; turnIndex: number; agent: string; startedAt: string; endedAt?: string; steps: number; toolCalls: number; chars: number; tokensEst: number; contextCharsAtEnd: number; userPromptChars: number }>;
    agents: Array<{ agent: string; threads: number; turns: number; toolCalls: number; chars: number; tokensEst: number }>;
    tools: Array<{ toolName: string; calls: number; promptChars: number; resultChars: number; errors: number }>;
  };
  /** Observed: aggregated step-type transitions for a Sankey. Node ids like "stage:reason", "stage:tool:execute-command". */
  flows: { nodes: FlowNode[]; links: FlowLink[] };
  /** Observed: delegation tree — root task → subtasks → worker threads, with status. */
  delegation: LoopNode;
  /** Documented (from Obvious's operating instructions, NOT observed) — the canonical loops. Rendered separately and labelled "documented model". */
  loopModel: {
    loops: Array<{
      id: string; name: string; description: string;
      phases: Array<{ id: string; name: string; description: string; observedKinds: NodeKind[] }>;
      edges: Array<{ from: string; to: string; label?: string; kind: 'next' | 'repeat' | 'exit' }>;
    }>;
  };
}
```

## The documented loop model (encode verbatim into `loopModel`; source: Obvious operating instructions)

1. **Turn loop** (`turn`): `receive` (user message) → `orient` (search/list existing artifacts, read context) → `plan` (create/update tasks in the task tree) → `act` (tool calls) → `observe` (tool results; repeat act↔observe) → `respond` (single closing message; earlier text folds into an activity log). Exit: closing message. Repeat edge: observe→act.
2. **Delegation loop** (`delegation`): `decompose` (split into self-contained deliverables) → `dispatch` (tasks create + tasks start, worker runs its own Turn loop in its own thread) → `sleep` (orchestrator ends turn; never polls) → `wake` (completion / needs_input / failure notice) → `review` (read result vs acceptance criteria) → `steer` (send back for rework; repeat) or `close` (tasks update --status=completed) → `synthesize` (present in own words). Repeat edge: review→steer→wake.
3. **Skill loop** (`skill`): `match` (task domain has a skill) → `load` (skills load) → `follow` (skill instructions injected every turn) → `unload`.
4. **Memory loop** (`memory`): `extract` (after each turn: facts + summaries auto-extracted) → `store` → `inject` (Active Memory in next turn's context) → `use`. Repeat edge: use→extract.
5. **Human-in-the-loop** (`human`): `gate` (propose-plan / ask-user / confirmation-gated 🔒 action) → `notify` → `decide` (approve / edit / reject) → `wake` → `continue`.

Mark all of the above as `documented`; the Sankey/hierarchy from `hierarchy`/`flows`/`delegation` is `observed`.
