import * as d3 from 'd3';
import type { LoopModelLoop, LoopPhase, LoopsDataset } from '../types';
import { el, makeRoving, onResize } from '../util';

/**
 * The five canonical loops from `loopModel`, each drawn as a directed cycle:
 * phases on a circle, `next`/`exit` edges as arcs between phases, `repeat`
 * edges (back to an earlier phase or to self) as dashed loops. Clearly labelled
 * "documented model" — the observed data lives in the other views; each phase's
 * aria-label carries its description.
 */
export function renderLoopModel(container: HTMLElement, ds: LoopsDataset): void {
  container.replaceChildren();
  const loops = ds.loopModel.loops;
  container.append(el('p', { class: 'view-note' },
    el('strong', {}, 'Documented model, not observed data. '),
    `These ${loops.length} cycles come from loopModel in the dataset (Obvious's documented turn, delegation, skill, memory and human-in-the-loop loops). `,
    `Solid arrows = next / exit; dashed arrows = repeat.`));
  const grid = el('div', { class: 'multiples loops-grid' });
  container.append(grid);

  for (const loop of loops) {
    const fig = el('figure', { class: 'multiple loop-card' });
    fig.append(el('figcaption', {}, el('span', { class: 'badge badge-doc' }, 'documented'), ' ', el('strong', {}, loop.name), el('div', { class: 'muted small' }, loop.description)));
    const host = el('div', { class: 'chart-host', role: 'group', 'aria-label': `${loop.name} loop; arrow keys move between phases and edges` });
    fig.append(host);
    grid.append(fig);

    onResize(host, (w) => drawLoop(host, loop, Math.max(240, w)));
  }
}

function drawLoop(host: HTMLElement, loop: LoopModelLoop, width: number): void {
  host.replaceChildren();
  const n = loop.phases.length;
  const size = Math.min(width, 420);
  const cx = width / 2, cy = size / 2;
  const R = size / 2 - 58;
  const nodeR = 22;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pos = (i: number) => ({ x: cx + R * Math.cos(angle(i)), y: cy + R * Math.sin(angle(i)) });
  const idx = new Map(loop.phases.map((p, i) => [p.id, i]));

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${size}`).attr('width', width).attr('height', size)
    .attr('role', 'img').attr('aria-label', `${loop.name}: ${n} phases, ${loop.edges.length} edges`);
  svg.append('title').text(`${loop.name} (documented model)`);
  const defs = svg.append('defs');
  for (const k of ['next', 'repeat', 'exit']) {
    defs.append('marker').attr('id', `lm-arrow-${k}`).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', `lm-arrowhead is-${k}`);
  }

  // Edges
  const edgeG = svg.append('g').attr('fill', 'none');
  edgeG.selectAll<SVGPathElement, { e: LoopModelLoop['edges'][number]; i: number }>('path')
    .data(loop.edges.map((e, i) => ({ e, i }))).join('path')
    .attr('class', (d) => `lm-edge is-${d.e.kind}`)
    .attr('marker-end', (d) => `url(#lm-arrow-${d.e.kind})`)
    .attr('d', (d) => {
      const a = idx.get(d.e.from) ?? 0, b = idx.get(d.e.to) ?? 0;
      const p = pos(a), q = pos(b);
      if (a === b) {
        // self-loop: small circle outside the node
        const ang = angle(a);
        return `M${p.x + nodeR * Math.cos(ang - 0.6)},${p.y + nodeR * Math.sin(ang - 0.6)} A16,16 0 1,1 ${p.x + nodeR * Math.cos(ang + 0.6)},${p.y + nodeR * Math.sin(ang + 0.6)}`;
      }
      // Curve bulging outward for forward edges, inward (through the middle) for repeat edges
      const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy);
      const ux = dx / dist, uy = dy / dist;
      const sx = p.x + ux * nodeR, sy = p.y + uy * nodeR, tx = q.x - ux * (nodeR + 2), ty = q.y - uy * (nodeR + 2);
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      const toCenter = { x: cx - mx, y: cy - my }; const len = Math.hypot(toCenter.x, toCenter.y) || 1;
      const bulge = d.e.kind === 'repeat' ? 0.55 : -0.25;
      const cxp = mx + (toCenter.x / len) * dist * bulge, cyp = my + (toCenter.y / len) * dist * bulge;
      return `M${sx},${sy} Q${cxp},${cyp} ${tx},${ty}`;
    })
    .attr('data-hit', 'edge').attr('data-key', (d) => String(d.i))
    .attr('tabindex', -1).attr('role', 'button')
    .attr('aria-label', (d) => `${d.e.kind} edge from ${loop.phases[idx.get(d.e.from) ?? 0]?.name ?? d.e.from} to ${loop.phases[idx.get(d.e.to) ?? 0]?.name ?? d.e.to}${d.e.label ? `, ${d.e.label}` : ''}`);
  // Edge labels (repeat edges only, to keep the diagram readable)
  svg.append('g').selectAll('text').data(loop.edges.filter((e) => e.kind !== 'next' && e.label)).join('text')
    .attr('class', 'lm-edge-label')
    .attr('x', (e) => { const p = pos(idx.get(e.from) ?? 0), q = pos(idx.get(e.to) ?? 0); return (p.x + q.x) / 2 + (cx - (p.x + q.x) / 2) * (e.kind === 'repeat' ? 0.45 : -0.3); })
    .attr('y', (e) => { const p = pos(idx.get(e.from) ?? 0), q = pos(idx.get(e.to) ?? 0); return (p.y + q.y) / 2 + (cy - (p.y + q.y) / 2) * (e.kind === 'repeat' ? 0.45 : -0.3); })
    .attr('text-anchor', 'middle').text((e) => e.label ?? '');

  // Phases
  const node = svg.append('g').selectAll<SVGGElement, LoopPhase>('g').data(loop.phases).join('g')
    .attr('class', 'lm-phase')
    .attr('transform', (_, i) => `translate(${pos(i).x},${pos(i).y})`)
    .attr('data-hit', 'phase').attr('data-key', (p) => p.id)
    .attr('tabindex', -1).attr('role', 'button')
    .attr('aria-label', (p) => `${p.name}: ${p.description}`);
  node.append('circle').attr('r', nodeR);
  node.append('text').attr('class', 'lm-num').attr('dy', '0.35em').attr('text-anchor', 'middle').text((_, i) => String(i + 1));
  node.append('text').attr('class', 'lm-label').attr('text-anchor', 'middle')
    .attr('y', (_, i) => (Math.sin(angle(i)) >= 0 ? nodeR + 14 : -nodeR - 6))
    .text((p) => p.name);

  host.append(svg.node()!);
  makeRoving(host, '[data-hit]');
}
