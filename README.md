# Agent loops, visualized

A D3 + TypeScript visualization of how Obvious agents actually run: turns, tool calls, delegation to worker threads, context growth, prompt sizes and estimated tokens, with every mark carrying a hover/focus tooltip that shows the full text behind it.

**Live app:** https://0sd1wsphf5-4173.hosted.obvious.ai (also embedded in the project as the iframe artifact "Agent loops, visualized (live app)").

Two pieces, one contract:

| Path | What it is |
|---|---|
| `SCHEMA.md` | The `LoopsDataset` contract both sides agree on (hierarchy, stats, flows, delegation, loop model, sizing fields). |
| `pipeline/` | Strict-TypeScript extractor. Reads Obvious server-side data through the SDK and writes `data/loops.json`. |
| `data/loops.json` | The current live snapshot (regenerated on every extract run). |
| `app/` | Vite + TypeScript + D3 single-page app. Loads `./data/loops.json`, falls back to a clearly labelled fixture if it is missing. |
| `app/GUIDANCE.md` | Which Chrome Modern Web Guidance guides were applied, where, and the deviations found and fixed in the compliance pass. |
| `qa/` | Playwright scripts (`qa.mjs`, `esc-theme.mjs`) plus the screenshots and `qa-result.json` from the last headless run. |

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

1. **Loop Sankey** — observed stage transitions (user → reason → tool → observe → … → respond, plus delegate → worker → wake) aggregated across all threads. Link width = transition count; tooltips show example step excerpts for each transition. *This view is being redesigned separately (area-encoded nodes, hairline links, zoom); see `app/GUIDANCE.md` and the integration report for its current state.*
2. **Turn hierarchy** — zoomable icicle: project → thread → turn → step (reasoning / tool call / tool result / assistant text / user message). Width = chars; every cell's tooltip has the full text, chars, tokens (est.), contextChars and, for turns and prompts, promptChars.
3. **Context growth** — one small multiple per thread: cumulative context (chars) over the turn's steps, so the cost of long tool loops is visible as slope. Each point is focusable with the same tooltip fields.
4. **Delegation tree** — orchestrator thread → tasks → worker threads, with dispatch links dashed. Node tooltips carry the recovered dispatch prompt (promptChars) and the worker's totals; status is shown with glyph + colour, never colour alone.
5. **Documented loop model** — the loop as Obvious's own docs describe it (phases and next/repeat/exit edges), rendered beside the observed data so documented vs. observed are never conflated. Edge tooltips explain each transition.
6. **Summary** — accessible tables (per turn, per agent, per tool) with the same numbers as the charts, plus the source metadata block. This is the non-visual equivalent of the charts.

Everywhere: one shared tooltip (a `popover` when supported) opens on hover **and** on focus, is dismissible with Escape, and can be pinned with click/Enter/Space so its full text is selectable. It opens **to the side** of the mark: on engines with CSS anchor positioning the browser places it right of the mark and flips it left/above/below by available space (via an HTML anchor shim, since SVG shapes cannot anchor); elsewhere a side-first JS fallback does the same. One tab stop per chart, arrow keys move between marks. Light/dark follows the system with a two-state pin control that survives reloads.

## Modern Web Guidance applied

Guide ids retrieved with `npx -y modern-web-guidance@latest retrieve <id>` and cross-checked against the code: `interest-triggered-tooltips`, `position-aware-tooltips`, `accessibility`, `dark-mode`, `size-aware-styling`, `fluid-scaling`, `css-layout`, `css`, `defer-rendering-heavy-content`, `break-up-long-tasks`, `performance`, `html`. `app/GUIDANCE.md` maps each guide to the files that implement it, lists the deliberate departures (no `interesttarget`/`popover="hint"` — still not Baseline and non-functional on D3-generated SVG; native CSS anchor positioning **is** used for tooltip placement through an HTML anchor shim where supported, with a side-first JS fallback and a `?no-anchor` QA hook), and records the 2026-09-03 compliance pass: the six deviations found outside the Sankey (popover fallback selector, global `*` resets, global reduced-motion kill switch, above-the-fold `content-visibility`, three-state theme control without a pre-paint script, label hit areas) and how each was fixed.

## Verification record (2026-09-03)

- `pipeline`: `npm run extract` + `npm run validate` + strict `tsc --noEmit` all clean.
- `app`: strict `tsc --noEmit` clean (0 errors at 16:39 UTC, after the Sankey redesign's interim typing errors were resolved by its own worker); `vite build` succeeds.
- Served: `index.html`, `data/loops.json` (1.5 MB, `application/json`) and all hashed assets return 200 through the hosted URL; the banner reads "Live data. Loaded data/loops.json." (not the fixture).
- Headless Chromium (Playwright 1.62.1): all six views render with zero page or console errors; hover and focus open tooltips on every view; Escape dismisses; pinning works; dark pin persists across reload. Screenshots: `qa/*.png`, uploaded to the project as `qa-*.png` files.
