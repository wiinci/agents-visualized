import * as d3 from 'd3';
import type { LoopNode, LoopsDataset, TurnStat } from '../types';
import { collectThreads, isStepKind } from '../data';
import { agentColor, fmtCompact, fmtInt, fmtTime } from '../format';
import { costOf, fmtCost, fmtRate, onRatesChange, rateFor } from '../cost';
import { el, makeRoving, onResize } from '../util';
import { createInfoPanel, wireInfoPanel, type PanelContent } from '../panel';

/**
 * Tokens & cost — consumption per turn and per agent, from the same observed
 * dataset as every other view.
 *
 * 1. Heatmap (rows = turns in global start-time order, columns = agents): cell
 *    colour = tokens (est.) that agent produced in that turn, on a sequential
 *    scale drawn with `light-dark()` so it adapts to both colour schemes
 *    (@chaytha/d3-heatmap + @d3/calendar conventions; legend after
 *    @d3/color-legend, as a CSS gradient of `light-dark()` stops).
 * 2. Cumulative line chart (x = global turn index, one line per agent) with a
 *    stacked-area toggle — nearest-point highlight and crosshair after
 *    @d3/multi-line-chart/2, stacking after @d3/tidy-stacked-area-chart.
 *
 * Numbers are per-turn token ESTIMATES (chars ÷ 4). Cost = estimated tokens ×
 * an assumed, editable rate (cost.ts) — never measured, never provider data.
 * Per-turn per-agent tokens are derived client-side from hierarchy step nodes
 * (meta.threadId/turnIndex/agent/tokensEst); the derivation's per-agent totals
 * match stats.agents exactly.
 */

type Metric = 'tokens' | 'cost';

// Selections survive rate-change re-renders (module-scoped: one app, one view instance).
let metric: Metric = 'tokens';
let stacked = false;
let focusAfter: 'metric' | 'mode' | null = null;

const cellKey = (threadId: string, turnIndex: number, agent: string): string => `${threadId}#${turnIndex}|${agent}`;

/** Sum tokensEst over observed step nodes by turn × agent (containers excluded — they carry sums). */
function deriveTurnAgentTokens(root: LoopNode): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (n: LoopNode): void => {
    const m = n.meta;
    if (m && isStepKind(n.kind) && m.threadId !== undefined && m.turnIndex !== undefined && Number.isFinite(m.tokensEst)) {
      const k = cellKey(m.threadId, m.turnIndex, m.agent);
      out.set(k, (out.get(k) ?? 0) + (m.tokensEst ?? 0));
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** threadId → display name (stats.turns carries only the id), and turnKey → its opening user-message node (for the panel's prompt excerpt). */
function threadDirectory(ds: LoopsDataset): { names: Map<string, string>; prompts: Map<string, LoopNode> } {
  const names = new Map<string, string>();
  const prompts = new Map<string, LoopNode>();
  for (const [tid, t] of collectThreads(ds.hierarchy)) {
    if (!names.has(tid)) names.set(tid, t.thread.name);
    (t.thread.children ?? []).forEach((turn, i) => {
      if (turn.kind !== 'turn') return;
      const ti = turn.meta?.turnIndex ?? i;
      const prompt = (turn.children ?? []).find((c) => c.kind === 'user-message');
      if (prompt) prompts.set(`${tid}#${ti}`, prompt);
    });
  }
  return { names, prompts };
}

/** Column order: fixed palette order first, then any other agents in first-seen order. */
function agentColumns(ds: LoopsDataset): string[] {
  const seen = ds.stats.agents.map((a) => a.agent);
  const preferred = ['user', 'orchestrator'];
  const cols = preferred.filter((a) => seen.includes(a));
  for (const a of seen) if (!cols.includes(a)) cols.push(a);
  return cols;
}

/**
 * Sequential scale whose colours are `light-dark()` pairs: light scheme runs a
 * Blues-style ramp, dark scheme a navy → bright-blue ramp with the same
 * ordering (more tokens = stronger colour), so both themes read correctly.
 */
function seqInterpolator(t: number): string {
  const light = d3.interpolateRgb('#eff5ff', '#1e3a8a')(t);
  const dark = d3.interpolateRgb('#1b2340', '#8ab4ff')(t);
  return `light-dark(${light}, ${dark})`;
}

/** CSS linear-gradient over the light-dark() interpolator (@d3/color-legend ramp, as CSS). */
function legendGradient(stops = 8): string {
  const parts: string[] = [];
  for (let i = 0; i < stops; i++) parts.push(`${seqInterpolator(i / (stops - 1))} ${((i / (stops - 1)) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

export function renderTokens(container: HTMLElement, ds: LoopsDataset): void {
  container.replaceChildren();

  const turns: TurnStat[] = [...ds.stats.turns].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt) || a.threadId.localeCompare(b.threadId) || a.turnIndex - b.turnIndex);
  if (!turns.length) { container.append(el('p', { class: 'muted' }, 'No turns in this dataset.')); return; }

  const cells = deriveTurnAgentTokens(ds.hierarchy);
  const { names, prompts } = threadDirectory(ds);
  const agents = agentColumns(ds);
  const valueOf = (t: TurnStat, agent: string): number => cells.get(cellKey(t.threadId, t.turnIndex, agent)) ?? 0;
  const val = (tokens: number, agent: string): number => (metric === 'cost' ? costOf(tokens, agent) : tokens);
  const fmtVal = (n: number): string => (metric === 'cost' ? fmtCost(n) : `≈${fmtInt(n)}`);
  const fmtValCompact = (n: number): string => (metric === 'cost' ? fmtCost(n) : `≈${fmtCompact(n)}`);
  const unitLabel = metric === 'cost' ? 'cost (est., assumed rate)' : 'tokens (est.)';
  const turnName = (t: TurnStat): string => `${names.get(t.threadId) ?? t.threadId} · turn ${t.turnIndex + 1}`;

  function excerptFor(t: TurnStat): PanelContent['text'] {
    const p = prompts.get(`${t.threadId}#${t.turnIndex}`);
    const body = p?.meta?.excerpt ?? '';
    return body ? { body, mono: false, label: 'User prompt that opened this turn (excerpt)' } : undefined;
  }

  // ── Toolbar: metric toggle + chart-mode toggle (select pattern used app-wide) ──
  const metricSel = el('select', { id: 'tok-metric', class: 'select' });
  metricSel.append(el('option', { value: 'tokens' }, 'tokens (est.)'), el('option', { value: 'cost' }, 'cost (est., assumed rate)'));
  metricSel.value = metric;
  metricSel.addEventListener('change', () => { metric = metricSel.value === 'cost' ? 'cost' : 'tokens'; focusAfter = 'metric'; renderTokens(container, ds); });

  const modeSel = el('select', { id: 'tok-mode', class: 'select' });
  modeSel.append(el('option', { value: 'lines' }, 'cumulative lines'), el('option', { value: 'stacked' }, 'stacked areas (total)'));
  modeSel.value = stacked ? 'stacked' : 'lines';
  modeSel.addEventListener('change', () => { stacked = modeSel.value === 'stacked'; focusAfter = 'mode'; renderTokens(container, ds); });

  // Info panel, modelled on the Sankey view's: grand totals by default, a
  // hovered/focused heatmap cell or line-chart turn column otherwise — the
  // content the former tooltips composed for this section. One panel serves
  // both charts.
  const panel = createInfoPanel({
    headingId: 'tokens-panel-title',
    heading: 'Details',
    contentFor: (key) => (key.startsWith('turn:') ? lineContent(Number(key.slice(5))) : cellContent(key)),
    defaultContent: () => ({
      title: 'Grand totals (est.)',
      badges: [{ text: `${fmtInt(turns.length)} turns` }, { text: `${fmtInt(agents.length)} agents` }],
      rows: [
        ...agents.map((a): [string, string] => {
          const st = ds.stats.agents.find((x) => x.agent === a);
          return [a, st ? `≈${fmtInt(st.tokensEst)} tokens (est.) · ${fmtCost(costOf(st.tokensEst, a))} at assumed rate` : '—'];
        }),
        ['all agents', `≈${fmtInt(d3.sum(ds.stats.agents, (x) => x.tokensEst))} tokens (est.) · ${fmtCost(d3.sum(ds.stats.agents, (x) => costOf(x.tokensEst, x.agent)))} at assumed rates`],
        ['method', 'tokens = chars ÷ 4 per step, summed; cost = est. tokens × assumed rate'],
        ['interaction', 'hover or focus a heatmap cell or line column for that turn'],
      ],
    }),
  });

  // One chart column beside the panel — same layout pattern as the Sankey view.
  const col = el('div', {});
  const layout = el('div', { class: 'info-layout' }, col, panel.root);
  container.append(
    el('p', { class: 'view-note' },
      `${fmtInt(turns.length)} turns across ${fmtInt(new Set(turns.map((t) => t.threadId)).size)} threads. `,
      el('strong', {}, 'Everything here is estimated'), ' — tokens = characters ÷ 4, cost = estimated tokens × an assumed rate (edit it under ', el('em', {}, 'Rates'), ' in the header). Hovering or focusing a heatmap cell or line column swaps the panel to that turn.'),
    el('div', { class: 'toolbar' },
      el('label', { class: 'sankey-metric', for: 'tok-metric' }, 'Metric: ', metricSel),
      el('label', { class: 'sankey-metric', for: 'tok-mode' }, 'Line chart: ', modeSel),
    ),
    layout,
  );

  // Panel content builders — revived from the pre-2026-09-03 tooltips:
  // heatmap cells showed the turn/agent metric plus the turn's context; line
  // columns showed per-agent deltas and cumulative values.
  function cellContent(key: string): PanelContent | null {
    for (const t of turns) {
      for (const a of agents) {
        if (cellKey(t.threadId, t.turnIndex, a) !== key) continue;
        const v = valueOf(t, a);
        const shown = val(v, a);
        const rows: [string, string][] = [
          ['agent', a],
          [unitLabel, metric === 'cost' ? `${fmtCost(shown)} · ${fmtRate(rateFor(a))}` : `≈${fmtInt(v)} (chars ÷ 4)`],
          ['context at end of turn', `${fmtInt(t.contextCharsAtEnd)} chars`],
          ['user prompt', `${fmtInt(t.userPromptChars)} chars`],
          ['steps', fmtInt(t.steps)],
          ['tool calls', fmtInt(t.toolCalls)],
          ['started', fmtTime(t.startedAt)],
        ];
        if (v === 0) rows.splice(1, 0, ['note', `no observed steps by ${a} in this turn`]);
        return { title: turnName(t), badges: [{ text: 'turn' }, { text: a }], rows, text: excerptFor(t) };
      }
    }
    return null;
  }

  function lineContent(i: number): PanelContent | null {
    const t = turns[i];
    if (!t) return null;
    const rows: [string, string][] = [
      ...series.map((s): [string, string] => [
        s.agent,
        `+${fmtVal(s.delta[i] ?? 0)}${metric === 'cost' ? '' : ' (est.)'} · cumulative ${fmtVal(s.cum[i] ?? 0)}`,
      ]),
      ['all agents', `+${fmtVal(totals[i] ?? 0)}${metric === 'cost' ? '' : ' (est.)'} · cumulative ${fmtVal(d3.sum(series, (s) => s.cum[i] ?? 0))}`],
      ['started', fmtTime(t.startedAt)],
    ];
    if (metric === 'cost') rows.unshift(['note', `cost = est. tokens × ${fmtRate(rateFor(t.agent))} (assumed; not provider data)`]);
    return { title: `${turnName(t)} (#${i + 1} globally)`, badges: [{ text: 'turn' }], rows, text: excerptFor(t) };
  }

  // ── 1. Heatmap ──────────────────────────────────────────────────────────
  const maxCell = d3.max(turns, (t) => d3.max(agents, (a) => val(valueOf(t, a), a))) ?? 0;
  const heatHost = el('div', { class: 'chart-host tok-chart', role: 'group', 'aria-label': `Heatmap of estimated tokens by turn (row) and agent (column); arrow keys move between cells` });
  const heatLegend = el('div', { class: 'tok-legend', 'aria-hidden': 'true' });
  col.append(el('h3', {}, 'Heatmap — tokens est. by turn and agent'), el('div', { class: 'tok-legend-row' }, heatLegend), heatHost);

  const heatNote = el('p', { class: 'view-note muted small' },
    'Rows are turns in global start-time order (a turn = one user message + everything until the next); columns are agents. ',
    'Colour = what that agent produced in that turn, so a turn with a user message, orchestrator steps and worker steps fills several cells. ',
    'Pale/empty cells mean the agent produced nothing in that turn.');
  col.append(heatNote);

  const drawHeat = (width: number): void => {
    heatHost.replaceChildren();
    const m = { top: 34, right: 16, bottom: 12, left: Math.min(240, Math.max(150, width * 0.22)) };
    const rowH = 36;
    const height = m.top + turns.length * rowH + m.bottom;
    const colW = (width - m.left - m.right) / agents.length;

    const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height)
      .attr('role', 'img').attr('aria-label', 'Heatmap of estimated tokens per turn and agent');
    const scale = d3.scaleSequential(seqInterpolator).domain([0, Math.max(1, maxCell)]);

    // Column headers: agent colour dot + name (monospace, like the rest of the app)
    agents.forEach((a, j) => {
      const x = m.left + colW * j;
      svg.append('circle').attr('cx', x + 7).attr('cy', m.top - 20).attr('r', 5).attr('fill', agentColor(a)).attr('aria-hidden', 'true');
      svg.append('text').attr('class', 'tok-colhead').attr('x', x + 17).attr('y', m.top - 16).text(a);
    });

    turns.forEach((t, i) => {
      const y = m.top + i * rowH;
      const name = names.get(t.threadId) ?? t.threadId;
      const short = name.length > 30 ? `${name.slice(0, 29)}…` : name;
      const label = svg.append('text').attr('class', 'tok-rowlabel').attr('x', m.left - 10).attr('y', y + rowH / 2 + 4).attr('text-anchor', 'end').text(`${short} #${t.turnIndex + 1}`);
      label.append('title').text(name); // full thread name for the truncated row label
      agents.forEach((a, j) => {
        const v = valueOf(t, a);
        const shown = val(v, a);
        const x = m.left + colW * j;
        svg.append('rect')
          .attr('class', `tok-cell${v === 0 ? ' is-empty' : ''}`)
          .attr('x', x).attr('y', y).attr('width', Math.max(2, colW - 3)).attr('height', rowH - 4).attr('rx', 3)
          .attr('fill', v === 0 ? 'var(--bg-3)' : scale(shown))
          .attr('data-hit', 'cell').attr('data-key', cellKey(t.threadId, t.turnIndex, a))
          .attr('tabindex', -1).attr('role', 'button')
          .attr('aria-label', `${a} in turn ${t.turnIndex + 1} of ${name}: ${fmtVal(shown)}${metric === 'cost' ? ' (assumed rate)' : ' (est.)'}`);
      });
    });

    heatHost.append(svg.node()!);
    makeRoving(heatHost, '[data-hit]');
  };

  // Sequential colour legend (@d3/color-legend): gradient bar + min/mid/max ticks.
  const drawHeatLegend = (): void => {
    heatLegend.replaceChildren();
    const maxShown = maxCell;
    heatLegend.append(el('span', { class: 'tok-legend-title muted small' }, unitLabel));
    const bar = el('span', { class: 'tok-legend-bar' });
    bar.style.background = legendGradient();
    heatLegend.append(bar);
    const lab = (s: string) => el('span', { class: 'tok-legend-tick mono muted small' }, s);
    heatLegend.append(lab(metric === 'cost' ? fmtCost(0) : '0'), lab(fmtValCompact(maxShown / 2)), lab(fmtValCompact(maxShown)));
  };
  drawHeatLegend();

  onResize(heatHost, drawHeat);

  // ── 2. Cumulative line / stacked-area chart ────────────────────────────
  // Per agent: delta per turn slot + running cumulative (flat where the agent did nothing).
  interface Series { agent: string; delta: number[]; cum: number[] }
  const series: Series[] = agents.map((a) => {
    const delta = turns.map((t) => val(valueOf(t, a), a));
    const cum: number[] = [];
    delta.reduce((acc, d, i) => (cum[i] = acc + d, cum[i]), 0);
    return { agent: a, delta, cum };
  });
  const totals = turns.map((_, i) => d3.sum(series, (s) => s.cum[i] ?? 0));

  const lineHost = el('div', { class: 'chart-host tok-chart', role: 'group', 'aria-label': 'Cumulative estimated tokens by agent over turn index; arrow keys move between turns' });
  col.append(el('h3', {}, stacked ? 'Stacked area — cumulative consumption, all agents' : 'Cumulative tokens est. by agent'), lineHost);
  col.append(el('p', { class: 'view-note muted small' },
    'X = turn index in global start-time order (not wall-clock time — turns have very different durations). ',
    stacked
      ? 'Bands stack each agent\u2019s cumulative total, so the top edge is overall consumption. '
      : 'Each line is one agent\u2019s running total; labels sit at line ends where they fit. ',
    'Hover, or focus a turn with the keyboard, to highlight that turn\u2019s crosshair and per-agent points and swap the panel to that turn.'));

  // Agent legend (colour + text, never colour alone)
  const legend = el('div', { class: 'legend', role: 'list', 'aria-label': 'Agent colours' });
  for (const s of series) legend.append(el('span', { class: 'legend-item', role: 'listitem' }, el('i', { class: 'swatch', style: `--c:${agentColor(s.agent)}` }), s.agent));
  col.append(legend);

  // Geometry + focus hooks refreshed by each drawLine; the interaction listeners below
  // are attached to lineHost ONCE (drawLine re-runs on resize and must not stack them).
  let lineGeom = { left: 64, step: 1, n: 1 };
  let showFocusFn: ((i: number) => void) | null = null;
  let hideFocusFn: (() => void) | null = null;

  const drawLine = (width: number): void => {
    lineHost.replaceChildren();
    const m = { top: 16, right: 120, bottom: 40, left: 64 };
    const height = 340;
    const n = turns.length;
    const yMax = d3.max(stacked ? totals : series.flatMap((s) => s.cum.map((c) => c ?? 0))) ?? 1;
    const x = d3.scaleLinear().domain([0, Math.max(1, n - 1)]).range([m.left, width - m.right]);
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([height - m.bottom, m.top]);

    const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height)
      .attr('role', 'img').attr('aria-label', stacked ? 'Stacked area of cumulative estimated consumption by agent' : 'Cumulative estimated tokens per agent over turns');
    svg.append('text').attr('class', 'axis-label').attr('x', width - m.right).attr('y', height - 6).attr('text-anchor', 'end').text('turn index (start-time order) →');
    svg.append('text').attr('class', 'axis-label').attr('x', m.left).attr('y', m.top - 2).text(stacked ? 'cumulative consumption' : 'cumulative tokens');

    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(n).tickFormat((d) => `#${(d as number) + 1}`));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((d) => (metric === 'cost' ? fmtCost(d as number) : fmtCompact(d as number))))
      .call((g) => g.selectAll('.tick line').clone().attr('x2', width - m.left - m.right).attr('stroke-opacity', 0.1).attr('class', 'tok-gridline'));

    // Bands for stacked mode: manual cumulative stacking in agent-column order.
    const bandLower: number[][] = agents.map(() => []);
    const bandUpper: number[][] = agents.map(() => []);
    if (stacked) {
      const acc: number[] = turns.map(() => 0);
      series.forEach((s, k) => {
        turns.forEach((_, i) => {
          const lower = acc[i] ?? 0;
          const upper = lower + (s.cum[i] ?? 0);
          bandLower[k]![i] = lower;
          bandUpper[k]![i] = upper;
          acc[i] = upper;
        });
      });
    }

    const valAt = (s: Series, i: number): number => (stacked ? bandUpper[agents.indexOf(s.agent)]?.[i] ?? 0 : s.cum[i] ?? 0);

    // Marks: areas underneath (stacked mode), lines on top (both modes, thin under stacked).
    if (stacked) {
      series.forEach((s, k) => {
        const area = d3.area<number>().x((_, i) => x(i)).y0((_, i) => y(bandLower[k]?.[i] ?? 0)).y1((_, i) => y(bandUpper[k]?.[i] ?? 0));
        svg.append('path').datum(d3.range(n)).attr('fill', agentColor(s.agent)).attr('fill-opacity', 0.8)
          .attr('class', 'tok-area').attr('d', area);
      });
    }
    series.forEach((s) => {
      const line = d3.line<number>().x((_, i) => x(i)).y((_, i) => y(valAt(s, i)));
      svg.append('path').datum(d3.range(n)).attr('fill', 'none')
        .attr('stroke', agentColor(s.agent)).attr('stroke-width', stacked ? 1.25 : 2)
        .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round')
        .attr('class', 'tok-line').attr('d', line);
    });

    // Direct labels at line ends (@d3/multi-line-chart/2 hover-label convention), hidden on collision.
    const placedY: number[] = [];
    series.forEach((s) => {
      const last = n - 1;
      const rawY = y(valAt(s, last));
      const yPos = Math.max(m.top + 8, Math.min(height - m.bottom - 4, rawY));
      const clash = placedY.some((py) => Math.abs(py - yPos) < 13);
      const label = svg.append('text').attr('class', 'tok-endlabel').attr('x', x(last) + 8).attr('y', yPos + 4)
        .attr('fill', agentColor(s.agent)).text(s.agent);
      if (clash) label.style('display', 'none');
      else placedY.push(yPos);
    });

    // Focus/hover layer: one full-height hit column per turn (keyboard arrows work
    // like the notebook's nearest-point pointer, but focusable for a11y).
    const step = n > 1 ? (x(1) - x(0)) : width - m.left - m.right;
    const crosshair = svg.append('line').attr('class', 'tok-crosshair').attr('y1', m.top).attr('y2', height - m.bottom).style('display', 'none');
    const dots = svg.append('g').style('display', 'none');
    const showFocus = (i: number): void => {
      const cx = x(n > 1 ? i : 0);
      crosshair.attr('x1', cx).attr('x2', cx).style('display', null);
      dots.style('display', null).selectAll('circle').data(series).join('circle')
        .attr('cx', cx).attr('cy', (s) => y(valAt(s, i))).attr('r', 3.5)
        .attr('fill', (s) => agentColor(s.agent)).attr('stroke', 'var(--bg)').attr('stroke-width', 1.5);
    };
    const hideFocus = (): void => { crosshair.style('display', 'none'); dots.style('display', 'none'); };

    turns.forEach((t, i) => {
      svg.append('rect')
        .attr('class', 'tok-hit').attr('x', m.left + (n > 1 ? step * i - step / 2 : 0)).attr('y', m.top)
        .attr('width', n > 1 ? step : width - m.left - m.right).attr('height', height - m.top - m.bottom)
        .attr('fill', 'transparent')
        .attr('data-hit', 'turn').attr('data-key', String(i))
        .attr('tabindex', -1).attr('role', 'button')
        .attr('aria-label', `Turn ${i + 1} (${names.get(t.threadId) ?? t.threadId}): total ${fmtVal(totals[i] ?? 0)} ${metric === 'cost' ? '(assumed rate)' : '(est.)'}`);
    });
    lineHost.append(svg.node()!);

    lineGeom = { left: m.left, step, n };
    showFocusFn = showFocus;
    hideFocusFn = hideFocus;
    if (!lineHost.dataset.bound) {
      lineHost.dataset.bound = '1';
      lineHost.addEventListener('pointermove', (e) => {
        const svg = lineHost.querySelector('svg');
        if (!svg) return;
        const [xm] = d3.pointer(e, svg);
        const { left, step, n } = lineGeom;
        showFocusFn?.(Math.max(0, Math.min(n - 1, Math.round((xm - left) / (step || 1)))));
      });
      lineHost.addEventListener('pointerleave', () => hideFocusFn?.());
      lineHost.addEventListener('focusin', (e) => {
        const hit = (e.target as Element | null)?.closest<SVGRectElement>('.tok-hit');
        const i = hit ? Number(hit.getAttribute('data-key')) : NaN;
        if (Number.isInteger(i)) showFocusFn?.(i);
      });
      lineHost.addEventListener('focusout', () => hideFocusFn?.());
    }
    makeRoving(lineHost, '[data-hit]');
  };
  onResize(lineHost, drawLine);

  // Honest-labelling footnote (also the schema gap note: stats.turns carries no thread display name).
  col.append(el('p', { class: 'view-note muted small' },
    `Tokens are estimated at chars ÷ 4 on every step, then summed — nothing here is measured usage. `,
    `Cost = estimated tokens × an assumed rate (${fmtRate(rateFor(undefined))} default, per-class overrides under Rates in the header) — illustrative only. `,
    `With only ${fmtInt(turns.length)} turns the lines are short; cumulative totals still show where consumption concentrated.`));

  wireInfoPanel([heatHost, lineHost], panel, (mark) => (mark.classList.contains('tok-hit') ? `turn:${mark.getAttribute('data-key') ?? ''}` : mark.getAttribute('data-key')));

  onRatesChange(container, () => renderTokens(container, ds));

  // Restore focus to the toggle the reader just used (re-render recreated the DOM).
  if (focusAfter) { document.getElementById(focusAfter === 'metric' ? 'tok-metric' : 'tok-mode')?.focus(); focusAfter = null; }
}
