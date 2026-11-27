import * as d3 from 'd3'
import type {LoopNode, LoopsDataset} from '../types'
import {buildThreadNames, collectThreads, turnKey} from '../data'
import {
	agentColor,
	agentDisplayName,
	fmtCompact,
	fmtElapsed,
	fmtInt,
	fmtPct,
	fmtTime,
} from '../format'
import {costOf, fmtCost, fmtRate, onRatesChange, rateFor} from '../cost'
import {el} from '../util'
import {createInfoPanel, nodePanel, wireInfoPanel} from '../panel'

/**
 * Appendix — Complete empirical ledger from `stats`:
 * Per-agent and Per-tool tables sit side-by-side at full spread width; the
 * turn-by-turn ledger sits beside its own sticky marginalia column.
 * (Headline KPIs live in the article masthead.)
 */
export function renderSummary(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	const {agents, tools, turns} = ds.stats
	const threadNames = buildThreadNames(ds)
	const threadFull = (tid: string) => threadNames.get(tid)?.full ?? tid
	const threadShort = (tid: string) => threadNames.get(tid)?.short ?? tid

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

	// ── Side-by-side full-spread tables: Per agent | Per tool ───────────────
	const maxAgentChars = d3.max(agents, a => a.chars) ?? 1
	const agentBlock = el(
		'div',
		{class: 'summary-block'},
		el('h3', {}, 'Per agent'),
		el(
			'div',
			{class: 'table-scroll'},
			table(
				[
					'Agent',
					'Threads',
					'Turns',
					'Tools',
					'Characters',
					'Tokens (est.)',
					'Cost (est.)',
				],
				agents.map(a => [
					el(
						'span',
						{},
						el('i', {class: 'swatch', style: `--c:${agentColor(a.agent)}`}),
						agentDisplayName(a.agent),
					),
					fmtInt(a.threads),
					fmtInt(a.turns),
					fmtInt(a.toolCalls),
					bar(a.chars, maxAgentChars, agentColor(a.agent)),
					fmtInt(a.tokensEst),
					fmtCost(costOf(a.tokensEst, a.agent)),
				]),
			),
		),
	)

	const maxToolChars = d3.max(tools, t => t.promptChars + t.resultChars) ?? 1
	const toolBlock = el(
		'div',
		{class: 'summary-block'},
		el('h3', {}, 'Per tool'),
		el(
			'div',
			{class: 'table-scroll'},
			table(
				['Tool', 'Calls', 'Args chars', 'Result chars', 'Errors'],
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
		),
	)

	container.append(el('div', {class: 'summary-pair'}, agentBlock, toolBlock))

	// ── Turns ledger + dedicated sticky marginalia ──────────────────────────
	const maxCtx = d3.max(turns, t => t.contextCharsAtEnd) ?? 1
	const turnRows = [...turns].sort((a, b) =>
		a.startedAt.localeCompare(b.startedAt),
	)

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

	const runStart = turnRows[0]?.startedAt
	const turnSequence = turnRows.map(t => turnKey(t.threadId, t.turnIndex))
	const totalCost = d3.sum(agents, a => costOf(a.tokensEst, a.agent))
	const panel = createInfoPanel({
		headingId: 'summary-panel-title',
		heading: 'Turn details',
		contentFor: key => {
			const t = turnRows.find(x => turnKey(x.threadId, x.turnIndex) === key)
			if (!t) return null
			const found = turnNodes.get(key)
			const elapsed = fmtElapsed(t.startedAt, runStart)
			const rows: [string, string][] = [
				['thread', threadFull(t.threadId)],
				['started', elapsed ? `${elapsed} into run` : fmtTime(t.startedAt)],
				['tools', `${fmtInt(t.toolCalls)} calls`],
				['volume', `${fmtInt(t.chars)} chars · ≈${fmtInt(t.tokensEst)} tok`],
				[
					'cost (assumed)',
					`${fmtCost(costOf(t.tokensEst, t.agent))} · ${fmtRate(rateFor(t.agent))}`,
				],
				['user prompt', `${fmtInt(t.userPromptChars)} chars`],
			]
			const metaRows: [string, string][] = [
				['started (UTC)', fmtTime(t.startedAt)],
				...(t.endedAt
					? [['ended (UTC)', fmtTime(t.endedAt)] as [string, string]]
					: []),
				['thread id', t.threadId],
			]
			const content = found?.prompt
				? nodePanel(found.prompt, [])
				: {title: '', rows: [] as [string, string][]}
			return {
				kicker: `Turn #${t.turnIndex + 1} · ${agentDisplayName(t.agent)}`,
				title: `${threadFull(t.threadId)} · turn ${t.turnIndex + 1}`,
				accent: agentColor(t.agent),
				stats: [
					['Steps', fmtInt(t.steps)],
					['End context', `${fmtCompact(t.contextCharsAtEnd)} chars`],
				],
				share: {
					ratio: maxCtx > 0 ? t.contextCharsAtEnd / maxCtx : 0,
					label: `${fmtPct(t.contextCharsAtEnd, maxCtx)} of peak context`,
				},
				rows,
				metaRows,
				compareValue: {
					value: t.contextCharsAtEnd,
					formatted: `${fmtCompact(t.contextCharsAtEnd)} ctx`,
				},
				actions: [
					{
						label: 'Inspect in context growth ↑',
						onClick: () => {
							document
								.getElementById('context')
								?.scrollIntoView({behavior: 'smooth'})
						},
					},
				],
				text: content.text
					? {...content.text, label: 'User prompt that opened this turn'}
					: undefined,
			}
		},
		sequenceFor: () => turnSequence,
		defaultContent: () => ({
			kicker: `${fmtInt(turns.length)} turns · ${fmtInt(ds.source.threadIds.length)} threads`,
			title: 'Overall totals',
			stats: [
				['Volume', `${fmtCompact(totals.chars)} chars`],
				['Modeled cost', fmtCost(totalCost)],
			],
			rows: [
				['messages', fmtInt(ds.source.messageCount)],
				[
					'steps / tools',
					`${fmtInt(d3.sum(turns, t => t.steps))} / ${fmtInt(totals.toolCalls)} (${fmtInt(totals.errors)} errors)`,
				],
				['est. tokens', `≈${fmtInt(totals.tokens)}`],
				['peak context', `${fmtInt(maxCtx)} chars`],
			],
		}),
	})

	const tbl = table(
		[
			'Turn',
			'Agent',
			'Steps',
			'Tools',
			'Chars',
			'Tokens (est.)',
			'Cost (est.)',
			'End context',
			'Trajectory',
		],
		turnRows.map((t, idx) => [
			el(
				'span',
				{
					title: `${threadFull(t.threadId)} · turn ${t.turnIndex + 1} (${t.threadId})`,
				},
				`T${idx + 1} · ${threadShort(t.threadId)} #${t.turnIndex + 1}`,
			),
			el(
				'span',
				{},
				el('i', {class: 'swatch', style: `--c:${agentColor(t.agent)}`}),
				agentDisplayName(t.agent),
			),
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
		]),
		(tr, i) => {
			const t = turnRows[i]!
			tr.setAttribute('data-hit', 'turn')
			tr.setAttribute('data-key', turnKey(t.threadId, t.turnIndex))
			tr.setAttribute('tabindex', '0')
		},
	)

	const turnsSection = el(
		'div',
		{class: 'summary-block'},
		el('h3', {}, 'Turn-by-turn ledger'),
		el(
			'div',
			{class: 'info-layout'},
			el('div', {class: 'table-scroll'}, tbl),
			panel.root,
		),
	)
	container.append(turnsSection)
	const disposeWire = wireInfoPanel([tbl], panel)

	// Memory facts, if the pipeline attached them
	const mem = (ds.hierarchy.meta as {memory?: unknown} | undefined)?.memory
	if (Array.isArray(mem) && mem.length) {
		container.append(
			el('h3', {}, `Attached project memory (${fmtInt(mem.length)})`),
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

	let disposeInner: (() => void) | null = null
	const disposeRates = onRatesChange(container, () => {
		disposeWire()
		disposeInner?.()
		disposeInner = renderSummary(container, ds)
	})
	return () => {
		disposeWire()
		disposeInner?.()
		disposeRates()
	}
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
