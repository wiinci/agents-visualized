---
name: agent-loops-report
description: Produce a validated, LLM-friendly report of Obvious agent activity (threads, turns, steps, tool calls, delegation, context growth, estimated tokens/cost) for any project, thread, or prompt — JSON dataset + Markdown digest, optionally a hosted D3 visualization. Runnable at any point in an execution loop.
version: 1.0.0
triggers:
  - agent activity report
  - agent loops report
  - loops report
  - what did the agents do
  - execution loop report
  - post-run report
  - session report
  - turn report
  - visualize agent activity
  - token cost report
---

# Agent Loops Report

Turn an Obvious project's server-side activity — thread messages, tasks, delegation, memory — into a validated dataset and a readable report. Built so an execution loop can run it as a stage, and so a human or an LLM can consume the result without re-querying anything.

## Outputs (stop at whichever the request needs)

1. **Dataset** — `loops.json`, a schema-validated `LoopsDataset` (contract below). This is the canonical, LLM-friendly report: every claim in any prose must trace to a node in it.
2. **Digest** — a Markdown report generated from the dataset: headline numbers, per-agent / per-turn / per-tool tables, delegation outline, loops observed, honesty notes. This is what you post to the thread.
3. **Visualization (optional)** — a hosted D3 app for humans, rendering the same JSON.

## Where it runs in an execution loop

- **Deliver / post-execution review**: run extraction after implementation work, when threads, tasks, and memory hold the full story. Run at the end of a loop, the dataset captures the very loop that produced it — self-referential and expected; say so in the report.
- **Phase boundaries**: extraction is read-only and idempotent; diff consecutive snapshots to report what *changed* since last run instead of restating everything.
- **Ad hoc**: works on any project, thread, or prompt ("what happened in project X / this thread / since 2pm").

## Ground rules (non-negotiable)

1. **Read only through the Obvious SDK** (`obvious` CLI or `require('obvious')`). There is no on-disk turn store — `~/.obvious` is empty by design. Do not hunt for one.
2. **Label estimates as estimates.** `tokensEst = Math.ceil(chars / 4)` on every step; never present as provider usage. Cost, if requested, is `tokensEst × rate` where rate is an explicitly-assumed, editable value (default stated, e.g. $3/M tokens) — always labelled illustrative, never factual.
3. **Separate observed from documented.** Retrieved records are `observed`; operating-loop models (e.g. the loop an agent is *designed* to follow) are `documented`. Never mix them in the same collection.
4. **Dispatch prompts.** Task records may not expose the full prompt sent to a worker. Recover it from the worker thread's first message and cross-check against the `tasks.start` input; record which source was used per task.
5. **Privacy.** Strip provider signatures; cap full text (e.g. 6,000 chars) with a `truncated` flag; keep excerpts shorter.

## Bootstrap script (verified v1)

Write this to disk and run it: `node agent-report.cjs --out=data [--thread=th_x] [--since=ISO] [--until=ISO] [--prev=data/loops.json]`. It emits `loops.json` (meta, source, per-step inventory with deterministic IDs, per-agent/per-tool/per-turn stats, raw threads/tasks/memory) and `digest.md` (headline, per-agent and per-tool tables; a Delta section when --prev is passed). Smoke-tested against a live project: 1,014 steps, all IDs unique, back-to-back runs diff as +0/−0. Refine agent identity with tasks/delegation data for full runs, and extend the digest with per-turn tables, a delegation outline, and loops observed.

```javascript
#!/usr/bin/env node
/* agent-loops-report bootstrap — SDK-only inventory for one Obvious project.
   Usage: node agent-report.cjs [--out=data] [--thread=th_x] [--since=ISO] [--until=ISO] [--prev=data/loops.json]
   Emits: loops.json (dataset skeleton: meta, source, per-step inventory, stats, raw threads/tasks/memory)
          digest.md   (headline + per-agent + per-tool tables; delta section when --prev given)
   Requires `obvious` resolvable (preinstalled on Obvious sandboxes; else NODE_PATH to its install dir). */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { sdk } = require('obvious')
sdk.configure?.({ tokenRefresh: async () => process.env.API_TOKEN })

const args = {}
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-zA-Z]+)(?:=(.*))?$/)
  if (m) args[m[1]] = m[2] ?? true
}
const PAGE = 100

async function pageAll(fetch) {
  const out = []; let offset = 0
  for (let guard = 0; guard < 10000; guard++) {
    const page = await fetch(offset)
    const items = page.items ?? []
    out.push(...items)
    const more = page.pagination?.hasMore ?? (items.length === PAGE)
    if (!more || items.length === 0) break
    offset += items.length
  }
  return out
}
const inRange = (ts) => {
  if (!ts) return true
  const t = Date.parse(ts)
  return (!args.since || t >= Date.parse(args.since)) && (!args.until || t <= Date.parse(args.until))
}
const textOf = (p) => (typeof p === 'string' ? p : (p?.text ?? p?.content ?? ''))

;(async () => {
  const threads = (await pageAll((o) => sdk.threads.list({ limit: PAGE, offset: o })))
    .filter((t) => !args.thread || t.id === args.thread)
  const steps = []
  const toolCallAt = new Map()
  let messageCount = 0
  for (const th of threads) {
    const msgs = (await pageAll((o) => sdk.threads.listMessages({ threadId: th.id, limit: PAGE, offset: o })))
      .filter((m) => inRange(m.createdAt))
    messageCount += msgs.length
    let turn = -1
    let turnStep = 0
    for (const m of msgs) {
      if (m.role === 'user') { turn++; turnStep = 0 }
      const parts = Array.isArray(m.content) ? m.content : [m.content ?? '']
      for (const part of parts) {
        const ptype = typeof part === 'object' && part !== null ? part.type : 'text'
        const text = textOf(part)
        const toolName = part?.toolName ?? null
        const toolCallId = part?.toolCallId ?? null
        let kind = 'text'
        if (m.role === 'user') kind = 'user-message'
        else if (ptype === 'reasoning') kind = 'reasoning'
        else if (ptype === 'tool-call') kind = 'tool-call'
        else if (ptype === 'tool-result') kind = 'tool-result'
        if (kind === 'tool-call' && toolCallId) toolCallAt.set(toolCallId, m.createdAt)
        const started = kind === 'tool-result' && toolCallId ? toolCallAt.get(toolCallId) : undefined
        steps.push({
          id: `${th.id}:${Math.max(turn, 0)}:${turnStep++}`,
          threadId: th.id, turnIndex: Math.max(turn, 0),
          role: m.role, kind,
          chars: text.length, tokensEst: Math.ceil(text.length / 4),
          toolName, toolCallId,
          isError: kind === 'tool-result' ? part?.isError === true || part?.is_error === true : undefined,
          durationMs: started && m.createdAt ? Math.max(0, Date.parse(m.createdAt) - Date.parse(started)) : undefined,
          excerpt: text.slice(0, 160),
          createdAt: m.createdAt ?? null
        })
      }
    }
  }
  const tasks = await pageAll((o) => sdk.tasks.list({ limit: PAGE, offset: o }))
  let memoryFacts = []
  try { memoryFacts = (await sdk.memory.list({})).facts ?? [] } catch { /* memory may be unavailable */ }

  const agents = {}, tools = {}, turns = {}
  for (const s of steps) {
    const who = s.role === 'user' ? 'user' : 'assistant'
    agents[who] ??= { agent: who, threadIds: new Set(), turnKeys: new Set(), steps: 0, toolCalls: 0, chars: 0, tokensEst: 0 }
    const A = agents[who]
    A.threadIds.add(s.threadId); A.turnKeys.add(`${s.threadId}:${s.turnIndex}`)
    A.steps++; A.chars += s.chars; A.tokensEst += s.tokensEst
    if (s.kind === 'tool-call') {
      A.toolCalls++
      tools[s.toolName ?? 'unknown'] ??= { toolName: s.toolName ?? 'unknown', calls: 0, resultChars: 0, errors: 0 }
      tools[s.toolName ?? 'unknown'].calls++
    }
    if (s.kind === 'tool-result') {
      const t = tools[s.toolName ?? 'unknown']
      if (t) { t.resultChars += s.chars; if (s.isError) t.errors++ }
    }
    const tk = `${s.threadId}:${s.turnIndex}`
    turns[tk] ??= { threadId: s.threadId, turnIndex: s.turnIndex, steps: 0, toolCalls: 0, chars: 0, tokensEst: 0, userPromptChars: 0 }
    const T = turns[tk]
    T.steps++; T.chars += s.chars; T.tokensEst += s.tokensEst
    if (s.kind === 'tool-call') T.toolCalls++
    if (s.kind === 'user-message') T.userPromptChars += s.chars
  }
  for (const a of Object.values(agents)) { a.threads = a.threadIds.size; a.turns = a.turnKeys.size; delete a.threadIds; delete a.turnKeys }

  const dataset = {
    version: 1,
    generatedAt: new Date().toISOString(),
    meta: {
      scope: args.thread ? `thread:${args.thread}` : 'project',
      since: args.since ?? null, until: args.until ?? null,
      storage: 'obvious-sdk', live: true,
      pipeline: 'agent-loops-report bootstrap v1 (agent identity is role-level; refine with tasks/delegation for full runs)'
    },
    source: { threadIds: threads.map((t) => t.id), messageCount, taskCount: tasks.length, memoryFactCount: memoryFacts.length },
    steps,
    stats: {
      agents: Object.values(agents),
      tools: Object.values(tools).sort((x, y) => y.calls - x.calls),
      turns: Object.values(turns).sort((x, y) => x.threadId.localeCompare(y.threadId) || x.turnIndex - y.turnIndex),
      totals: {
        steps: steps.length, messages: messageCount,
        toolCalls: steps.filter((s) => s.kind === 'tool-call').length,
        tokensEst: steps.reduce((n, s) => n + s.tokensEst, 0)
      }
    },
    raw: {
      threads: threads.map((t) => ({ id: t.id, name: t.name ?? t.title ?? null, createdAt: t.createdAt ?? null })),
      tasks, memoryFacts
    }
  }
  const out = args.out ?? '.'
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'loops.json'), JSON.stringify(dataset, null, 2))

  const TT = dataset.stats.totals
  let md = `# Agent Activity Report — ${dataset.meta.scope} · ${dataset.generatedAt}\n\n`
  md += `## Headline\n- Threads ${threads.length} · Messages ${messageCount} · Steps ${TT.steps} · Tool calls ${TT.toolCalls} · Est. tokens ≈ ${TT.tokensEst.toLocaleString()} (chars ÷ 4 — estimate, not provider usage)\n\n`
  md += `## Per agent\n| agent | threads | turns | steps | tool calls | chars | est. tokens |\n|---|---|---|---|---|---|---|\n`
  for (const a of dataset.stats.agents) md += `| ${a.agent} | ${a.threads} | ${a.turns} | ${a.steps} | ${a.toolCalls} | ${a.chars.toLocaleString()} | ≈${a.tokensEst.toLocaleString()} |\n`
  md += `\n## Per tool\n| tool | calls | result chars | errors |\n|---|---|---|---|\n`
  for (const t of dataset.stats.tools) md += `| ${t.toolName} | ${t.calls} | ${t.resultChars.toLocaleString()} | ${t.errors} |\n`
  md += `\n## Honesty notes\n- Tokens estimated at chars ÷ 4; no provider usage data. Cost figures require an explicitly assumed rate and are labelled illustrative.\n`
  if (args.prev) {
    try {
      const prev = JSON.parse(fs.readFileSync(args.prev, 'utf8'))
      const prevIds = new Set((prev.steps ?? []).map((s) => s.id))
      const curIds = new Set(steps.map((s) => s.id))
      const added = steps.filter((s) => !prevIds.has(s.id))
      const removed = (prev.steps ?? []).filter((s) => !curIds.has(s.id))
      const dTok = TT.tokensEst - (prev.stats?.totals?.tokensEst ?? 0)
      md += `\n## Delta vs ${args.prev} (generated ${prev.generatedAt ?? 'unknown'})\n`
      md += `- +${added.length} new steps · -${removed.length} disappeared · est. tokens ${dTok >= 0 ? '+' : ''}${dTok.toLocaleString()}\n`
      const byRole = {}
      for (const s of added) byRole[s.role] = (byRole[s.role] ?? 0) + 1
      for (const [r, n] of Object.entries(byRole)) md += `- new steps from ${r}: ${n}\n`
      if (removed.length > 20) md += `- ${removed.length} old IDs gone (ID-scheme or scope change — verify before reporting)\n`
      else for (const s of removed) md += `- removed: ${s.id} (${s.kind})\n`
    } catch (e) {
      md += `\n## Delta\n- Could not diff vs ${args.prev}: ${e.message}\n`
    }
  }
  fs.writeFileSync(path.join(out, 'digest.md'), md)
  console.log(`threads=${threads.length} messages=${messageCount} steps=${steps.length} tasks=${tasks.length} memoryFacts=${memoryFacts.length}`)
  console.log(`wrote ${path.join(out, 'loops.json')} and ${path.join(out, 'digest.md')}`)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
```

## Procedure

### 1. Scope
Default scope: the whole project. Narrow with `--threadId` (a single prompt's subthread) or a time range. State the scope in the report banner.

### 2. Inventory (SDK reads only)
- `threads.list` + `threads.listMessages` — typed content parts (user message, assistant reasoning, text, tool-call, tool-result) with roles, timestamps, threadId, tool-call metadata. Pages return `{items, pagination}` — paginate to exhaustion.
- `tasks.list` / `tasks.get` — delegation edges (`parentId` → worker), assignees, statuses, dispatch inputs.
- `memory.list` — no pagination limit; optional category filter.

### 3. Normalize → LoopsDataset
Hierarchy: **project → threads → turns → steps**. Every step carries: `id`, `threadId`, `turnIndex`, `seq`, `role`, `kind` (user-message | reasoning | text | tool-call | tool-result), `chars`, `tokensEst`, `contextChars` (cumulative), `promptChars`, `agent`, `toolName?`, `excerpt`, `fullText` (capped), `truncated`. Derived: per-turn / per-agent / per-thread / per-tool stats; a delegation tree (orchestrator task → worker thread → its turns); a flow model of step-kind transitions (split cyclic flows for d3-sankey); a `meta` block (dataset version, generatedAt, scope, live-vs-fixture flag, source choices).

### 4. Validate before reporting
Counts reconcile (messages == sum of parts; steps ≥ messages; tool-calls == tool-results modulo dangling calls), every referenced thread/task/agent resolves, every node carries sizing fields. **Fail loudly.** A report built on an unvalidated dataset is a fabrication, not a report.

### 5. Emit
- `data/loops.json` + publish it as a project file so it survives the sandbox.
- `report.md` digest: headline stats → per-agent table → per-turn table → delegation outline → loops observed → honesty notes (est. tokens, assumed cost rates, truncation counts).

### 6. Optional visualization
Vite + TypeScript + D3 v7 app (no framework) reading `./data/loops.json`. Views that earn their place: flow Sankey (thin links, area-encoded node metric via `scaleSqrt`), thread→turn→step hierarchy, context-growth curves, delegation tree, loop models, summary + tokens/cost view (metric toggle, cost overlays in every tooltip). Host: `npm run build`, static server over `dist/`, `obvious hosted register`. Before building the frontend, retrieve and follow the Modern Web Guidance skill (tooltips via native Popover API + CSS anchor positioning with `position-try-fallbacks` for space-aware side-opening, feature-detected JS fallback only; keyboard/focus parity; dark mode; reduced motion). QA in headless Chromium — hover AND focus tooltips, zero console errors, dark mode — with screenshots.

## Incremental runs
Deterministic IDs: step = `<threadId>:<turnIndex>:<seq>`. Re-runs re-emit a full snapshot; diff snapshots at phase boundaries to report *what changed* instead of everything.

## Reference implementation
Originated in project `agents-visualized` (prj_Migpa1ZZ): `/home/user/work/agents-visualized/{SCHEMA.md, pipeline/, app/}`. Sandbox paths do not transfer across projects — if absent, recreate from this contract rather than treating the paths as authoritative.
