import * as d3 from 'd3';
import type { LoopNode, LoopsDataset, TurnStat } from '../types';
import { collectThreads } from '../data';
import { agentColor, fmtInt, fmtTime } from '../format';
import { nodeTip, tooltip, type TipContent } from '../tooltip';
import { costOf, fmtCost, fmtRate, onRatesChange, rateFor } from '../cost';
import { el } from '../util';

/**
 * Summary panel from `stats`: per-agent totals, per-tool totals (with inline
 * bars so sizes are visible, not only numeric), and the turns table. Each turn
 * row is hover/focusable and shows the user prompt that opened the turn.
 * Plain HTML tables are the accessible alternative to the SVG views.
 */
export function renderSummary(container: HTMLElement, ds: LoopsDataset): void {
  container.replaceChildren();
  const { agents, tools, turns } = ds.stats;

  // Index turn → its opening user message node, for hover text.
  const turnNodes = new Map<string, { turn: LoopNode; prompt: LoopNode | undefined }>();
  for (const [tid, t] of collectThreads(ds.hierarchy)) {
    for (const turn of t.thread.children ?? []) {
      if (turn.kind !== 'turn') continue;
      const ti = turn.meta?.turnIndex ?? (t.thread.children ?? []).indexOf(turn);
      turnNodes.set(`${tid}#${ti}`, { turn, prompt: turn.children?.find((c) => c.kind === 'user-message') });
    }
  }

  const totals = {
    chars: d3.sum(agents, (a) => a.chars), tokens: d3.sum(agents, (a) => a.tokensEst),
    toolCalls: d3.sum(tools, (t) => t.calls), errors: d3.sum(tools, (t) => t.errors),
  };
  const kpis = el('div', { class: 'kpis' });
  const kpi = (label: string, value: string, sub?: string) => el('div', { class: 'kpi' }, el('div', { class: 'kpi-value' }, value), el('div', { class: 'kpi-label' }, label), ...(sub ? [el('div', { class: 'muted small' }, sub)] : []));
  kpis.append(
    kpi('threads', fmtInt(ds.source.threadIds.length), `${fmtInt(ds.source.messageCount)} messages`),
    kpi('turns', fmtInt(turns.length), `${fmtInt(d3.sum(turns, (t) => t.steps))} steps`),
    kpi('tool calls', fmtInt(totals.toolCalls), `${fmtInt(totals.errors)} errors`),
    kpi('characters', fmtInt(totals.chars), `≈${fmtInt(totals.tokens)} tokens (est.)`),
    kpi('cost (est.)', fmtCost(d3.sum(agents, (a) => costOf(a.tokensEst, a.agent))), `assumed rate (${fmtRate(rateFor(undefined))} default) — not provider data`),
    kpi('largest context', fmtInt(d3.max(turns, (t) => t.contextCharsAtEnd) ?? 0), 'chars at end of a turn'),
  );
  container.append(kpis);

  // Per-agent table
  const maxAgentChars = d3.max(agents, (a) => a.chars) ?? 1;
  container.append(el('h3', {}, 'Per agent'));
  container.append(table(
    ['agent', 'threads', 'turns', 'tool calls', 'chars', 'tokens (est.)', 'cost (est.)'],
    agents.map((a) => [
      el('span', {}, el('i', { class: 'swatch', style: `--c:${agentColor(a.agent)}` }), a.agent),
      fmtInt(a.threads), fmtInt(a.turns), fmtInt(a.toolCalls), bar(a.chars, maxAgentChars, agentColor(a.agent)), fmtInt(a.tokensEst), fmtCost(costOf(a.tokensEst, a.agent)),
    ]),
  ));

  // Per-tool table
  const maxToolChars = d3.max(tools, (t) => t.promptChars + t.resultChars) ?? 1;
  container.append(el('h3', {}, 'Per tool'));
  container.append(table(
    ['tool', 'calls', 'prompt chars (args)', 'result chars', 'errors'],
    [...tools].sort((a, b) => b.calls - a.calls).map((t) => [
      el('code', {}, t.toolName), fmtInt(t.calls), bar(t.promptChars, maxToolChars, '#0f766e'), bar(t.resultChars, maxToolChars, '#0369a1'),
      t.errors ? el('span', { class: 'is-error' }, `✗ ${fmtInt(t.errors)}`) : '0',
    ]),
  ));

  // Turns table (rows hover/focusable → user prompt text)
  container.append(el('h3', {}, 'Turns'));
  const maxCtx = d3.max(turns, (t) => t.contextCharsAtEnd) ?? 1;
  const turnRows = [...turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const tbl = table(
    ['turn', 'agent', 'started', 'steps', 'tool calls', 'chars', 'tokens (est.)', 'cost (est.)', 'context at end', 'user prompt chars'],
    turnRows.map((t) => [
      `${t.threadId} #${t.turnIndex + 1}`,
      el('span', {}, el('i', { class: 'swatch', style: `--c:${agentColor(t.agent)}` }), t.agent),
      fmtTime(t.startedAt), fmtInt(t.steps), fmtInt(t.toolCalls), fmtInt(t.chars), fmtInt(t.tokensEst), fmtCost(costOf(t.tokensEst, t.agent)),
      bar(t.contextCharsAtEnd, maxCtx, agentColor(t.agent)), fmtInt(t.userPromptChars),
    ]),
    (tr, i) => {
      const t = turnRows[i] as TurnStat;
      tr.setAttribute('data-tip', 'turn'); tr.setAttribute('data-key', `${t.threadId}#${t.turnIndex}`);
      tr.setAttribute('tabindex', '0');
    },
  );
  container.append(tbl);
  tooltip().attach(tbl, (tr): TipContent | null => {
    const key = tr.getAttribute('data-key') ?? '';
    const t = turnRows.find((x) => `${x.threadId}#${x.turnIndex}` === key); if (!t) return null;
    const found = turnNodes.get(key);
    const rows: [string, string][] = [
      ['thread', t.threadId], ['agent', t.agent], ['started', fmtTime(t.startedAt)], ['ended', fmtTime(t.endedAt)],
      ['steps', fmtInt(t.steps)], ['tool calls', fmtInt(t.toolCalls)], ['chars', fmtInt(t.chars)], ['tokens (est.)', `≈${fmtInt(t.tokensEst)}`],
      ['cost (est., assumed rate)', `${fmtCost(costOf(t.tokensEst, t.agent))} · ${fmtRate(rateFor(t.agent))}`],
      ['context at end', `${fmtInt(t.contextCharsAtEnd)} chars`], ['user prompt', `${fmtInt(t.userPromptChars)} chars`],
    ];
    if (found?.prompt) {
      const tip = nodeTip(found.prompt, rows);
      tip.title = found.turn.name; tip.badges = [{ text: 'turn' }, { text: t.agent }];
      if (tip.text) tip.text.label = 'User prompt that opened this turn';
      return tip;
    }
    return { title: `${t.threadId} · turn ${t.turnIndex + 1}`, badges: [{ text: 'turn' }, { text: t.agent }], rows };
  });

  // Memory facts, if the pipeline attached them (hierarchy.meta.memory is an extension beyond SCHEMA.md; rendered defensively).
  const mem = ds.hierarchy.meta?.memory;
  if (Array.isArray(mem) && mem.length) {
    container.append(el('h3', {}, `Memory facts attached to the project (${fmtInt(mem.length)})`));
    const ul = el('ul', { class: 'facts' });
    for (const f of mem) {
      const rec = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
      const text = typeof rec.content === 'string' ? rec.content : JSON.stringify(f);
      const cat = typeof rec.category === 'string' ? rec.category : undefined;
      ul.append(el('li', {}, ...(cat ? [el('span', { class: 'badge' }, cat), ' '] : []), text));
    }
    container.append(ul);
  }

  onRatesChange(container, () => renderSummary(container, ds));
}

function bar(value: number, max: number, color: string): HTMLElement {
  const pct = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return el('span', { class: 'bar-cell' }, el('i', { class: 'bar', style: `--w:${pct}%;--c:${color}`, 'aria-hidden': 'true' }), el('span', {}, fmtInt(value)));
}

function table(head: string[], rows: (string | Node)[][], rowHook?: (tr: HTMLTableRowElement, i: number) => void): HTMLTableElement {
  const t = el('table', { class: 'data' });
  const thead = el('thead'); const trh = el('tr');
  for (const h of head) trh.append(el('th', { scope: 'col' }, h));
  thead.append(trh); t.append(thead);
  const tb = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr');
    r.forEach((c, j) => tr.append(el(j === 0 ? 'th' : 'td', j === 0 ? { scope: 'row' } : {}, c)));
    rowHook?.(tr, i);
    tb.append(tr);
  });
  t.append(tb);
  return t;
}
