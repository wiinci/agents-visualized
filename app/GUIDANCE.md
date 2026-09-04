# Modern Web Guidance — guides retrieved and where they were applied

Workflow used (per `/home/user/work/mwg/repo/skills/modern-web-guidance/SKILL.md`):
`npx -y modern-web-guidance@latest search "<query>"` → `npx -y modern-web-guidance@latest retrieve "<id>" > /home/user/work/mwg/out/<id>.md`.
Retrieved copies live in `/home/user/work/mwg/out/`. Fallback rule applied as the guides state it: Baseline widely-available features are used directly; anything newer is feature-detected or given a CSS fallback.

| Guide id | Applied where | How |
|---|---|---|
| `accessibility` | `src/util.ts` (`rovingTabindex`), every view, `index.html`, `styles.css` | Every chart mark is `role="button"` with an `aria-label` carrying name + size; roving `tabindex` (one tab stop per chart, arrow keys move between marks). Enter on keydown / Space on keyup like native buttons. Node details are never hover-only: the Sankey info panel swaps on focus as well as hover, and every other mark's `aria-label` carries its name and sizes in place of the former tooltips (removed 2026-09-03); text is never colour-only (status glyphs + colour in the delegation tree, legends everywhere). Skip link, landmarks, `role="status"` banner, WAI-ARIA tabs (`role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`). Visible 3px focus ring with 2px offset on HTML controls and SVG node groups; stroke-only `<path>`s use a glow instead because Chrome draws a box outline as a stray line. Tables are real `<table>` with `<th scope>`; the summary view is the non-visual alternative to the charts. |
| `dark-mode` | `index.html` `<meta name="color-scheme">` + inline script, `styles.css` `:root`, `src/main.ts` theme select | `color-scheme: light dark` declared in HTML and CSS; every colour is a `light-dark()` pair; `@supports not (color: light-dark(...))` provides a `prefers-color-scheme` fallback. SVG marks use CSS custom properties so they follow the scheme. Toggle follows the guide's OPTIONAL section exactly (compliance pass 2026-09-03): **two-state** control ("System colours" / the opposite scheme, pinned exactly so it survives later OS changes), pin persisted in `localStorage`, mirrored into the `<meta>`, applied as an inline `style.colorScheme` so it beats the stylesheet's `:root` rule, an **inline non-module `<script>` in `<head>`** applies a saved pin before first paint (no FOUC), and a `matchMedia('(prefers-color-scheme: dark)')` `change` listener relabels the option. |
| `size-aware-styling` | `styles.css` `.panel { container: panel / inline-size }`, `.multiples`, `.loops-grid` | Small-multiple grids switch 1 → 2 → 3 columns via `@container panel (min-width: …)` rather than viewport media queries. Charts themselves redraw from a `ResizeObserver` on their host (`src/util.ts` `responsive()`), so each view is sized by its container, not the window. |
| `fluid-scaling` | `styles.css` `--step-*`, `--space` | Type and spacing scale with `clamp()` ranges. The guide's container-query-unit variant (`cqi`) was not used for the global scale because the page-level container is the viewport; container units would add nothing there. |
| `css-layout` | `styles.css` layout section | Flex for the header/toolbar rows, Grid for KPI strip (`repeat(auto-fit, minmax())`), small multiples, info-panel rows and source metadata; logical properties (`inline-size`, `margin-block`, `inset-block-start`) throughout; `min(100% - 2*var(--space), 1400px)` content column. |
| `css` | `styles.css` | Custom properties for the design tokens; low-specificity single-class selectors; `:focus-visible`; `color-mix()` for badge tints (Baseline); `paint-order: stroke` halos for SVG labels instead of duplicate text nodes. Compliance pass 2026-09-03 (tooltip rules removed with the tooltip system later that day): the `*` box-sizing reset became a zero-specificity `:where(<element list>)` rule (guide: no global resets); the `* { transition-duration: 0s !important }` reduced-motion kill switch was replaced by a per-case rule on the only CSS transition (guide: do not globally zero durations). |
| `defer-rendering-heavy-content` | `src/main.ts`, `src/util.ts` `onResize()` | Inactive tab panels are `hidden`, and each view only performs its D3 layout when its panel is first shown (lazy render in `main.ts` + `ResizeObserver` gating in `util.ts`), so the 400-node icicle isn't laid out on load. Compliance pass 2026-09-03: `content-visibility: auto` was **removed** from `.view-host` — the guide says DO NOT apply it above the fold, and the active panel is in the initial viewport; the inactive panels are `display: none` already, so the property bought nothing there and only added an a11y-verification burden. |
| `break-up-long-tasks` | `src/util.ts` `yieldToMain()` / `forEachYielding()`, `src/main.ts` | `scheduler.yield()` when available, `setTimeout(0)` fallback; a 50 ms deadline is checked while indexing the dataset and rendering views sequentially, so the initial paint isn't blocked by one long task (INP). |
| `performance` | `index.html`, `vite.config.ts` | Single stylesheet in `<head>`, module script (deferred by default), d3 split into its own chunk by Vite (`manualChunks`), no third-party fonts (system font stack), data fetched once at runtime and indexed in memory. Critical-CSS inlining was **not** done — the whole stylesheet is 10 KB / 3 KB gzipped, below the threshold where the split pays off. |
| `html` | `index.html`, `src/views/summary.ts` | Semantic landmarks (`header`, `main`, `section`, `footer`), `<dl>` for metadata, `<table>` with `<thead>` and `<th scope>`, each introduced by a heading, `<button>` for tabs and actions, `hidden` attribute for inactive panels, `lang="en"`, viewport meta, `<meta name="description">`. |

## Compliance pass (2026-09-03, integration task)

All guide ids above were re-retrieved with `npx -y modern-web-guidance@latest retrieve <id>` into `/home/user/work/mwg/out2/` and byte-compared with the copies in `/home/user/work/mwg/out/` — identical. Findings outside the Sankey view (which was being redesigned separately and was not touched):

| Finding | Guide rule | Fix |
|---|---|---|
| `*, *::before, *::after { box-sizing }` | `css`: no global resets | `:where(body, div, section, …) { box-sizing: border-box }` |
| `* { transition-duration: 0s !important; animation-duration: 0s !important }` under reduced motion | `css`: do not globally zero durations | per-case rule on `.chart-host.is-fading`; icicle zoom already skipped in JS |
| `content-visibility: auto` on the visible `.view-host` | `defer-rendering-heavy-content`: never above the fold | removed (panels are `hidden`/lazy anyway) |
| Three-state theme select, no pre-paint script, `<meta>` not updated | `dark-mode` OPTIONAL toggle section: two-state, inline script, update meta, listen for OS change | rewritten in `index.html` + `main.ts` |
| Node labels/glyphs had `pointer-events: none`, so hovering a label next to a delegation node or loop phase hit nothing (focus was fine) | `accessibility` visible indicator | `pointer-events` restored on `.tree-label`, `.tree-glyph`, `.lm-label`, `.lm-num` (they sit inside the `role="button"` group) |

Verified after the fixes in headless Chromium (Playwright 1.62.1, `qa/qa.mjs`): six views render with zero page/console errors; the dark pin persists across a reload with the inline script setting `style.colorScheme`/`meta` before the module runs. (The tooltip open/pin/Esc checks that used to close this paragraph were removed with the tooltip system — see "Tooltip system removal" below.)

Not fixed (reported): Sankey-specific findings are listed in the integration report, not here.

## Deliberate departures from the guides (with reason)

- **`prefers-reduced-motion`** — the guides assume animated UI; this app has almost none. The only motion (icicle zoom transitions, the Sankey panel swap entrance) is disabled under `prefers-reduced-motion: reduce` (`src/util.ts` `prefersReducedMotion()`, `styles.css` per-case rules).
- **`mix-blend-mode: multiply`** on Sankey ribbons (a common D3 pattern) was removed: it inverts badly in dark mode and isn't in any guide.

## Observable references (Sankey rework, 2026-09-03)

Retrieved via the Observable module API (client-rendered notebook pages fetch only shells).

- `@d3/sankey/2` — d3-sankey usage: node/link data shapes, alignment, extent/padding; informed the layout call and the decision to keep d3-sankey for x/y placement while drawing the marks ourselves.
- `@d3/sankey-component` — the reusable node/link component pattern (alignment options, link rendering); informed separating layout from rendering so links could become hairline strokes with invisible 8px hit twins instead of filled ribbons.
- `@d3/bubble-chart/2` — value-proportional **area** sizing (the `d3.pack`/sqrt principle); the basis for `r = scaleSqrt().range([0, 14])` — dot area, never radius, encodes the metric — and the three-circle area legend.
- `@john-guerra/sankey-diagram-component` — hover highlighting that dims non-connected marks and emphasizes the connected path; implemented as `.is-highlighting` + `.is-hi` on hover/focus of nodes, links and loop-backs.

## Tokens & cost view (2026-09-03)

New seventh view `src/views/tokens.ts` (heatmap + cumulative line/stacked-area, metric toggle) and `src/cost.ts` (assumed-rate cost model, header Rates popover). What was applied, and from where:

### Modern Web Guidance

- **forms** (`/home/user/work/mwg/out4/forms-combined.md`) — the Rates popover follows the guide's semantic-structure and accessible-labelling sections: a real `<form>` with `<label for>` on every numeric input, `type="number"` with `min`/`step` constraints, `inputmode="decimal"` so mobile keyboards match the data, and the reset control as a plain button rather than a submit.
- **validate-input-after-interaction** (`/home/user/work/mwg/out4/validate-input-after-interaction.md`) — the guide's core rule is no premature validation feedback while the user types. Applied by design: blank or invalid rate entries never raise an error state (`:user-invalid` deliberately unused); they silently fall back to the default rate, and a popover hint says so up front.
- The app-wide colour and dark-mode practices (light-dark() pairs, no duplicated dark rules) extend to the new sequential heatmap ramp and its legend.

### Observable references

- `@d3/color-legend` — ramp-legend convention (gradient bar + min/mid/max ticks). Implemented as a CSS `linear-gradient` built from a `light-dark()` interpolator, so one legend serves both colour schemes.
- `@d3/calendar` (heatmap family) and `@chaytha/d3-heatmap` — heatmap conventions: a sequential scale for magnitude, a distinct neutral treatment for zero cells, and a label per cell carrying the full context (agent, thread/turn, tokens est., cost est., context at end of turn, user-prompt size, steps, tool calls, start time). The label lives in each cell's `aria-label` (the shared tooltip these conventions described was removed 2026-09-03).
- `@d3/multi-line-chart/2` — direct labels at line ends (hidden on collision) instead of a detached legend, and the nearest-point highlight: crosshair + per-series dots, driven by pointer position and by keyboard focus on per-turn hit columns (arrow keys walk turns).
- `@d3/tidy-stacked-area-chart` — the stacked-area toggle: bands stack each agent's cumulative total in a fixed agent order so the top edge is overall consumption; per-agent lines remain visible as thin strokes on their bands.

### Design decisions worth keeping

- Heatmap rows are turns in global start-time order; columns are agents (user, orchestrator, then worker:*). Cell values are derived client-side from hierarchy step nodes (`meta.threadId`/`turnIndex`/`agent`/`tokensEst`) and match `stats.agents` totals exactly.
- Sequential scale: light scheme `#eff5ff → #1e3a8a` (Blues), dark scheme `#1b2340 → #8ab4ff`, encoded as `light-dark()` pairs. Exactly-zero cells use the neutral surface colour so "nothing" reads differently from "a little".
- The metric toggle (tokens est. | cost est.) re-scales both charts, relabels every cell, and restores keyboard focus to the toggle after the re-render.
- With only 7 turns the line chart is sparse; the view says so, and labels x as turn index in start-time order — not wall-clock time, since turn durations differ wildly.

## Sankey info panel (2026-09-03)

A permanent rectangular details column beside the chart (`.sankey-layout` grid, `.sankey-panel` aside). The default view is the flow's origin node — derived as the node with no incoming links (`originNode()`), leftmost rank when several exist — never hardcoded. Hovering or focusing a node swaps the panel to that node's details and mouseout/focus-out reverts to the origin. Design points:

- **The panel is the only detail surface**: the shared tooltip system was removed on 2026-09-03 (see "Tooltip system removal" below), so the panel no longer shares content with anything — `nodeContent()` feeds only the panel now, and the example-step text is gone with the tooltips.
- **A11y**: `aria-live="polite"` announces swaps; the `aside` is labelled by its own heading; focus follows the same roving-tabindex marks as hover.
- **Motion**: swaps are a 170ms opacity/translate entrance on the incoming body; `@media (prefers-reduced-motion: reduce)` disables the animation (case-by-case rule, no global kill switch).
- **Interaction details**: node→node pointer moves let `pointerover` drive the swap (no default-view flash between adjacent marks); links never touch the panel; a keyboard-focused node wins over a simultaneously hovering pointer; the panel re-renders without animation on metric toggle and resize redraws.
- **Responsive**: two columns (chart + 24rem panel — widened from 18rem on 2026-09-03, still clear of the chart at 900–1100px container widths) once the layout container is ≥900px wide (`@container panel`), stacked below the chart but still visible under that.

## Tooltip system removal (2026-09-03)

The shared hover/focus tooltip (`src/tooltip.ts`, the `.tip` popover, all `data-tip` attributes, pin/Escape wiring and its QA script `esc-theme.mjs`) was removed at the user's request. Consequences the docs above already reflect:

- The Sankey info panel is the **only** node-detail surface: hover and keyboard focus swap it, mouseout/blur reverts it, `aria-live="polite"` announces swaps.
- Other views intentionally lose floating hover details; each mark keeps its `role="button"`, roving keyboard focus, and an `aria-label` carrying name and sizes. Interaction hooks are marked `data-hit` (not `data-tip`).
- The tooltip-focused guidance rows (`interest-triggered-tooltips`, `position-aware-tooltips`) and their retrievals are retired; the compliance-pass findings that only concerned tooltip CSS are gone with the code.

## Schema notes for the data owner (SCHEMA.md was not edited)

Fields the app needed that SCHEMA.md does not provide; each has a workaround in `src/data.ts`:

1. **`flows.links[].examples`** — the original Sankey brief asked hover to show *example step text* per ribbon; that hover detail died with the tooltip system (2026-09-03), so the app no longer derives or consumes examples. Flows carry only `source/target/value/kind`. An explicit `examples: string[]` (or step ids) on each link would still be the cheaper contract if hover examples ever return.
2. **Acyclic flows** — d3-sankey rejects cycles; the data legitimately has `observe → reason`, `respond → user`-style return edges (13 in the live file). The app detects and splits them (`splitCycles()` in `views/sankey.ts`). A `loopBack: true` flag on such links would let the pipeline decide rather than a reachability heuristic.
3. **Worker-thread placement in `hierarchy`** — SCHEMA.md (hierarchy comment) says worker threads nest under the dispatching orchestrator *turn*, and the live data does exactly that. My fixture generator wrongly nested them under a *step*; the collector in `src/data.ts` accepts both so either file renders. Not a schema gap — a fixture deviation, noted so nobody "fixes" the schema to match the fixture.
4. **`stats.turns[]` has `threadId` but no thread display name** — the summary turns table shows the raw thread id (`th_…`). A `threadName` per turn row would read better.
5. **Delegation timestamps are present** (`meta.createdAt/updatedAt/completedAt` on tasks and worker threads in the live file) but the tree currently encodes only status, prompt size and text; durations are unused by the UI (they only appeared in the former tooltips). No schema change needed — a possible follow-up for the view.

## Section info panels (2026-09-04)

PR #3 removed the tooltip system app-wide; the five non-Sankey sections lost their hover details with it. `src/panel.ts` restores that content as **permanent info panels** — the same interaction the Sankey view established (origin-default content beside the chart, hover/focus swap, mouseout/blur revert, `aria-live="polite"`, 170ms swap animation with a reduced-motion fallback, 24rem column from a 900px container breakpoint).

- **Shared implementation:** `src/panel.ts` exports `createInfoPanel()` (default + hover content, swap/revert wiring, aria), `nodePanel()` (reusable `nodeTip`-shaped rows from a hierarchy node), and `wireInfoPanel()` (delegated pointer/focus listeners + roving keyboard). The Sankey view keeps its own inline panel; the five sections reuse the `.sankey-panel*` classes plus `.info-layout` (the two-column grid) — no tooltip DOM, no `data-tip` attributes anywhere.
- **Defaults and swap content per view:** hierarchy → project root by default, cell depth/descendants/path on hover; context → trajectory overview (turns, steps, tool calls, chars, context at end), step/thread/turn details on hover; delegation → root dispatcher prompt excerpt, task/worker metadata + child counts on hover; summary → overall totals, turn-row details (incl. the opening user-prompt excerpt) on hover; tokens → grand totals, heatmap-cell or line-column metrics on hover (line columns are keyed `turn:<index>`).
- **Text blocks:** panels can include a capped full-text block (`.sankey-panel-text`, 14 lines max, scrollable) — used for user-prompt excerpts; `isCodeLike()` (restored in `format.ts`) switches code/JSON to the mono style.
- **Cost rows** in the hierarchy/context/summary/tokens panels reuse `cost.ts` and say "assumed rate" — same honest labelling as before.
- **QA:** `qa/qa.mjs` now asserts panel presence/aria/two-track layout, hover/focus swap, mouse-out revert, no tooltip artifacts, and captures default/hovered (light) and default (dark) screenshots for all five sections alongside the Sankey checks.
