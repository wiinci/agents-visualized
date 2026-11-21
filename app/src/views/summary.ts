import * as d3 from 'd3'
import type {LoopNode, LoopsDataset} from '../types'
import {collectThreads, turnKey} from '../data'
import {agentColor, fmtInt, fmtTime} from '../format'
import {costOf, fmtCost, fmtRate, onRatesChange, rateFor} from '../cost'
import {el} from '../util'
import {createInfoPanel, nodePanel, wireInfoPanel} from '../panel'

/**
 * Summary panel from `stats`: per-agent totals, per-tool totals (with inline
 * bars so sizes are visible, not only numeric), and the turns table. Hovering
 * or focusing a turn row swaps the info panel to that turn (default: overall
 * totals). Plain HTML tables are the accessible alternative to the SVG views.
 */
export function renderSummary(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	const {agents, tools, turns} = ds.stats

	// Index turn → its opening user message node, for the info panel's prompt text.
	const turnNodes = new Map<
		string,
		{turn: LoopNode; prompt: LoopNode | undefined}
	>()
	for (const [tid, t] of collectThreads(ds.hierarchy)) {
		for (const turn of t.thread.children ?? []) {
			if (turn.kind !== 'turn') continue
			const ti = turn.meta?.turnIndex ?? (t.thread.children ?? []).indexOf(turn)
			turnNodes.set(turnKey(tid, ti), {
				turn,
				prompt: turn.children?.find(c => c.kind === 'user-message'),
			})
		}
	}

	const totals = {
		chars: d3.sum(agents, a => a.chars),
		tokens: d3.sum(agents, a => a.tokensEst),
		toolCalls: d3.sum(tools, t => t.calls),
		errors: d3.sum(tools, t => t.errors),
	}
	const kpis = el('div', {class: 'kpis'})
	const kpi = (label: string, value: string, sub?: string) =>
		el(
			'div',
			{class: 'kpi'},
			el('div', {class: 'kpi-value'}, value),
			el('div', {class: 'kpi-label'}, label),
			...(sub ? [el('div', {class: 'muted small'}, sub)] : []),
		)
	kpis.append(
		kpi(
			'threads',
			fmtInt(ds.source.threadIds.length),
			`${fmtInt(ds.source.messageCount)} messages`,
		),
		kpi(
			'turns',
			fmtInt(turns.length),
			`${fmtInt(d3.sum(turns, t => t.steps))} steps`,
		),
		kpi(
			'tool calls',
			fmtInt(totals.toolCalls),
			`${fmtInt(totals.errors)} errors`,
		),
		kpi(
			'characters',
			fmtInt(totals.chars),
			`≈${fmtInt(totals.tokens)} tokens (est.)`,
		),
		kpi(
			'cost (est.)',
			fmtCost(d3.sum(agents, a => costOf(a.tokensEst, a.agent))),
			`assumed rate (${fmtRate(rateFor(undefined))} default) — not provider data`,
		),
		kpi(
			'largest context',
			fmtInt(d3.max(turns, t => t.contextCharsAtEnd) ?? 0),
			'chars at end of a turn',
		),
	)
	container.append(kpis)

	// Per-agent table
	const maxAgentChars = d3.max(agents, a => a.chars) ?? 1
	container.append(el('h3', {}, 'Per agent'))
	container.append(
		table(
			[
				'agent',
				'threads',
				'turns',
				'tool calls',
				'chars',
				'tokens (est.)',
				'cost (est.)',
			],
			agents.map(a => [
				el(
					'span',
					{},
					el('i', {class: 'swatch', style: `--c:${agentColor(a.agent)}`}),
					a.agent,
				),
				fmtInt(a.threads),
				fmtInt(a.turns),
				fmtInt(a.toolCalls),
				bar(a.chars, maxAgentChars, agentColor(a.agent)),
				fmtInt(a.tokensEst),
				fmtCost(costOf(a.tokensEst, a.agent)),
			]),
		),
	)

	// Per-tool table
	const maxToolChars = d3.max(tools, t => t.promptChars + t.resultChars) ?? 1
	container.append(el('h3', {}, 'Per tool'))
	container.append(
		table(
			['tool', 'calls', 'prompt chars (args)', 'result chars', 'errors'],
			[...tools]
				.sort((a, b) => b.calls - a.calls)
				.map(t => [
					el('code', {}, t.toolName),
					fmtInt(t.calls),
					bar(t.promptChars, maxToolChars, '#0f766e'),
					bar(t.resultChars, maxToolChars, '#0369a1'),
					t.errors
						? el('span', {class: 'is-error'}, `✗ ${fmtInt(t.errors)}`)
						: '0',
				]),
		),
	)

	// Turns table
	container.append(el('h3', {}, 'Turns'))
	const maxCtx = d3.max(turns, t => t.contextCharsAtEnd) ?? 1
	const turnRows = [...turns].sort((a, b) =>
		a.startedAt.localeCompare(b.startedAt),
	)

	// Per-turn context trajectory: per-step meta.contextChars for that turn's
	// steps, via the collect traversal (thread → turn → step). Keyed like the
	// info panel (`threadId#turnIndex`). A turn with no step-level context data
	// has no series — the sparkline cell renders an em dash, never an empty box.
	const turnCtx = new Map<string, number[]>()
	for (const [tid, t] of collectThreads(ds.hierarchy)) {
		const kids = t.thread.children ?? []
		for (const turn of kids) {
			if (turn.kind !== 'turn') continue
			const ti = turn.meta?.turnIndex ?? kids.indexOf(turn)
			const series = t.steps
				.filter(s => s.turn === turn && s.node.meta?.contextChars !== undefined)
				.map(s => s.node.meta?.contextChars ?? 0)
			turnCtx.set(turnKey(tid, ti), series)
		}
	}

	// Info panel, modelled on the Sankey view's: overall totals by default, a
	// hovered/focused turn row's details otherwise — the content the former
	// tooltips composed for this section (turn totals plus the opening user
	// prompt's text). One panel serves the turns table.
	const totalCost = d3.sum(agents, a => costOf(a.tokensEst, a.agent))
	const panel = createInfoPanel({
		headingId: 'summary-panel-title',
		heading: 'Details',
		contentFor: key => {
			const t = turnRows.find(x => turnKey(x.threadId, x.turnIndex) === key)
			if (!t) return null
			const found = turnNodes.get(key)
			const rows: [string, string][] = [
				['thread', t.threadId],
				['agent', t.agent],
				['started', fmtTime(t.startedAt)],
				...(t.endedAt
					? [['ended', fmtTime(t.endedAt)] as [string, string]]
					: []),
				['steps', fmtInt(t.steps)],
				['tool calls', fmtInt(t.toolCalls)],
				['chars', fmtInt(t.chars)],
				['tokens (est.)', `≈${fmtInt(t.tokensEst)}`],
				[
					'cost (est., assumed rate)',
					`${fmtCost(costOf(t.tokensEst, t.agent))} · ${fmtRate(rateFor(t.agent))}`,
				],
				['context at end', `${fmtInt(t.contextCharsAtEnd)} chars`],
				['user prompt', `${fmtInt(t.userPromptChars)} chars`],
			]
			if (found?.prompt) {
				const content = nodePanel(found.prompt, rows)
				content.title = found.turn.name
				content.badges = [{text: 'turn'}, {text: t.agent}]
				if (content.text)
					content.text.label = 'User prompt that opened this turn'
				return content
			}
			return {
				title: `${t.threadId} · turn ${t.turnIndex + 1}`,
				badges: [{text: 'turn'}, {text: t.agent}],
				rows,
			}
		},
		defaultContent: () => ({
			title: 'Overall totals',
			badges: [
				{text: `${fmtInt(turns.length)} turns`},
				{text: `${fmtInt(ds.source.threadIds.length)} threads`},
			],
			rows: [
				['messages', fmtInt(ds.source.messageCount)],
				[
					'steps / tool calls',
					`${fmtInt(d3.sum(turns, t => t.steps))} / ${fmtInt(totals.toolCalls)} (${fmtInt(totals.errors)} errors)`,
				],
				[
					'characters',
					`${fmtInt(totals.chars)} · ≈${fmtInt(totals.tokens)} tokens (est.)`,
				],
				[
					'cost (est., assumed rates)',
					`${fmtCost(totalCost)} — not provider data`,
				],
				['largest context', `${fmtInt(maxCtx)} chars at end of a turn`],
				['interaction', 'hover or focus a turn row for that turn'],
			],
		}),
	})
	const tbl = table(
		[
			'turn',
			'agent',
			'started',
			'steps',
			'tool calls',
			'chars',
			'tokens (est.)',
			'cost (est.)',
			'context at end',
			'context over steps',
			'user prompt chars',
		],
		turnRows.map(t => [
			`${t.threadId} #${t.turnIndex + 1}`,
			el(
				'span',
				{},
				el('i', {class: 'swatch', style: `--c:${agentColor(t.agent)}`}),
				t.agent,
			),
			fmtTime(t.startedAt),
			fmtInt(t.steps),
			fmtInt(t.toolCalls),
			fmtInt(t.chars),
			fmtInt(t.tokensEst),
			fmtCost(costOf(t.tokensEst, t.agent)),
			bar(t.contextCharsAtEnd, maxCtx, agentColor(t.agent)),
			sparkline(
				turnCtx.get(turnKey(t.threadId, t.turnIndex)) ?? [],
				agentColor(t.agent),
			),
			fmtInt(t.userPromptChars),
		]),
		(tr, i) => {
			const t = turnRows[i]!
			tr.setAttribute('data-hit', 'turn')
			tr.setAttribute('data-key', turnKey(t.threadId, t.turnIndex))
			tr.setAttribute('tabindex', '0')
		},
	)
	const turnsLayout = el(
		'div',
		{class: 'info-layout'},
		el('div', {class: 'table-scroll'}, tbl),
		panel.root,
	)
	container.append(turnsLayout)
	wireInfoPanel([tbl], panel)

	// Memory facts, if the pipeline attached them (hierarchy.meta.memory is an extension beyond SCHEMA.md; rendered defensively).
	const mem = (ds.hierarchy.meta as {memory?: unknown} | undefined)?.memory
	if (Array.isArray(mem) && mem.length) {
		container.append(
			el(
				'h3',
				{},
				`Memory facts attached to the project (${fmtInt(mem.length)})`,
			),
		)
		const ul = el('ul', {class: 'facts'})
		for (const f of mem) {
			const rec = (typeof f === 'object' && f !== null ? f : {}) as Record<
				string,
				unknown
			>
			const text =
				typeof rec.content === 'string' ? rec.content : JSON.stringify(f)
			const cat = typeof rec.category === 'string' ? rec.category : undefined
			ul.append(
				el(
					'li',
					{},
					...(cat ? [el('span', {class: 'badge'}, cat), ' '] : []),
					text,
				),
			)
		}
		container.append(ul)
	}

	const disposeRates = onRatesChange(container, () =>
		renderSummary(container, ds),
	)
	return () => disposeRates()
}

/**
 * Sparkline of context size over a turn's steps (~120×22px, single path in
 * the row agent's colour, y from 0 so rows are comparable). Empty or missing
 * series → em dash, never an empty box. Min/max stay unannotated; the
 * adjacent numeric cell and the info panel carry the values.
 */
function sparkline(series: number[], color: string): SVGSVGElement | string {
	if (!series.length) return '—'
	const w = 120
	const h = 22
	const pad = 2
	const last = series[series.length - 1] ?? 0
	const y = d3
		.scaleLinear()
		.domain([0, d3.max(series) ?? 1])
		.range([h - pad, pad])
	const x = (i: number): number =>
		series.length > 1 ? pad + (i / (series.length - 1)) * (w - 2 * pad) : w / 2
	const path =
		d3
			.line<number>()
			.x((_, i) => x(i))
			.y(v => y(v))(series) ?? ''
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
	svg.setAttribute('width', String(w))
	svg.setAttribute('height', String(h))
	svg.setAttribute('class', 'sparkline')
	svg.setAttribute('role', 'img')
	svg.setAttribute(
		'aria-label',
		`context over ${series.length} steps, ending at ${fmtInt(last)} chars`,
	)
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
	p.setAttribute('d', path)
	p.setAttribute('fill', 'none')
	p.setAttribute('stroke', color)
	p.setAttribute('stroke-width', '1.5')
	p.setAttribute('stroke-linejoin', 'round')
	p.setAttribute('stroke-linecap', 'round')
	svg.append(p)
	return svg
}

function bar(value: number, max: number, color: string): HTMLElement {
	const pct = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0
	return el(
		'span',
		{class: 'bar-cell'},
		el('i', {
			class: 'bar',
			style: `--w:${pct}%;--c:${color}`,
			'aria-hidden': 'true',
		}),
		el('span', {}, fmtInt(value)),
	)
}

function table(
	head: string[],
	rows: (string | Node)[][],
	rowHook?: (tr: HTMLTableRowElement, i: number) => void,
): HTMLTableElement {
	const t = el('table', {class: 'data'})
	const thead = el('thead')
	const trh = el('tr')
	for (const h of head) trh.append(el('th', {scope: 'col'}, h))
	thead.append(trh)
	t.append(thead)
	const tb = el('tbody')
	rows.forEach((r, i) => {
		const tr = el('tr')
		r.forEach((c, j) =>
			tr.append(el(j === 0 ? 'th' : 'td', j === 0 ? {scope: 'row'} : {}, c)),
		)
		rowHook?.(tr, i)
		tb.append(tr)
	})
	t.append(tb)
	return t
}
