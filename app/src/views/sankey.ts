import * as d3 from 'd3';
import { Delaunay } from 'd3';
import { sankey, sankeyJustify, type SankeyNode, type SankeyLink } from 'd3-sankey';
import type { FlowLink, FlowNode, LoopNode, LoopsDataset } from '../types';
import { fmtCompact, fmtInt, stageColor, stageLabel } from '../format';
import { stageOf } from '../data';
import { el, makeRoving, onResize, prefersReducedMotion } from '../util';
import { createInfoPanel, type PanelContent } from '../panel';

/**
 * Loop Sankey — "dots and hairlines" variant.
 *
 * d3-sankey (as in @d3/sankey-component) still computes the columns and the
 * vertical order, but nodes are drawn as small circles at the node centre and
 * links converge on that point as thin strokes. Circle AREA encodes a size
 * metric via d3.scaleSqrt (the same principle d3.pack uses: r ∝ √value, see
 * @d3/bubble-chart). Hover/focus on a node or link highlights the connected
 * paths in the ink colour and dims the rest (@john-guerra/sankey-diagram-component).
 */

type SNode = SankeyNode<FlowNode, FlowLink>;
type SLink = SankeyLink<FlowNode, FlowLink>;
type Metric = 'context' | 'prompt';

/** Area encoding constants — sqrt scale on the metric, never a linear radius. */
const R_MAX = 14;      // radius of the largest circle, px
const R_MIN = 2;       // hollow ring radius for zero / near-zero values, px
const LINK_W = [1, 4] as const; // compressed stroke-width range, px (scaleSqrt on transition count)

/**
 * Proximity interaction constants. Voronoi cells tile the whole canvas, so
 * inside the overlay rect the nearest mark is always resolvable and always
 * highlighted — the rect's bounds are the only proximity gate, with no dead
 * zones; outside the rect (or on pointerleave) nothing highlights.
 */
const LINK_SAMPLE_PX = 10;   // spacing between index samples along a link's rendered path

/** One hoverable point in the Delaunay index; `el` is the mark the highlight applies to. */
interface ProximityTarget { kind: 'node' | 'link'; key: string; el: Element; x: number; y: number; }

/** Canonical left-to-right order of stages; tool:* share one rank. Columns are pinned to this rank. */
const STAGE_RANK: Record<string, number> = { user: 0, wake: 0, reason: 1, delegate: 2, worker: 3, observe: 3, respond: 4 };
const rank = (stage: string): number => (stage.startsWith('tool:') ? 2 : STAGE_RANK[stage] ?? 2);
/** Short label used beside a dot; the column header carries the stage family, so tools show just their name. */
const shortLabel = (stage: string): string => (stage.startsWith('tool:') ? stage.slice(5) : stageLabel(stage));
const CHAR_W = 7.2; // approx. advance width of 12px monospace, for margin estimation

/**
 * d3-sankey cannot lay out cycles, and columns here are pinned to the stage rank.
 * A link is "forward" only if it moves to a higher rank (left → right); everything
 * else — observe → reason, respond → tool, tool → tool within the same column,
 * self-loops — is a "loop-back" drawn as a hairline return edge. Splitting by rank
 * (not by graph reachability) guarantees the forward set is a DAG whose depth never
 * exceeds the rank ladder, so the pinned columns stay contiguous.
 */
function splitCycles(nodes: FlowNode[], links: FlowLink[]): { forward: FlowLink[]; back: FlowLink[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const r = (id: string): number => rank(byId.get(id)?.stage ?? '');
  const forward: FlowLink[] = [], back: FlowLink[] = [];
  for (const l of links) (r(l.target) > r(l.source) ? forward : back).push(l);
  return { forward, back };
}

/** Per-stage size aggregates gathered from every hierarchy node that maps onto a flow node. */
interface StageSizes {
  n: number; contextSum: number; contextN: number; promptSum: number; promptN: number;
  tokensSum: number; tokensN: number;
}

function collectStageSizes(root: LoopNode, nodes: FlowNode[]): Map<string, StageSizes> {
  const byStage = new Map<string, string>(); // stage → flow node id
  for (const n of nodes) byStage.set(n.stage, n.id);
  const out = new Map<string, StageSizes>();
  const walk = (node: LoopNode): void => {
    const id = byStage.get(stageOf(node));
    if (id && node.meta) {
      const s = out.get(id) ?? { n: 0, contextSum: 0, contextN: 0, promptSum: 0, promptN: 0, tokensSum: 0, tokensN: 0 };
      s.n++;
      const ctx = node.meta.contextChars ?? node.meta.contextCharsAtEnd;
      if (ctx !== undefined) { s.contextSum += ctx; s.contextN++; }
      if (node.meta.promptChars !== undefined) { s.promptSum += node.meta.promptChars; s.promptN++; }
      if (node.meta.tokensEst !== undefined) { s.tokensSum += node.meta.tokensEst; s.tokensN++; }
      out.set(id, s);
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

const METRIC_LABEL: Record<Metric, string> = { context: 'context size', prompt: 'prompt size' };
const METRIC_HELP: Record<Metric, string> = {
  context: 'cumulative context (chars) at the moment each step of that stage ran',
  prompt: 'prompt chars: user-message length, tool-call argument length, or dispatch prompt length',
};

function metricOf(s: StageSizes | undefined, m: Metric): { mean: number; n: number } {
  if (!s) return { mean: 0, n: 0 };
  return m === 'context'
    ? { mean: s.contextN ? s.contextSum / s.contextN : 0, n: s.contextN }
    : { mean: s.promptN ? s.promptSum / s.promptN : 0, n: s.promptN };
}

/**
 * Default info-panel node: the flow's origin — a node with no incoming links
 * (the starting/user stage). Derived from the data, never hardcoded; when
 * several source nodes exist, the leftmost rank (user/wake) wins, then data order.
 */
function originNode(nodes: FlowNode[], links: FlowLink[]): FlowNode | undefined {
  const sources = nodes.filter((n) => !links.some((l) => l.target === n.id));
  return sources.find((n) => rank(n.stage) === 0) ?? sources[0];
}

export function renderSankey(container: HTMLElement, ds: LoopsDataset): void {
  const { nodes, links } = ds.flows;
  container.replaceChildren();
  if (!nodes.length) { container.append(el('p', { class: 'muted' }, 'No flow data.')); return; }

  const { forward, back } = splitCycles(nodes, links);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const sizes = collectStageSizes(ds.hierarchy, nodes);
  let metric: Metric = 'context';

  // ── Toolbar: metric toggle + area legend ────────────────────────────────
  const metricSelect = el('select', { id: 'sankey-metric', class: 'select' });
  metricSelect.append(
    el('option', { value: 'context' }, 'context size (mean per step)'),
    el('option', { value: 'prompt' }, 'prompt size (mean per step)'),
  );
  const legendHost = el('div', { class: 'sankey-legend', role: 'img' });

  const note = el('p', { class: 'view-note' },
    'Observed transitions between step stages, left to right. Dot ',
    el('strong', {}, 'area'),
    ' = mean size over the steps mapped to that stage (√ scale); hollow rings mark stages with no size data. Line weight = transition count (1–4px). ',
    el('strong', {}, `${fmtInt(back.length)} loop-back edge${back.length === 1 ? '' : 's'}`),
    ' (cycles such as observe → reason) are dashed hairlines bowing beneath the flow, ending in a small dot at their target, because a Sankey layout is acyclic; self-loops are small teardrops above a dot. Hover or focus a dot or line to highlight its connected paths. Drag to pan, Ctrl/⌘ + scroll or the buttons to zoom.');

  // ── Chart frame with zoom controls (top-right) ──────────────────────────
  const host = el('div', { class: 'chart-host sankey-host', role: 'group', 'aria-label': 'Loop Sankey diagram; use arrow keys to move between nodes and links' });
  const zoomIn = el('button', { type: 'button', class: 'zoom-btn', 'aria-label': 'Zoom in', title: 'Zoom in' }, '+');
  const zoomOut = el('button', { type: 'button', class: 'zoom-btn', 'aria-label': 'Zoom out', title: 'Zoom out' }, '−');
  const zoomFit = el('button', { type: 'button', class: 'zoom-btn', 'aria-label': 'Fit diagram to view', title: 'Fit to view' }, '⛶');
  const zoomReset = el('button', { type: 'button', class: 'zoom-btn', 'aria-label': 'Reset zoom', title: 'Reset zoom' }, '↺');
  const zoomBar = el('div', { class: 'zoom-controls', role: 'toolbar', 'aria-label': 'Zoom controls' }, zoomIn, zoomOut, zoomFit, zoomReset);
  // Metric toggle + area legend on the left, zoom controls top-right — in one row above the chart
  // so the controls never cover the diagram's own column headers or labels.
  const toolbar = el('div', { class: 'sankey-toolbar' },
    el('label', { class: 'sankey-metric', for: 'sankey-metric' }, 'Dot area = ', metricSelect),
    legendHost,
    zoomBar,
  );
  const frame = el('div', { class: 'sankey-frame' }, host);
  // ── Node info content (the info panel's single source of truth) ────────
  const origin = originNode(nodes, links);
  const nodeContent = (n: FlowNode): PanelContent => {
    const inn = links.filter((l) => l.target === n.id).reduce((s, l) => s + l.value, 0);
    const out = links.filter((l) => l.source === n.id).reduce((s, l) => s + l.value, 0);
    const s = sizes.get(n.id);
    const ctx = metricOf(s, 'context'), pr = metricOf(s, 'prompt');
    const active = metricOf(s, metric);
    return {
      title: stageLabel(n.stage),
      badges: [{ text: 'observed' }, { text: n.kind }, { text: `dot area = mean ${METRIC_LABEL[metric]}` }],
      rows: [
        ['stage', n.stage],
        ['steps', fmtInt(n.count)],
        [`mean ${METRIC_LABEL[metric]} (encoded)`, active.n ? `${fmtInt(Math.round(active.mean))} chars over ${fmtInt(active.n)} step${active.n === 1 ? '' : 's'}` : 'no data → hollow ring'],
        ['mean context size', ctx.n ? `${fmtInt(Math.round(ctx.mean))} chars (n=${fmtInt(ctx.n)})` : '—'],
        ['mean prompt size', pr.n ? `${fmtInt(Math.round(pr.mean))} chars (n=${fmtInt(pr.n)})` : '—'],
        ['mean tokens (est.)', s && s.tokensN ? `${fmtInt(Math.round(s.tokensSum / s.tokensN))} est. tokens over ${fmtInt(s.tokensN)} step${s.tokensN === 1 ? '' : 's'}` : '—'],
        ['aggregation', `mean per step; ${METRIC_HELP[metric]}`],
        ['incoming transitions', fmtInt(inn)],
        ['outgoing transitions', fmtInt(out)],
        ['id', n.id],
      ],
    };
  };

  // ── Info panel: a permanent rectangular column beside the chart ─────────
  // Shared component. Always visible (never floating): the origin node's
  // details by default, the hovered/focused node's details while interaction
  // lasts. aria-live=polite announces content swaps; the heading gives the
  // aside its accessible name. Only node keys reach contentFor — link hover
  // highlights without touching the panel.
  const panel = createInfoPanel({
    headingId: 'sankey-panel-title',
    heading: 'Node details',
    contentFor: (key) => {
      const n = nodeById.get(key);
      return n ? nodeContent(n) : null;
    },
    defaultContent: () => (origin ? nodeContent(origin) : null),
  });
  const layout = el('div', { class: 'sankey-layout' }, frame, panel.root);
  container.append(note, toolbar, layout);

  // ── Legend: three adjacent circles, bottom-aligned, value labelled beneath ──
  const drawLegend = (max: number): void => {
    legendHost.replaceChildren();
    const r = d3.scaleSqrt().domain([0, Math.max(1, max)]).range([0, R_MAX]);
    const values = max > 0 ? [max, max / 4, max / 16] : [];
    const slot = 78, w = values.length ? slot * values.length : 120, h = R_MAX * 2 + 18;
    const svg = d3.create('svg').attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`).attr('aria-hidden', 'true');
    const base = R_MAX * 2 + 1;
    const g = svg.append('g').attr('class', 'legend-circles');
    values.forEach((v, i) => {
      const cx = slot * i + slot / 2;
      g.append('circle').attr('cx', cx).attr('cy', base - r(v)).attr('r', r(v));
      g.append('text').attr('x', cx).attr('y', h - 3).attr('text-anchor', 'middle').text(`${fmtCompact(v)} chars`);
    });
    if (!values.length) g.append('text').attr('x', 0).attr('y', base).text('no size data');
    legendHost.setAttribute('aria-label', values.length
      ? `Area legend: circles of ${values.map((v) => fmtInt(Math.round(v))).join(', ')} characters, mean ${METRIC_LABEL[metric]} per step`
      : 'Area legend: no size data');
    legendHost.append(svg.node()!);
  };

  // ── Highlight state (John Guerra's hover pattern, extended to focus) ────
  let svgSel: d3.Selection<SVGSVGElement, undefined, null, undefined> | null = null;
  const clearHighlight = (): void => {
    if (!svgSel) return;
    svgSel.classed('is-highlighting', false);
    svgSel.selectAll('.is-hi').classed('is-hi', false);
  };
  const highlightFor = (target: Element): void => {
    if (!svgSel) return;
    const key = target.getAttribute('data-key') ?? '';
    const kind = target.getAttribute('data-hit');
    clearHighlight();
    svgSel.classed('is-highlighting', true);
    if (kind === 'node') {
      svgSel.selectAll<SVGPathElement, unknown>('.sankey-link').filter(function () {
        const k = this.getAttribute('data-key') ?? '';
        const [s, t] = k.split('->');
        return s === key || t === key;
      }).classed('is-hi', true);
      svgSel.selectAll<SVGGElement, unknown>('.sankey-node').filter(function () {
        const id = this.getAttribute('data-key') ?? '';
        if (id === key) return true;
        return links.some((l) => (l.source === key && l.target === id) || (l.target === key && l.source === id));
      }).classed('is-hi', true);
    } else {
      const [s, t] = key.split('->');
      svgSel.selectAll<SVGPathElement, unknown>('.sankey-link').filter(function () { return this.getAttribute('data-key') === key; }).classed('is-hi', true);
      svgSel.selectAll<SVGGElement, unknown>('.sankey-node').filter(function () {
        const id = this.getAttribute('data-key');
        return id === s || id === t;
      }).classed('is-hi', true);
    }
  };

  // ── Draw ────────────────────────────────────────────────────────────────
  let lastWidth = 0;
  let zoom: d3.ZoomBehavior<SVGSVGElement, undefined> | null = null;
  let contentBox = { x: 0, y: 0, w: 0, h: 0 };
  let viewport = { w: 0, h: 0 };

  const draw = (width: number): void => {
    lastWidth = width;
    host.replaceChildren();
    const height = Math.max(420, Math.min(760, nodes.length * 40));
    const labelOf = (n: FlowNode): string => `${shortLabel(n.stage)} · ${fmtInt(n.count)}`;
    const labelW = (pred: (n: FlowNode) => boolean): number => (d3.max(nodes.filter(pred), (n) => labelOf(n).length) ?? 0) * CHAR_W;
    const maxRank = d3.max(nodes, (n) => rank(n.stage)) ?? 0;
    const margin = {
      top: 44 + R_MAX,                                   // column headers + room for self-loop teardrops
      right: 16 + R_MAX + 10 + labelW((n) => rank(n.stage) === maxRank),
      bottom: 24 + R_MAX,
      left: 16 + R_MAX + 10 + labelW((n) => rank(n.stage) === 0),
    };
    viewport = { w: width, h: height };

    // Columns are pinned to the stage rank (nodeAlign returns the layer index), so a tool node
    // that only has cyclic in-links still sits in the tool column instead of drifting left.
    // Ranks present in the data are compressed to contiguous layer indices.
    const ranksPresent = [...new Set(nodes.map((n) => rank(n.stage)))].sort(d3.ascending);
    const layerOf = new Map(ranksPresent.map((rk, i) => [rk, i]));
    const makeGen = (pinned: boolean) => {
      const gen = sankey<FlowNode, FlowLink>()
        .nodeId((d) => d.id)
        .nodeWidth(1)
        .nodePadding(22)
        .nodeSort((a, b) => d3.descending(a.value ?? 0, b.value ?? 0))
        .extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]]);
      return pinned ? gen.nodeAlign((node, n) => Math.min(n - 1, layerOf.get(rank(node.stage)) ?? 0)) : gen.nodeAlign(sankeyJustify);
    };
    const input = () => ({ nodes: nodes.map((n) => ({ ...n })), links: forward.map((l) => ({ ...l })) });
    let graph: ReturnType<ReturnType<typeof makeGen>>;
    try {
      graph = makeGen(true)(input());
    } catch {
      // Degenerate dataset (a rank present with no forward path to it leaves an empty column):
      // fall back to d3-sankey's own justified layout rather than failing the view.
      graph = makeGen(false)(input());
    }

    const cx = (n: SNode): number => n.x0 ?? 0;
    const cy = (n: SNode): number => ((n.y0 ?? 0) + (n.y1 ?? 0)) / 2;
    const pos = new Map(graph.nodes.map((n) => [n.id, n]));
    const minX = d3.min(graph.nodes, cx) ?? 0;

    // Column headers: the stage families present in each column, in muted monospace.
    const columns = d3.groups(graph.nodes, (n) => Math.round(cx(n))).sort((a, b) => a[0] - b[0]);
    const family = (s: string): string => (s.startsWith('tool:') ? 'tool' : s);

    // Sizes for this metric
    const metricValue = (id: string): number => metricOf(sizes.get(id), metric).mean;
    const maxMetric = d3.max(nodes, (n) => metricValue(n.id)) ?? 0;
    const r = d3.scaleSqrt().domain([0, Math.max(1, maxMetric)]).range([0, R_MAX]); // AREA ∝ value
    const radiusOf = (id: string): { r: number; hollow: boolean } => {
      const rr = r(metricValue(id));
      return rr < R_MIN ? { r: R_MIN, hollow: true } : { r: rr, hollow: false };
    };
    drawLegend(maxMetric);

    const linkW = d3.scaleSqrt().domain([0, d3.max(links, (l) => l.value) ?? 1]).range([LINK_W[0], LINK_W[1]]);

    const svg = d3.create('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('width', width).attr('height', height)
      .attr('role', 'img')
      .attr('class', 'sankey-svg')
      .attr('aria-label', `Sankey of observed step-stage transitions; dot area shows mean ${METRIC_LABEL[metric]} per step`);
    svg.append('title').text('Observed step-stage transitions (Sankey)');
    svgSel = svg;

    const layer = svg.append('g').attr('class', 'zoom-layer');

    layer.append('g').attr('class', 'sankey-headers')
      .selectAll('text').data(columns).join('text')
      .attr('class', 'sankey-header')
      .attr('x', ([, ns]) => cx(ns[0]!))
      .attr('y', 18)
      // Headers sit where that column's labels sit: left of the first column, right of the last.
      .attr('text-anchor', (_, i) => (i === 0 ? 'end' : i === columns.length - 1 ? 'start' : 'middle'))
      .attr('dx', (_, i) => (i === 0 ? 6 : i === columns.length - 1 ? -6 : 0))
      .text(([, ns]) => [...new Set(ns.map((n) => family(n.stage)))].join(' / '));

    // Forward links: thin strokes converging on node centres (not ribbons).
    const linkPath = d3.linkHorizontal<{ source: [number, number]; target: [number, number] }, [number, number]>();
    const shorten = (s: SNode, t: SNode): { source: [number, number]; target: [number, number] } => {
      const rs = radiusOf(s.id).r, rt = radiusOf(t.id).r;
      return { source: [cx(s) + rs, cy(s)], target: [cx(t) - rt, cy(t)] };
    };
    // Visible hairlines are decorative (pointer-events: none in CSS); interaction lives on an
    // invisible wider-stroke layer (see below) so hovers on curved strokes never miss.
    layer.append('g').attr('fill', 'none').attr('class', 'sankey-links')
      .selectAll<SVGPathElement, SLink>('path').data(graph.links).join('path')
      .attr('class', 'sankey-link')
      .attr('d', (d) => linkPath(shorten(d.source as SNode, d.target as SNode)) ?? '')
      .attr('stroke-width', (d) => linkW(d.value))
      .attr('data-key', (d) => `${(d.source as SNode).id}->${(d.target as SNode).id}`);
    const hitsG = layer.append('g').attr('fill', 'none').attr('class', 'sankey-hits');

    // Loop-back edges: dashed hairlines that bow downward from source to target (right→left),
    // a 3px dot marks the target. Self-loops are small teardrops above the node.
    const backG = layer.append('g').attr('fill', 'none').attr('class', 'sankey-back');
    const backPath = (d: FlowLink): string => {
      const s = pos.get(d.source), t = pos.get(d.target);
      if (!s || !t) return '';
      const rs = radiusOf(s.id).r, rt = radiusOf(t.id).r;
      const x0 = cx(s), x1 = cx(t);
      if (d.source === d.target) {
        const y = cy(s) - rs;
        return `M${x0 - 3},${y} C${x0 - 22},${y - 26} ${x0 + 22},${y - 26} ${x0 + 3},${y}`;
      }
      const y0 = cy(s) + rs, y1 = cy(t) + rt;
      const bow = 28 + Math.abs(x1 - x0) * 0.16; // deeper bow for longer spans so arcs separate
      return `M${x0},${y0} C${x0},${Math.max(y0, y1) + bow} ${x1},${Math.max(y0, y1) + bow} ${x1},${y1}`;
    };
    backG.selectAll<SVGPathElement, FlowLink>('path').data(back).join('path')
      .attr('class', 'sankey-link is-back')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4 3')
      .attr('d', backPath)
      .attr('data-key', (d) => `${d.source}->${d.target}`);

    // Invisible ~8px hit strokes over every edge (same geometry, transparent stroke)
    // carrying the interaction attributes. Pointer duty retired (pointer-events: none
    // in CSS — the proximity overlay resolves the cursor); they remain the keyboard
    // roving-focus targets and the geometry source for link sampling.
    // One combined data array + one join: a second selectAll('path') join in the same group
    // would re-bind the first join's paths and shrink the layer to the last dataset.
    const hitSpecs = [
      ...graph.links.map((d) => ({
        d: linkPath(shorten(d.source as SNode, d.target as SNode)) ?? '',
        key: `${(d.source as SNode).id}->${(d.target as SNode).id}`,
        label: `${stageLabel((d.source as SNode).stage)} to ${stageLabel((d.target as SNode).stage)}, ${fmtInt(d.value)} transitions`,
      })),
      ...back.map((d) => ({
        d: backPath(d),
        key: `${d.source}->${d.target}`,
        label: `loop back: ${stageLabel(nodeById.get(d.source)?.stage ?? '')} to ${stageLabel(nodeById.get(d.target)?.stage ?? '')}, ${fmtInt(d.value)} transitions`,
      })),
    ];
    hitsG.selectAll<SVGPathElement, (typeof hitSpecs)[number]>('path').data(hitSpecs).join('path')
      .attr('class', 'sankey-linkhit')
      .attr('d', (d) => d.d)
      .attr('stroke-width', 8)
      .attr('data-hit', 'link')
      .attr('data-key', (d) => d.key)
      .attr('tabindex', -1)
      .attr('role', 'button')
      .attr('aria-label', (d) => d.label);
    backG.selectAll<SVGCircleElement, FlowLink>('circle').data(back.filter((d) => d.source !== d.target)).join('circle')
      .attr('class', 'sankey-back-dot')
      .attr('r', 1.5)
      .attr('cx', (d) => cx(pos.get(d.target)!))
      .attr('cy', (d) => cy(pos.get(d.target)!) + radiusOf(d.target).r + 1.5);

    // Nodes: circles (area = metric) + monospace labels.
    const node = layer.append('g').attr('class', 'sankey-nodes')
      .selectAll<SVGGElement, SNode>('g').data(graph.nodes).join('g')
      .attr('class', (d) => `sankey-node${radiusOf(d.id).hollow ? ' is-empty' : ''}`)
      .attr('transform', (d) => `translate(${cx(d)},${cy(d)})`)
      .attr('data-hit', 'node')
      .attr('data-key', (d) => d.id)
      .attr('tabindex', -1)
      .attr('role', 'button')
      .attr('aria-label', (d) => {
        const m = metricOf(sizes.get(d.id), metric);
        return `${stageLabel(d.stage)}, ${fmtInt(d.count)} steps, mean ${METRIC_LABEL[metric]} ${m.n ? fmtInt(Math.round(m.mean)) + ' characters' : 'unknown'}`;
      });
    node.append('circle')
      .attr('class', 'sankey-dot')
      .attr('r', (d) => radiusOf(d.id).r)
      .attr('fill', (d) => (radiusOf(d.id).hollow ? 'none' : stageColor(d.stage)))
      .attr('stroke', (d) => stageColor(d.stage));
    // Larger invisible hit area so hairline-sized dots are still easy to hover.
    node.append('circle').attr('class', 'sankey-hit').attr('r', 9);
    node.append('text')
      .attr('class', 'sankey-label')
      .attr('x', (d) => (cx(d) === minX ? -(radiusOf(d.id).r + 8) : radiusOf(d.id).r + 8))
      .attr('text-anchor', (d) => (cx(d) === minX ? 'end' : 'start'))
      .attr('dy', '0.35em')
      .text((d) => labelOf(d));

    // Content bounding box (for "fit") — labels included, computed after mount.
    host.append(svg.node()!);
    const bb = (layer.node() as SVGGElement).getBBox();
    contentBox = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };

    // ── Proximity index: one Delaunay over every hoverable point ────────────
    // Node targets sit at circle centres; link targets sample the rendered hit
    // paths every ~LINK_SAMPLE_PX (getPointAtLength), so the index follows the
    // drawn curves rather than straight source→target chords. Samples stop
    // short of the dot radius (paths are already shortened to the dot edges),
    // so node centres win ties near a dot. Rebuilt on every redraw.
    const targets: ProximityTarget[] = graph.nodes.map((d) => ({
      kind: 'node',
      key: d.id,
      el: node.nodes().find((g) => g.getAttribute('data-key') === d.id)!,
      x: cx(d), y: cy(d),
    }));
    hitsG.selectAll<SVGPathElement, { key: string }>('path').nodes().forEach((p) => {
      const len = p.getTotalLength();
      const steps = Math.max(1, Math.round(len / LINK_SAMPLE_PX));
      for (let i = 0; i <= steps; i++) {
        const pt = p.getPointAtLength((len * i) / steps);
        targets.push({ kind: 'link', key: p.getAttribute('data-key') ?? '', el: p, x: pt.x, y: pt.y });
      }
    });
    const delaunay = Delaunay.from(targets, (t) => t.x, (t) => t.y);

    // ── Overlay: one transparent rect, the sole pointer surface ─────────────
    // A sibling after the zoom layer, so it never pans or scales and pan/zoom
    // gestures bubble to the svg's zoom behavior underneath. Proximity resolves
    // the closest mark to the cursor instead of requiring pointer precision.
    const overlay = svg.append('rect')
      .attr('class', 'sankey-overlay')
      .attr('width', width).attr('height', height)
      .attr('fill', 'transparent')
      .attr('aria-hidden', 'true');
    const clearHover = (): void => {
      const focused = document.activeElement?.closest('[data-hit]');
      if (focused && host.contains(focused)) { highlightFor(focused); panel.showKey(nodeIdOf(focused)); }
      else { clearHighlight(); panel.showKey(null); }
    };
    overlay.on('pointermove', (ev: PointerEvent) => {
      // Keyboard focus beats proximity: while a mark holds focus, pointer moves
      // keep highlighting the focused mark.
      const focused = document.activeElement?.closest('[data-hit]');
      if (focused && host.contains(focused)) { highlightFor(focused); panel.showKey(nodeIdOf(focused)); return; }
      const [x, y] = d3.pointer(ev, layer.node()); // zoom-layer coords — survives pan/zoom
      const t = targets[delaunay.find(x, y)]!;
      // Inside the rect the nearest mark always resolves and highlights — the
      // rect's bounds are the only gate (Voronoi cells tile the whole canvas).
      highlightFor(t.el);
      if (t.kind === 'node') panel.showKey(t.key); // links highlight only; panel untouched
    });
    overlay.on('pointerleave', () => clearHover());

    // Pan/zoom: drag to pan, ctrl/⌘+wheel or pinch to zoom (plain wheel keeps scrolling the page).
    zoom = d3.zoom<SVGSVGElement, undefined>()
      .scaleExtent([0.5, 8])
      .filter((ev: Event) => {
        if (ev.type === 'wheel') return (ev as WheelEvent).ctrlKey || (ev as WheelEvent).metaKey;
        return !(ev as MouseEvent).button;
      })
      .on('zoom', (ev: d3.D3ZoomEvent<SVGSVGElement, undefined>) => { layer.attr('transform', ev.transform.toString()); });
    svg.call(zoom);
    svg.on('dblclick.zoom', null);

    makeRoving(host, '[data-hit]');
    // Metric changes relabel the panel rows; re-render for the current state (no animation).
    panel.refresh();
  };

  // Highlight on keyboard focus (delegated once on the persistent host; redraws replace
  // only the SVG). Pointer interaction lives on the draw()'s proximity overlay; pointer
  // moves no longer require mark-precise hit-testing. The info panel follows the same
  // marks: nodes swap its content, links leave it alone.
  const nodeIdOf = (mark: Element | null): string | null =>
    mark?.getAttribute('data-hit') === 'node' ? mark.getAttribute('data-key') : null;
  host.addEventListener('pointerover', (e) => { const t = (e.target as Element).closest('[data-hit]'); if (t) highlightFor(t); panel.showKey(nodeIdOf(t)); });
  host.addEventListener('pointerout', (e) => {
    // Leaving a mark clears the hover highlight unless a mark holds keyboard focus (focus wins).
    const t = (e.target as Element).closest('[data-hit]');
    const focused = document.activeElement?.closest('[data-hit]');
    if (t && (!focused || !host.contains(focused))) clearHighlight();
    else if (focused) highlightFor(focused);
    // Panel: when the pointer moves onto another node, pointerover swaps it in — skipping
    // here avoids a default-view flash between adjacent marks; otherwise the keyboard-focused
    // mark wins, and with neither, the panel reverts to the origin node.
    const to = (e as PointerEvent).relatedTarget as Element | null;
    if (nodeIdOf(to?.closest('[data-hit]') ?? null) === null) panel.showKey(nodeIdOf(focused ?? null));
  });
  host.addEventListener('focusin', (e) => { const t = (e.target as Element).closest('[data-hit]'); if (t) highlightFor(t); panel.showKey(nodeIdOf(t)); });
  host.addEventListener('focusout', (e) => {
    const nx = e.relatedTarget as Element | null;
    if (!nx || !nx.closest('[data-hit]')) clearHighlight();
    // Focus landing on a non-node mark (or nowhere) leaves no node to show → default view;
    // node → node transitions are handled by focusin on the next mark.
    if (nodeIdOf(nx?.closest('[data-hit]') ?? null) === null) panel.showKey(null);
  });

  const zoomTo = (t: d3.ZoomTransform): void => {
    if (!zoom || !svgSel) return;
    const sel = prefersReducedMotion() ? svgSel : svgSel.transition().duration(250) as unknown as typeof svgSel;
    zoom.transform(sel, t);
  };
  const scaleBy = (k: number): void => {
    if (!zoom || !svgSel) return;
    const sel = prefersReducedMotion() ? svgSel : svgSel.transition().duration(200) as unknown as typeof svgSel;
    zoom.scaleBy(sel, k);
  };
  zoomIn.onclick = () => scaleBy(1.4);
  zoomOut.onclick = () => scaleBy(1 / 1.4);
  zoomReset.onclick = () => zoomTo(d3.zoomIdentity);
  zoomFit.onclick = () => {
    if (!contentBox.w || !contentBox.h) return;
    const pad = 12;
    const k = Math.min(8, Math.max(0.5, Math.min((viewport.w - 2 * pad) / contentBox.w, (viewport.h - 2 * pad) / contentBox.h)));
    const tx = (viewport.w - k * contentBox.w) / 2 - k * contentBox.x;
    const ty = (viewport.h - k * contentBox.h) / 2 - k * contentBox.y;
    zoomTo(d3.zoomIdentity.translate(tx, ty).scale(k));
  };
  metricSelect.onchange = () => {
    metric = metricSelect.value === 'prompt' ? 'prompt' : 'context';
    if (lastWidth) draw(lastWidth);
  };



  onResize(container, draw);
}
