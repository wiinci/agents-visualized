# Agent loops, visualized

A D3 + TypeScript visualization of how Obvious agents actually run: turns, tool calls, delegation to worker threads, context growth, prompt sizes and estimated tokens, with sizes visible in every encoding (colour, area, bars, tables) and node details collected in the Sankey view's info panel.

**Live app:** https://0sd1wsphf5-4173.hosted.obvious.ai (also embedded in the project as the iframe artifact "Agent loops, visualized (live app)").

See [How this report is built](docs/explainer.md) for a conference-length spec of the extraction → schema → D3 pipeline.

**Print edition:** [docs/agents-visualized-report.pdf](docs/agents-visualized-report.pdf) — the wiki, typeset as one professional report (cover, numbered sections, figures, print CSS).

Two pieces, one contract:

| Path | What it is |
|---|---|
| `SCHEMA.md` | The `LoopsDataset` contract both sides agree on (hierarchy, stats, flows, delegation, loop model, sizing fields). |
| `pipeline/` | Strict-TypeScript extractor. Reads Obvious server-side data through the SDK and writes `data/loops.json`. |
| `data/loops.json` | The current live snapshot (regenerated on every extract run). |
| `app/` | Vite + TypeScript + D3 single-page app. Loads `./data/loops.json`, falls back to a clearly labelled fixture if it is missing. |
| `app/GUIDANCE.md` | Which Chrome Modern Web Guidance guides were applied, where, and the deviations found and fixed in the compliance pass. |
| `qa/` | Playwright script (`qa.mjs`) plus the screenshots and `qa-result.json` from the last headless run. |

## Where the data comes from

Obvious keeps no on-disk turn store (`~/.obvious/` on the project sandbox is empty), so everything is read server-side through the Obvious SDK, scoped to the current project:

- `threads.list` → every thread in the project (orchestrator + worker threads), paged 100 at a time.
- `threads.listMessages` per thread → messages with typed parts (`text`, `reasoning`, `tool-call`, `tool-result`). Model signatures (`providerOptions`) are stripped.
- `tasks.list` / `tasks.get` → the delegation tree (`parentId`, `assignees[].agentId` = worker thread id). Dispatch prompts are not exposed by `tasks.get`, so they are recovered from each worker thread's first user-role message, which matches the orchestrator's `tasks start --prompt` call.
- `memory.list` → memory facts, stored in `hierarchy.meta.memory`.

Derived fields (all defined in `SCHEMA.md`): a **turn** is one user-role message plus everything until the next; `chars` is the part's text length; `tokensEst = ceil(chars / 4)` (an estimate, always labelled as such in the UI); `contextChars` is the cumulative size of everything earlier in the same thread; `promptChars` is the size of the user/dispatch prompt that started the turn. Wake notices are detected heuristically (`meta.wakeDetection`).

The dataset's `source.storage` string records exactly what was read, when, and how many of each thing; the app prints it on the Summary view and uses it to decide whether it is showing live data or the fixture.

### Snapshot currently served (generated 2026-09-03T16:24:24Z)

4 threads (1 orchestrator + 3 workers), 266 messages, 7 turns, 146 tool calls, 407 hierarchy steps, 4 tasks, 3 memory facts; 15 flow nodes / 43 flow links. Largest single turn: the app-builder worker at 259 steps / 99 tool calls / 747 K chars (~187 K tokens est.).

## Re-running extract + rebuild

On the project sandbox (the SDK token and `PROJECT_ID` are already in the environment there):

```sh
cd /home/user/work/agents-visualized

# 1. Re-extract: rewrites data/loops.json from all threads now in the project, then validates it
cd pipeline && npm run extract && npm run validate && cd ..

# 2. Rebuild the app: strict tsc, Vite build, and the build plugin copies ../data/loops.json into dist/data/loops.json
cd app && npm run build && cd ..

# 3. The hosted server is a static file server over app/dist, so it picks the new build up immediately.
#    If it is not running (fresh sandbox), start it under the canonical tmux name:
cd app && tmux new-session -d -s svc-4173 "python3 -m http.server 4173 --directory dist"
```

Local preview without hosting: `cd app && npm run dev` (Vite dev server; the same plugin serves `../data/loops.json` at `/data/loops.json`). `npm run fixture` regenerates the synthetic fixture in `app/public/data/loops.fixture.json`.

Hosting is registered with `obvious hosted register --port=4173 --startupCommand="python3 -m http.server 4173 --directory dist" --workDir=/home/user/work/agents-visualized/app`; the proxy restarts that command in that directory when the sandbox wakes. No re-registration is needed after a rebuild.

## The six views

1. **Loop Sankey** — observed stage transitions (user → reason → tool → observe → … → respond, plus delegate → worker → wake) aggregated across all threads. Link width = transition count. Node dots area-encode the selected metric (context or prompt chars, toggle above the chart); a permanent 24rem info panel beside the chart shows the origin (`user`) node's details by default, swaps to the hovered or focused node's details, and reverts on mouseout/blur (swaps are disabled under reduced motion). See `app/GUIDANCE.md` for the rework notes. The same panel pattern now covers the five other analytical sections (Turn Hierarchy, Context Growth, Delegation Tree, Summary, Tokens & Cost), so every section keeps a permanent, keyboard-readable details column instead of the floating tooltips the app once had.
2. **Turn hierarchy** — zoomable icicle: project → thread → turn → step (reasoning / tool call / tool result / assistant text / user message). Width = chars; every cell's `aria-label` carries its name and size.
3. **Context growth** — one small multiple per thread: cumulative context (chars) over the turn's steps, so the cost of long tool loops is visible as slope. Each point's `aria-label` carries the step's name and sizes.
4. **Delegation tree** — orchestrator thread → tasks → worker threads, with dispatch links dashed. Each node's `aria-label` carries name, status and prompt size; status is shown with glyph + colour, never colour alone.
5. **Documented loop model** — the loop as Obvious's own docs describe it (phases and next/repeat/exit edges), rendered beside the observed data so documented vs. observed are never conflated. Each phase's and edge's `aria-label` carries its description.
6. **Summary** — accessible tables (per turn, per agent, per tool) with the same numbers as the charts, plus the source metadata block. This is the non-visual equivalent of the charts.

Everywhere: marks are keyboard-reachable (one tab stop per chart, arrow keys move between marks) and named by their `aria-label`s; there are no floating tooltips — the Sankey info panel is the only node-detail surface. Light/dark follows the system with a two-state pin control that survives reloads.

## Modern Web Guidance applied

Guide ids retrieved with `npx -y modern-web-guidance@latest retrieve <id>` and cross-checked against the code: `accessibility`, `dark-mode`, `size-aware-styling`, `fluid-scaling`, `css-layout`, `css`, `defer-rendering-heavy-content`, `break-up-long-tasks`, `performance`, `html` (the tooltip-focused guides were dropped when the tooltip system was removed — see `app/GUIDANCE.md` for that history). `app/GUIDANCE.md` maps each guide to the files that implement it, lists the deliberate departures, and records the 2026-09-03 compliance pass: the deviations found outside the Sankey (global `*` resets, global reduced-motion kill switch, above-the-fold `content-visibility`, three-state theme control without a pre-paint script, label hit areas) and how each was fixed.

## Verification record (2026-09-03)

- `pipeline`: `npm run extract` + `npm run validate` + strict `tsc --noEmit` all clean.
- `app`: strict `tsc --noEmit` clean (0 errors at 16:39 UTC, after the Sankey redesign's interim typing errors were resolved by its own worker); `vite build` succeeds.
- Served: `index.html`, `data/loops.json` (1.5 MB, `application/json`) and all hashed assets return 200 through the hosted URL; the banner reads "Live data. Loaded data/loops.json." (not the fixture).
- Headless Chromium (Playwright 1.62.1): all six views render with zero page or console errors; no tooltip elements or `data-tip` attributes exist on any view; every analytical view's info panel (Sankey, hierarchy, context, delegation, summary, tokens) renders 24rem-wide beside the chart at ≥900px container width, stacks below it under the breakpoint, and swaps/reverts on hover and focus. Screenshots: `qa/*.png`, uploaded to the project as `qa-*.png` files.
