import * as d3 from 'd3';
import type { LoopNode, LoopsDataset, NodeKind } from '../types';
import { agentColor, fmtCompact, fmtInt, nodeAriaLabel } from '../format';
import { nodeTip, tooltip } from '../tooltip';
import { withCostRow } from '../cost';
import { el, makeRoving, onResize, prefersReducedMotion } from '../util';

type HNode = d3.HierarchyRectangularNode<LoopNode>;

const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['project', 'thread', 'worker-thread', 'turn']);

/**
 * Horizontal icicle (d3.partition): depth runs left→right (project → thread →
 * turn → step → nested worker thread…), and each node's height is its size in
 * characters, so context/prompt bulk is visible in the encoding, not only in
 * tooltips. Colour = agent. Zoom via the pinned tooltip's "Zoom here" action,
 * so click stays reserved for pinning the details panel.
 */
export function renderHierarchy(container: HTMLElement, ds: LoopsDataset): void {
  container.replaceChildren();
  const root = d3.hierarchy<LoopNode>(ds.hierarchy)
    // containers carry sums already; only count nodes that own text so nothing is double-counted
    .sum((d) => (CONTAINER_KINDS.has(d.kind) ? 0 : Math.max(1, d.meta?.chars ?? d.value ?? 0)))
    .sort((a, b) => (a.data.meta?.stepIndex ?? 0) - (b.data.meta?.stepIndex ?? 0) || (a.data.meta?.turnIndex ?? 0) - (b.data.meta?.turnIndex ?? 0));

  const agents = Array.from(new Set(root.descendants().map((d) => d.data.meta?.agent).filter((a): a is string => !!a)));
  const legend = el('div', { class: 'legend', role: 'list', 'aria-label': 'Agent colours' });
  for (const a of agents) legend.append(el('span', { class: 'legend-item', role: 'listitem' }, el('i', { class: 'swatch', style: `--c:${agentColor(a)}` }), a));

  const controls = el('div', { class: 'toolbar' });
  const resetBtn = el('button', { type: 'button', class: 'btn' }, 'Reset zoom');
  const crumb = el('span', { class: 'muted', 'aria-live': 'polite' }, 'Showing: whole project');
  controls.append(resetBtn, crumb);

  const note = el('p', { class: 'view-note' },
    `Icicle of ${fmtInt(root.descendants().length)} nodes. Width steps = depth (project → thread → turn → step; worker threads nest under the turn that dispatched them). `,
    `Height = characters of text/JSON. Colour = agent. Every cell is hover- and focusable; pin it to read the full text or zoom in.`);
  const host = el('div', { class: 'chart-host', role: 'group', 'aria-label': 'Turn hierarchy icicle; arrow keys move between cells' });
  container.append(note, legend, controls, host);

  let focusNode: HNode | null = null;
  let lastWidth = 0;

  const draw = (width: number): void => {
    lastWidth = width;
    host.replaceChildren();
    const maxDepth = root.height;
    const colW = Math.max(120, Math.min(220, (width - 8) / (maxDepth + 1)));
    const height = Math.max(520, Math.min(1400, root.leaves().length * 5));
    const partition = d3.partition<LoopNode>().size([height, colW * (maxDepth + 1)]).padding(1);
    const laid = partition(root as d3.HierarchyNode<LoopNode>);
    const zoomRoot = focusNode ?? laid;

    // Zoom: rescale y (size) to the focused node's extent and x (depth) so focus sits at column 0
    const y = d3.scaleLinear().domain([zoomRoot.x0, zoomRoot.x1]).range([0, height]);
    const xShift = zoomRoot.y0;

    const svg = d3.create('svg')
      .attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height)
      .attr('role', 'img').attr('aria-label', 'Icicle of project, threads, turns and steps sized by characters');
    svg.append('title').text('Turn hierarchy (icicle, sized by chars)');

    const visible = laid.descendants().filter((d) => d.x1 > zoomRoot.x0 && d.x0 < zoomRoot.x1 && d.y0 >= xShift && d.y0 - xShift < width);
    const cell = svg.append('g').selectAll<SVGGElement, HNode>('g').data(visible).join('g')
      .attr('class', 'ic-cell')
      .attr('transform', (d) => `translate(${d.y0 - xShift},${y(Math.max(d.x0, zoomRoot.x0))})`)
      .attr('data-tip', 'node').attr('data-key', (d) => d.data.id)
      .attr('tabindex', -1).attr('role', 'button')
      .attr('aria-label', (d) => nodeAriaLabel(d.data));
    cell.append('rect')
      .attr('width', (d) => Math.max(1, d.y1 - d.y0 - 1))
      .attr('height', (d) => Math.max(1, y(Math.min(d.x1, zoomRoot.x1)) - y(Math.max(d.x0, zoomRoot.x0)) - 1))
      .attr('fill', (d) => agentColor(d.data.meta?.agent))
      .attr('fill-opacity', (d) => (CONTAINER_KINDS.has(d.data.kind) ? 0.35 : d.data.kind === 'reasoning' ? 0.6 : d.data.kind === 'tool-result' ? 0.75 : 0.9))
      .attr('rx', 2);
    const label = cell.append('text').attr('x', 6).attr('y', 14).attr('class', 'ic-label');
    label.append('tspan').text((d) => d.data.name.length > 28 ? `${d.data.name.slice(0, 27)}…` : d.data.name);
    label.append('tspan').attr('class', 'ic-sub').attr('x', 6).attr('dy', 14).text((d) => `${fmtCompact(d.data.meta?.chars ?? d.value ?? 0)} chars${d.data.meta?.contextChars !== undefined ? ` · ctx ${fmtCompact(d.data.meta.contextChars)}` : ''}`);
    // Hide labels on cells too small to hold them (keeps SVG legible; tooltip still carries everything)
    label.style('display', (d) => (y(Math.min(d.x1, zoomRoot.x1)) - y(Math.max(d.x0, zoomRoot.x0)) < 30 || d.y1 - d.y0 < 70 ? 'none' : null));

    host.append(svg.node()!);
    makeRoving(host, '[data-tip]');
    crumb.textContent = `Showing: ${zoomRoot === laid ? 'whole project' : zoomRoot.ancestors().reverse().map((a) => a.data.name).join(' › ')}`;
  };

  const byId = new Map<string, HNode>();
  root.each((d) => byId.set(d.data.id, d as HNode));
  const zoomTo = (n: HNode | null) => {
    focusNode = n && n.children ? n : n ? (n.parent as HNode | null) : null;
    tooltip().hide();
    if (!prefersReducedMotion()) host.classList.add('is-fading');
    requestAnimationFrame(() => { draw(lastWidth); host.classList.remove('is-fading'); });
  };
  resetBtn.addEventListener('click', () => zoomTo(null));

  tooltip().attach(host, (t) => {
    const n = byId.get(t.getAttribute('data-key') ?? '');
    if (!n) return null;
    const extra: [string, string][] = [
      ['depth', String(n.depth)],
      ['descendants', fmtInt(n.descendants().length - 1)],
      ['path', n.ancestors().reverse().map((a) => a.data.name).join(' › ')],
    ];
    const actions = n.children ? [{ label: 'Zoom here', onClick: () => zoomTo(n) }] : n.parent ? [{ label: 'Zoom to parent', onClick: () => zoomTo(n.parent as HNode) }] : [];
    return withCostRow(nodeTip(n.data, extra, actions), n.data.meta?.tokensEst, n.data.meta?.agent);
  });

  onResize(container, draw);
}
