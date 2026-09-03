---
name: agent-loops-report
version: 1.0.0
description: Produce a validated, LLM-friendly report of Obvious agent activity — threads, turns, steps, tool calls, delegation, context growth, estimated tokens/cost — for any project, thread, or prompt, runnable at any point in an execution loop. Outputs a schema-validated JSON dataset plus a Markdown digest, optionally a hosted D3 visualization. Use when asked to report on or visualize what agents did, or to add an activity-report stage to an execution loop.
category: autobuild
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
