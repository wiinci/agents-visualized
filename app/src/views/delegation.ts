import * as d3 from 'd3';
import type { LoopNode, LoopsDataset } from '../types';
import { fmtCompact, fmtInt, nodeAriaLabel, statusColor, statusGlyph } from '../format';
import { nodeTip, tooltip } from '../tooltip';
import { withCostRow } from '../cost';
import { el, makeRoving, onResize } from '../util';

type TNode = d3.HierarchyPointNode<LoopNode>;

/**
 * Left-to-right d3.tree of the delegation hierarchy: root task → subtasks →
 * worker threads. Node colour = status (with a text glyph so colour is not the
 * only cue); node radius = prompt size (chars) so delegation prompt bulk is in
 * the encoding. Hover/focus shows title, assignee, status, prompt size and the
 * full prompt text.
 */
export function renderDelegation(container: HTMLElement, ds: LoopsDataset): void {
  container.replaceChildren();
  const root = d3.hierarchy<LoopNode>(ds.delegation);
  const all = root.descendants();
  const statuses = Array.from(new Set(all.map((d) => d.data.meta?.status).filter((s): s is string => !!s)));

  const note = el('p', { class: 'view-note' },
    `Observed delegation: ${fmtInt(all.length)} nodes (${fmtInt(all.filter((d) => d.data.kind === 'task').length)} tasks, ${fmtInt(all.filter((d) => d.data.kind === 'worker-thread').length)} worker threads). `,
    `Circle area = prompt size in chars (task description or dispatch prompt); colour + glyph = status.`);
  const legend = el('div', { class: 'legend', role: 'list', 'aria-label': 'Status colours' });
  for (const s of statuses) legend.append(el('span', { class: 'legend-item', role: 'listitem' }, el('i', { class: 'swatch', style: `--c:${statusColor(s)}` }), `${statusGlyph(s)} ${s}`));
  legend.append(el('span', { class: 'legend-item', role: 'listitem' }, el('i', { class: 'swatch swatch-ring' }), 'worker thread'));
  const host = el('div', { class: 'chart-host', role: 'group', 'aria-label': 'Delegation tree; arrow keys move between tasks and worker threads' });
  container.append(note, legend, host);

  const byId = new Map(all.map((d) => [d.data.id, d.data]));
  const promptOf = (n: LoopNode): number => n.meta?.promptChars ?? n.meta?.chars ?? 0;
  const r = d3.scaleSqrt().domain([0, d3.max(all, (d) => promptOf(d.data)) ?? 1]).range([5, 22]);

  const draw = (width: number): void => {
    host.replaceChildren();
    const leaves = Math.max(1, root.leaves().length);
    const height = Math.max(240, Math.min(900, leaves * 64 + 60));
    const m = { top: 24, right: 220, bottom: 24, left: 40 };
    const tree = d3.tree<LoopNode>().size([height - m.top - m.bottom, width - m.left - m.right]).separation((a, b) => (a.parent === b.parent ? 1 : 1.3));
    const laid = tree(root);

    const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height)
      .attr('role', 'img').attr('aria-label', 'Delegation tree from root task to subtasks to worker threads');
    svg.append('title').text('Delegation tree (observed)');
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

    g.append('g').attr('fill', 'none').attr('class', 'tree-links')
      .selectAll('path').data(laid.links()).join('path')
      .attr('class', (d) => `tree-link${d.target.data.kind === 'worker-thread' ? ' is-dispatch' : ''}`)
      .attr('d', (d) => {
        if (d.target.data.kind === 'worker-thread') {
          // Dispatch edges dip below the label row so they don't strike through the task text.
          const sx = d.source.y, sy = d.source.x, tx = d.target.y, ty = d.target.x;
          const dip = 26;
          return `M${sx},${sy} C${sx + 40},${sy + dip} ${tx - 40},${ty + dip} ${tx},${ty}`;
        }
        return d3.linkHorizontal<d3.HierarchyPointLink<LoopNode>, TNode>().x((n) => n.y).y((n) => n.x)(d) ?? '';
      });

    const node = g.append('g').selectAll<SVGGElement, TNode>('g').data(laid.descendants()).join('g')
      .attr('class', 'tree-node')
      .attr('transform', (d) => `translate(${d.y},${d.x})`)
      .attr('data-tip', 'node').attr('data-key', (d) => d.data.id)
      .attr('tabindex', -1).attr('role', 'button')
      .attr('aria-label', (d) => `${nodeAriaLabel(d.data)}, prompt ${fmtInt(promptOf(d.data))} characters`);
    node.append('circle')
      .attr('r', (d) => r(promptOf(d.data)))
      .attr('fill', (d) => (d.data.kind === 'worker-thread' ? 'var(--bg)' : statusColor(d.data.meta?.status)))
      .attr('stroke', (d) => statusColor(d.data.meta?.status))
      .attr('stroke-width', (d) => (d.data.kind === 'worker-thread' ? 3 : 1.5));
    node.append('text').attr('class', 'tree-glyph').attr('dy', '0.35em').attr('text-anchor', 'middle')
      .attr('fill', (d) => (d.data.kind === 'worker-thread' ? statusColor(d.data.meta?.status) : '#fff'))
      .text((d) => statusGlyph(d.data.meta?.status));
    const lab = node.append('text').attr('class', 'tree-label').attr('x', (d) => r(promptOf(d.data)) + 6).attr('dy', '-0.1em');
    lab.append('tspan').text((d) => (d.data.name.length > 34 ? `${d.data.name.slice(0, 33)}…` : d.data.name));
    lab.append('tspan').attr('class', 'tree-sub').attr('x', (d) => r(promptOf(d.data)) + 6).attr('dy', '1.2em')
      .text((d) => [d.data.kind, d.data.meta?.assignee, `${fmtCompact(promptOf(d.data))} chars`].filter(Boolean).join(' · '));

    host.append(svg.node()!);
    makeRoving(host, '[data-tip]');
  };

  tooltip().attach(host, (t) => {
    const n = byId.get(t.getAttribute('data-key') ?? '');
    if (!n) return null;
    const tip = withCostRow(nodeTip(n, [['children', fmtInt(n.children?.length ?? 0)]]), n.meta?.tokensEst, n.meta?.agent);
    if (tip.text) tip.text.label = n.kind === 'worker-thread' ? 'Dispatch prompt (worker\u2019s first user message)' : 'Task description / prompt';
    return tip;
  });
  onResize(container, draw);
}
