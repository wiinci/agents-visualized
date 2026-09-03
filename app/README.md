# agents-visualized — app

D3 v7 + TypeScript (strict) + Vite single-page visualization of Obvious agent loops.
Data contract: `../SCHEMA.md`. Data file: `../data/loops.json` (owned by the pipeline worker — not written here).

## Commands

```sh
cd /home/user/work/agents-visualized/app
npm install                 # once
npm run typecheck           # tsc --noEmit (strict, noUnused*, noUncheckedIndexedAccess)
npm run build               # tsc --noEmit && vite build  → dist/
npm run preview             # serves dist/ at http://127.0.0.1:4173 (strict port)
npm run dev                 # Vite dev server (serves ../data/loops.json at /data/loops.json)
npm run fixture             # regenerate public/data/loops.fixture.json (synthetic, schema-conformant)
```

Static hosting: serve `dist/` with any file server (e.g. `npx serve dist`). Only `index.html`, `assets/*`, and `data/*` are needed.

## Data loading

- The build plugin (`vite.config.ts`) copies `../data/loops.json` → `dist/data/loops.json` when the file exists; the dev server serves it from the same path.
- At runtime `src/data.ts` fetches `./data/loops.json`; on 404/parse/validation failure it loads `./data/loops.fixture.json` and shows a **fixture data** banner. The banner is also the place where `source.storage` and `generatedAt` are shown (plus the "Where this data came from" panel).
- Nothing is keyed to fixture ids: all views derive from `hierarchy`, `flows`, `delegation`, `loopModel`, `stats` generically.

## Layout

```
index.html             semantic shell, tablist, banner, source panel
src/main.ts            load → index → tabs → lazy per-view render (yielding)
src/data.ts            fetch/validate/index, stage mapping, flow examples
src/types.ts           TypeScript mirror of SCHEMA.md
src/tooltip.ts         shared hover/focus/pin details popover
src/util.ts            yieldToMain, rovingTabindex, responsive(), el()
src/format.ts          numbers, colours, labels
src/cost.ts            assumed-rate cost model: editable rates, Rates popover, persistence
src/views/sankey.ts    1 · Loop Sankey (d3-sankey, loop-backs as return arcs)
src/views/hierarchy.ts 2 · Turn hierarchy (zoomable icicle, size = chars)
src/views/context.ts   3 · Context growth small multiples
src/views/delegation.ts4 · Delegation tree (d3-tree, radius = prompt chars)
src/views/loopModel.ts 5 · Documented loop model (cycle diagrams)
src/views/summary.ts   6 · Summary (KPIs + tables)
src/views/tokens.ts    7 · Tokens & cost (heatmap + cumulative line/stacked-area, metric toggle)
GUIDANCE.md            Modern Web Guidance guides used, where, and schema notes
screenshots/           headless-Chromium captures from the live-data build
```

## Tokens & cost are estimates, not measurements

Tokens are estimated as characters ÷ 4 on every step and summed; cost = estimated tokens × an assumed USD-per-1M-token rate (default $3.00, editable per agent class in the header's Rates popover, persisted in localStorage). The dataset carries no provider usage data — every token and cost figure in the app is labelled "est." or "assumed rate".

## Verification performed

- `npm run build` passes strict typecheck; dist contains index.html, assets, `data/loops.json` (live) and `data/loops.fixture.json`.
- `curl` on the preview server: `/` 200, `/data/loops.json` 200 (761 KB), `/data/loops.fixture.json` 200.
- Headless Chromium (Playwright, script in `/home/user/work/pw/check.mjs`): all seven tabs render SVG/tables with zero page or console errors; hover opens the tooltip; focus opens the tooltip; ArrowRight moves focus between marks; Enter pins; Esc closes; dark theme renders. The Tokens view additionally asserts: heatmap cells + sequential legend present, cost metric relabels every cell with "assumed rate", stacked mode draws one area per agent, the Rates popover opens, and editing the default rate updates the footnote.
