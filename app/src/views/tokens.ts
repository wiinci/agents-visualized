import * as d3 from 'd3'
import type {LoopNode, LoopsDataset, TurnStat} from '../types'
import {buildThreadNames, collectThreads, isStepKind, turnKey} from '../data'
import {
	agentColor,
	agentDisplayName,
	fmtCompact,
	fmtInt,
	fmtTime,
} from '../format'
import {
	costOf,
	fmtCost,
	fmtRate,
	mountRatesControl,
	onRatesChange,
	rateFor,
} from '../cost'
import {createResizeScope, el, makeRoving} from '../util'
import {createInfoPanel, wireInfoPanel, type PanelContent} from '../panel'
import {
	buildAgentSeries,
	cumulativeTurnTotals,
	perTurnTotals,
} from './tokens-model'

/**
 * Plate VI — Tokens & assumed cost per turn and agent.
 *
 * 1. Compact heatmap with a √-scaled sequential ink ramp (so modest turns stay
 *    legible alongside a dominant worker run, explicitly noted on the legend).
 * 2. Cumulative consumption trend — defaults to per-agent small multiples on a
 *    shared y-scale (with an overlaid-lines toggle), paired with the editable
 *    Rates popover right inside this plate's toolbar.
 */

type Metric = 'tokens' | 'cost'

let metric: Metric = 'tokens'
let mode: 'lines' | 'multiples' = 'multiples'
let focusAfter: string | null = null

let chartResizeScope = createResizeScope()
let disposeRates: (() => void) | null = null

const cellKey = (threadId: string, turnIndex: number, agent: string): string =>
	`${turnKey(threadId, turnIndex)}|${agent}`

function deriveTurnAgentTokens(root: LoopNode): Map<string, number> {
	const out = new Map<string, number>()
	const walk = (n: LoopNode): void => {
		const m = n.meta
		if (
			m &&
			isStepKind(n.kind) &&
			m.threadId !== undefined &&
			m.turnIndex !== undefined &&
			Number.isFinite(m.tokensEst)
		) {
			const k = cellKey(m.threadId, m.turnIndex, m.agent)
			out.set(k, (out.get(k) ?? 0) + (m.tokensEst ?? 0))
		}
		for (const c of n.children ?? []) walk(c)
	}
	walk(root)
	return out
}

function threadPrompts(ds: LoopsDataset): Map<string, LoopNode> {
	const prompts = new Map<string, LoopNode>()
	for (const [tid, t] of collectThreads(ds.hierarchy)) {
		;(t.thread.children ?? []).forEach((turn, i) => {
			if (turn.kind !== 'turn') return
			const ti = turn.meta?.turnIndex ?? i
			const prompt = (turn.children ?? []).find(c => c.kind === 'user-message')
			if (prompt) prompts.set(turnKey(tid, ti), prompt)
		})
	}
	return prompts
}

function agentColumns(ds: LoopsDataset): string[] {
	const seen = ds.stats.agents.map(a => a.agent)
	const preferred = ['user', 'orchestrator']
	const cols = preferred.filter(a => seen.includes(a))
	for (const a of seen) if (!cols.includes(a)) cols.push(a)
	return cols
}

/** Editorial slate-ink sequential ramp in light-dark() pairs. */
function seqInterpolator(t: number): string {
	const light = d3.interpolateRgb('#ebe6dc', '#1d3b5c')(t)
	const dark = d3.interpolateRgb('#24221e', '#8ab4e8')(t)
	return `light-dark(${light}, ${dark})`
}

function legendGradient(stops = 8): string {
	const parts: string[] = []
	for (let i = 0; i < stops; i++)
		parts.push(
			`${seqInterpolator(i / (stops - 1))} ${((i / (stops - 1)) * 100).toFixed(1)}%`,
		)
	return `linear-gradient(to right, ${parts.join(', ')})`
}

export function renderTokens(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	chartResizeScope.dispose()
	chartResizeScope = createResizeScope()
	disposeRates?.()
	disposeRates = null
	container.replaceChildren()

	const turns: TurnStat[] = [...ds.stats.turns].sort(
		(a, b) =>
			a.startedAt.localeCompare(b.startedAt) ||
			a.threadId.localeCompare(b.threadId) ||
			a.turnIndex - b.turnIndex,
	)
	if (!turns.length) {
		container.append(el('p', {class: 'muted'}, 'No turns in this dataset.'))
		return () => {}
	}

	const cells = deriveTurnAgentTokens(ds.hierarchy)
	const threadNames = buildThreadNames(ds)
	const prompts = threadPrompts(ds)
	const agents = agentColumns(ds)

	const valueOf = (t: TurnStat, agent: string): number =>
		cells.get(cellKey(t.threadId, t.turnIndex, agent)) ?? 0
	const val = (tokens: number, agent: string): number =>
		metric === 'cost' ? costOf(tokens, agent) : tokens
	const fmtVal = (n: number): string =>
		metric === 'cost' ? `~${fmtCost(n)}` : `≈${fmtInt(n)}`
	const fmtValCompact = (n: number): string =>
		metric === 'cost' ? `~${fmtCost(n)}` : `≈${fmtCompact(n)}`
	const unitLabel = metric === 'cost' ? 'modeled cost' : 'estimated tokens'
	const threadFull = (tid: string): string => threadNames.get(tid)?.full ?? tid
	const threadShort = (tid: string): string =>
		threadNames.get(tid)?.short ?? tid
	const turnName = (t: TurnStat): string =>
		`${threadFull(t.threadId)} · turn ${t.turnIndex + 1}`

	function excerptFor(t: TurnStat): PanelContent['text'] {
		const p = prompts.get(turnKey(t.threadId, t.turnIndex))
		const body = p?.meta?.excerpt ?? ''
		return body
			? {
					body,
					mono: false,
					label: 'Opening user prompt (excerpt)',
				}
			: undefined
	}

	// ── Editorial Toolbar: segmented metric + trend toggles + relocated Rates popover ──
	const btnTok = el(
		'button',
		{
			type: 'button',
			id: 'tok-metric-tokens',
			class: 'seg-btn',
			'aria-pressed': String(metric === 'tokens'),
		},
		'Tokens',
	)
	const btnCost = el(
		'button',
		{
			type: 'button',
			id: 'tok-metric-cost',
			class: 'seg-btn',
			'aria-pressed': String(metric === 'cost'),
		},
		'Modeled cost',
	)
	btnTok.onclick = () => {
		if (metric === 'tokens') return
		metric = 'tokens'
		focusAfter = 'tok-metric-tokens'
		renderTokens(container, ds)
	}
	btnCost.onclick = () => {
		if (metric === 'cost') return
		metric = 'cost'
		focusAfter = 'tok-metric-cost'
		renderTokens(container, ds)
	}

	const btnMult = el(
		'button',
		{
			type: 'button',
			id: 'tok-mode-multiples',
			class: 'seg-btn',
			'aria-pressed': String(mode === 'multiples'),
		},
		'Per-agent multiples',
	)
	const btnLines = el(
		'button',
		{
			type: 'button',
			id: 'tok-mode-lines',
			class: 'seg-btn',
			'aria-pressed': String(mode === 'lines'),
		},
		'Overlaid lines',
	)
	btnMult.onclick = () => {
		if (mode === 'multiples') return
		mode = 'multiples'
		focusAfter = 'tok-mode-multiples'
		renderTokens(container, ds)
	}
	btnLines.onclick = () => {
		if (mode === 'lines') return
		mode = 'lines'
		focusAfter = 'tok-mode-lines'
		renderTokens(container, ds)
	}

	const ratesWrap = el('span', {class: 'sankey-metric'})
	mountRatesControl(ratesWrap)

	const toolbar = el(
		'div',
		{class: 'toolbar'},
		el(
			'span',
			{class: 'sankey-metric muted small'},
			'Metric',
			el(
				'div',
				{class: 'seg-group', role: 'group', 'aria-label': 'Metric'},
				btnTok,
				btnCost,
			),
		),
		el(
			'span',
			{class: 'sankey-metric muted small'},
			'Trend',
			el(
				'div',
				{class: 'seg-group', role: 'group', 'aria-label': 'Trend layout'},
				btnMult,
				btnLines,
			),
		),
		ratesWrap,
	)

	const totalTokensAll = d3.sum(ds.stats.agents, x => x.tokensEst)
	const totalCostAll = d3.sum(ds.stats.agents, x =>
		costOf(x.tokensEst, x.agent),
	)

	const panel = createInfoPanel({
		headingId: 'tokens-panel-title',
		heading: 'Consumption details',
		contentFor: key =>
			key.startsWith('turn:')
				? lineContent(Number(key.slice(5)))
				: cellContent(key),
		defaultContent: () => ({
			kicker: `${fmtInt(turns.length)} turns · ${fmtInt(agents.length)} agents`,
			title: 'Trace totals',
			stats: [
				['Est. tokens', `≈${fmtCompact(totalTokensAll)}`],
				['Modeled cost', fmtCost(totalCostAll)],
			],
			rows: [
				...agents.map((a): [string, string] => {
					const st = ds.stats.agents.find(x => x.agent === a)
					return [
						agentDisplayName(a),
						st
							? `≈${fmtInt(st.tokensEst)} tok · ${fmtCost(costOf(st.tokensEst, a))}`
							: '—',
					]
				}),
				['default rate', `${fmtRate(rateFor(undefined))} (editable)`],
				['basis', 'chars ÷ 4; editable rates'],
			],
		}),
	})

	const col = el('div', {})
	const layout = el('div', {class: 'info-layout'}, col, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		'Cell shading uses a square-root scale so smaller turns stay readable next to heavy worker runs. Open the rate editor above to test different pricing assumptions.',
	)
	container.append(toolbar, layout, foot)

	function cellContent(key: string): PanelContent | null {
		for (const t of turns) {
			for (const a of agents) {
				if (cellKey(t.threadId, t.turnIndex, a) !== key) continue
				const v = valueOf(t, a)
				const shown = val(v, a)
				const rows: [string, string][] = [
					['agent', agentDisplayName(a)],
					[
						unitLabel,
						metric === 'cost'
							? `${fmtCost(shown)} · ${fmtRate(rateFor(a))}`
							: `≈${fmtInt(v)} (chars ÷ 4)`,
					],
					['context at end', `${fmtInt(t.contextCharsAtEnd)} chars`],
					['user prompt', `${fmtInt(t.userPromptChars)} chars`],
					['steps / tools', `${fmtInt(t.steps)} / ${fmtInt(t.toolCalls)}`],
					['started', fmtTime(t.startedAt)],
				]
				if (v === 0)
					rows.splice(1, 0, [
						'note',
						`no steps by ${agentDisplayName(a)} in this turn`,
					])
				return {
					kicker: `Turn cell · ${agentDisplayName(a)}`,
					title: turnName(t),
					stats: [
						[metric === 'cost' ? 'Modeled cost' : 'Est. tokens', fmtVal(shown)],
						['Steps', fmtInt(t.steps)],
					],
					rows,
					text: excerptFor(t),
				}
			}
		}
		return null
	}

	function lineContent(i: number): PanelContent | null {
		const t = turns[i]
		if (!t) return null
		const rows: [string, string][] = [
			...series.map((s): [string, string] => [
				agentDisplayName(s.agent),
				`+${fmtVal(s.delta[i] ?? 0)} · cum. ${fmtVal(s.cum[i] ?? 0)}`,
			]),
			[
				'all agents',
				`+${fmtVal(turnTotals[i] ?? 0)} · cum. ${fmtVal(cumulativeTotals[i] ?? 0)}`,
			],
			['started', fmtTime(t.startedAt)],
		]
		return {
			kicker: `Global turn #${i + 1} of ${turns.length}`,
			title: turnName(t),
			stats: [
				['Turn delta', fmtVal(turnTotals[i] ?? 0)],
				['Cumulative', fmtVal(cumulativeTotals[i] ?? 0)],
			],
			rows,
			text: excerptFor(t),
		}
	}

	// ── 1. Compact Heatmap (√ scale) ────────────────────────────────────────
	const maxCell =
		d3.max(turns, t => d3.max(agents, a => val(valueOf(t, a), a))) ?? 0
	const heatHost = el('div', {
		class: 'chart-host tok-chart',
		role: 'group',
		'aria-label': `Heatmap of estimated ${metric} by turn (row) and agent (column); arrow keys move between cells`,
	})
	const heatLegend = el('div', {class: 'tok-legend', 'aria-hidden': 'true'})
	col.append(
		el(
			'h3',
			{class: 'tok-subhead'},
			metric === 'cost'
				? 'Modeled cost by turn and agent'
				: 'Estimated tokens by turn and agent',
		),
		el('div', {class: 'tok-legend-row'}, heatLegend),
		heatHost,
	)

	const normSqrt = (v: number): number =>
		maxCell > 0 ? Math.sqrt(Math.max(0, v) / maxCell) : 0

	const drawHeat = (width: number): void => {
		heatHost.replaceChildren()
		const leftW = Math.min(230, Math.max(150, width * 0.3))
		const availW = Math.max(180, width - leftW - 16)
		const colW = Math.min(165, availW / agents.length)
		const svgW = Math.min(width, leftW + colW * agents.length + 16)
		const m = {top: 32, right: 12, bottom: 10, left: leftW}
		const rowH = 34
		const height = m.top + turns.length * rowH + m.bottom

		const svg = d3
			.create('svg')
			.attr('viewBox', `0 0 ${svgW} ${height}`)
			.attr('width', svgW)
			.attr('height', height)
			.attr('role', 'img')
			.attr('aria-label', 'Heatmap of estimated tokens per turn and agent')

		agents.forEach((a, j) => {
			const x = m.left + colW * j
			svg
				.append('circle')
				.attr('cx', x + 7)
				.attr('cy', m.top - 18)
				.attr('r', 4.5)
				.attr('fill', agentColor(a))
				.attr('aria-hidden', 'true')
			svg
				.append('text')
				.attr('class', 'tok-colhead')
				.attr('x', x + 16)
				.attr('y', m.top - 14)
				.text(agentDisplayName(a))
		})

		turns.forEach((t, i) => {
			const y = m.top + i * rowH
			const short = threadShort(t.threadId)
			const full = threadFull(t.threadId)
			const label = svg
				.append('text')
				.attr('class', 'tok-rowlabel')
				.attr('x', m.left - 10)
				.attr('y', y + rowH / 2 + 4)
				.attr('text-anchor', 'end')
				.text(`T${i + 1} · ${short}`)
			label.append('title').text(`${full} · turn ${t.turnIndex + 1}`)

			agents.forEach((a, j) => {
				const v = valueOf(t, a)
				const shown = val(v, a)
				const tPos = normSqrt(shown)
				const x = m.left + colW * j
				svg
					.append('rect')
					.attr('class', `tok-cell${v === 0 ? ' is-empty' : ''}`)
					.attr('x', x)
					.attr('y', y)
					.attr('width', Math.max(2, colW - 4))
					.attr('height', rowH - 4)
					.attr('rx', 2)
					.attr('fill', v === 0 ? 'var(--bg-2)' : seqInterpolator(tPos))
					.attr('data-hit', 'cell')
					.attr('data-key', cellKey(t.threadId, t.turnIndex, a))
					.attr('tabindex', -1)
					.attr('role', 'button')
					.attr(
						'aria-label',
						`${agentDisplayName(a)} in turn ${t.turnIndex + 1} of ${full}: ${fmtVal(shown)}${metric === 'cost' ? ' (assumed rate)' : ' (est.)'}`,
					)
				if (colW >= 46) {
					svg
						.append('text')
						.attr('class', 'tok-cellval')
						.attr('x', x + Math.max(2, colW - 4) / 2)
						.attr('y', y + rowH / 2 + 4)
						.attr('text-anchor', 'middle')
						.attr(
							'fill',
							v === 0
								? 'var(--fg-muted)'
								: tPos > 0.56
									? 'light-dark(#faf8f4, #131210)'
									: 'var(--fg)',
						)
						.attr('aria-hidden', 'true')
						.text(v === 0 ? '—' : fmtValCompact(shown))
				}
			})
		})

		heatHost.append(svg.node()!)
		makeRoving(heatHost, '[data-hit]')
	}

	const drawHeatLegend = (): void => {
		heatLegend.replaceChildren()
		const maxShown = maxCell
		heatLegend.append(
			el(
				'span',
				{class: 'tok-legend-title muted small'},
				`${unitLabel} (√ scale)`,
			),
		)
		const bar = el('span', {class: 'tok-legend-bar'})
		bar.style.background = legendGradient()
		heatLegend.append(bar)
		const lab = (s: string) =>
			el('span', {class: 'tok-legend-tick mono muted small'}, s)
		heatLegend.append(
			lab(metric === 'cost' ? fmtCost(0) : '0'),
			lab(fmtValCompact(maxShown / 4)),
			lab(fmtValCompact(maxShown)),
		)
	}
	drawHeatLegend()
	chartResizeScope.observe(heatHost, drawHeat)

	// ── 2. Cumulative trend ─────────────────────────────────────────────────
	const series = buildAgentSeries(agents, turns.length, (agent, turnIndex) => {
		const turn = turns[turnIndex]
		return turn ? val(valueOf(turn, agent), agent) : 0
	})
	const turnTotals = perTurnTotals(series)
	const cumulativeTotals = cumulativeTurnTotals(series)

	const lineHost = el('div', {
		class: 'chart-host tok-chart',
		role: 'group',
		'aria-label':
			'Cumulative estimated tokens by agent over turn index; arrow keys move between turns',
	})
	col.append(
		el(
			'h3',
			{class: 'tok-subhead'},
			mode === 'multiples'
				? 'Cumulative total by agent (shared scale)'
				: 'Cumulative total, overlaid',
		),
		lineHost,
	)

	let lineGeom = {left: 64, step: 1, n: 1}
	let showFocusFn: ((i: number) => void) | null = null
	let hideFocusFn: (() => void) | null = null

	const drawLine = (width: number): void => {
		lineHost.replaceChildren()
		const n = turns.length
		const cumLabel = `cumulative ${unitLabel}`
		type Sel<T extends d3.BaseType> = d3.Selection<
			T,
			undefined,
			null,
			undefined
		>
		interface Panel {
			label: string
			color: string
			values: number[]
		}

		if (mode === 'lines') {
			const m = {top: 18, right: 124, bottom: 38, left: 60}
			const height = 300
			const yMax = d3.max(cumulativeTotals) ?? 1
			const x = d3
				.scaleLinear()
				.domain([0, Math.max(1, n - 1)])
				.range([m.left, width - m.right])
			const y = d3
				.scaleLinear()
				.domain([0, yMax])
				.nice()
				.range([height - m.bottom, m.top])

			const svg = d3
				.create('svg')
				.attr('viewBox', `0 0 ${width} ${height}`)
				.attr('width', width)
				.attr('height', height)
				.attr('role', 'img')
				.attr('aria-label', 'Cumulative estimated tokens per agent over turns')
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', width - m.right)
				.attr('y', height - 6)
				.attr('text-anchor', 'end')
				.text('turn index →')
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', m.left)
				.attr('y', m.top - 4)
				.text(cumLabel)

			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(0,${height - m.bottom})`)
				.call(
					d3
						.axisBottom(x)
						.ticks(n)
						.tickFormat(d => `T${(d as number) + 1}`),
				)
			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(${m.left},0)`)
				.call(
					d3
						.axisLeft(y)
						.ticks(5)
						.tickFormat(d =>
							metric === 'cost'
								? fmtCost(d as number)
								: fmtCompact(d as number),
						),
				)
				.call(g =>
					g
						.selectAll('.tick line')
						.clone()
						.attr('x2', width - m.left - m.right)
						.attr('stroke-opacity', 0.12)
						.attr('class', 'tok-gridline'),
				)

			series.forEach(s => {
				const line = d3
					.line<number>()
					.x((_, i) => x(i))
					.y((_, i) => y(s.cum[i] ?? 0))
				svg
					.append('path')
					.datum(d3.range(n))
					.attr('fill', 'none')
					.attr('stroke', agentColor(s.agent))
					.attr('stroke-width', 2)
					.attr('stroke-linejoin', 'round')
					.attr('stroke-linecap', 'round')
					.attr('class', 'tok-line')
					.attr('d', line)
			})

			const placedY: number[] = []
			series.forEach(s => {
				const last = n - 1
				const rawY = y(s.cum[last] ?? 0)
				const yPos = Math.max(m.top + 8, Math.min(height - m.bottom - 4, rawY))
				const clash = placedY.some(py => Math.abs(py - yPos) < 13)
				const label = svg
					.append('text')
					.attr('class', 'tok-endlabel')
					.attr('x', x(last) + 8)
					.attr('y', yPos + 4)
					.attr('fill', agentColor(s.agent))
					.text(agentDisplayName(s.agent))
				if (clash) label.style('display', 'none')
				else placedY.push(yPos)
			})

			const step = n > 1 ? x(1) - x(0) : width - m.left - m.right
			const crosshair = svg
				.append('line')
				.attr('class', 'tok-crosshair')
				.attr('y1', m.top)
				.attr('y2', height - m.bottom)
				.style('display', 'none')
			const dots = svg.append('g').style('display', 'none')
			const showFocus = (i: number): void => {
				const cx = x(n > 1 ? i : 0)
				crosshair.attr('x1', cx).attr('x2', cx).style('display', null)
				dots
					.style('display', null)
					.selectAll('circle')
					.data(series)
					.join('circle')
					.attr('cx', cx)
					.attr('cy', s => y(s.cum[i] ?? 0))
					.attr('r', 3.5)
					.attr('fill', s => agentColor(s.agent))
					.attr('stroke', 'var(--bg)')
					.attr('stroke-width', 1.5)
			}
			const hideFocus = (): void => {
				crosshair.style('display', 'none')
				dots.style('display', 'none')
			}

			turns.forEach((t, i) => {
				svg
					.append('rect')
					.attr('class', 'tok-hit')
					.attr('x', m.left + (n > 1 ? step * i - step / 2 : 0))
					.attr('y', m.top)
					.attr('width', n > 1 ? step : width - m.left - m.right)
					.attr('height', height - m.top - m.bottom)
					.attr('fill', 'transparent')
					.attr('data-hit', 'turn')
					.attr('data-key', String(i))
					.attr('tabindex', -1)
					.attr('role', 'button')
					.attr(
						'aria-label',
						`Turn ${i + 1} (${threadFull(t.threadId)}): total ${fmtVal(turnTotals[i] ?? 0)} ${metric === 'cost' ? '(assumed rates)' : '(est.)'}`,
					)
			})
			lineHost.append(svg.node()!)

			lineGeom = {left: m.left, step, n}
			showFocusFn = showFocus
			hideFocusFn = hideFocus
		} else {
			const panels: Panel[] = [
				...series.map(
					(s): Panel => ({
						label: agentDisplayName(s.agent),
						color: agentColor(s.agent),
						values: s.cum,
					}),
				),
				{label: 'All agents', color: 'var(--fg)', values: cumulativeTotals},
			]
			const yMax = d3.max(cumulativeTotals) ?? 1
			const m = {top: 22, right: 96, bottom: 36, left: 60}
			const titleH = 18
			const plotH = 84
			const gap = 16
			const height =
				m.top + panels.length * (titleH + plotH + gap) - gap + m.bottom
			const x = d3
				.scaleLinear()
				.domain([0, Math.max(1, n - 1)])
				.range([m.left, width - m.right])
			const step = n > 1 ? x(1) - x(0) : width - m.left - m.right

			const svg = d3
				.create('svg')
				.attr('viewBox', `0 0 ${width} ${height}`)
				.attr('width', width)
				.attr('height', height)
				.attr('role', 'img')
				.attr(
					'aria-label',
					'Small multiples of cumulative estimated tokens per agent on a shared scale, plus an all-agents total panel',
				)
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', m.left)
				.attr('y', m.top - 10)
				.text(cumLabel)
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', width - m.right)
				.attr('y', height - 6)
				.attr('text-anchor', 'end')
				.text('turn index →')

			const crosshairs: Sel<SVGLineElement>[] = []
			const dotGroups: {
				dots: Sel<SVGGElement>
				y: d3.ScaleLinear<number, number>
				p: Panel
			}[] = []

			panels.forEach((p, k) => {
				const blockTop = m.top + k * (titleH + plotH + gap)
				const titleY = blockTop + 10
				const top = blockTop + titleH
				const bottom = top + plotH
				const y = d3.scaleLinear().domain([0, yMax]).nice().range([bottom, top])

				svg
					.append('circle')
					.attr('cx', m.left + 5)
					.attr('cy', titleY - 4)
					.attr('r', 4.5)
					.attr('fill', p.color)
					.attr('aria-hidden', 'true')
				svg
					.append('text')
					.attr('class', 'tok-colhead')
					.attr('x', m.left + 15)
					.attr('y', titleY)
					.text(p.label)

				svg
					.append('g')
					.attr('class', 'axis')
					.attr('transform', `translate(${m.left},0)`)
					.call(
						d3
							.axisLeft(y)
							.ticks(2)
							.tickFormat(d =>
								metric === 'cost'
									? fmtCost(d as number)
									: fmtCompact(d as number),
							),
					)

				const line = d3
					.line<number>()
					.x((_, i) => x(i))
					.y((_, i) => y(p.values[i] ?? 0))
				svg
					.append('path')
					.datum(d3.range(n))
					.attr('fill', 'none')
					.attr('stroke', p.color)
					.attr('stroke-width', 2)
					.attr('stroke-linejoin', 'round')
					.attr('stroke-linecap', 'round')
					.attr('class', 'tok-line')
					.attr('d', line)

				svg
					.append('text')
					.attr('class', 'tok-endlabel')
					.attr('x', x(n - 1) + 8)
					.attr('y', y(p.values[n - 1] ?? 0) + 4)
					.attr('fill', p.color)
					.text(fmtValCompact(p.values[n - 1] ?? 0))

				const cross = svg
					.append('line')
					.attr('class', 'tok-crosshair')
					.attr('y1', top)
					.attr('y2', bottom)
					.style('display', 'none')
				const dots = svg.append('g').style('display', 'none')
				crosshairs.push(cross)
				dotGroups.push({dots, y, p})

				turns.forEach((t, i) => {
					svg
						.append('rect')
						.attr('class', 'tok-hit')
						.attr('x', m.left + (n > 1 ? step * i - step / 2 : 0))
						.attr('y', top)
						.attr('width', n > 1 ? step : width - m.left - m.right)
						.attr('height', plotH)
						.attr('fill', 'transparent')
						.attr('data-hit', 'turn')
						.attr('data-key', String(i))
						.attr('tabindex', -1)
						.attr('role', 'button')
						.attr(
							'aria-label',
							`Turn ${i + 1} (${threadFull(t.threadId)}): total ${fmtVal(turnTotals[i] ?? 0)} ${metric === 'cost' ? '(assumed rates)' : '(est.)'}`,
						)
				})
			})

			const lastBottom =
				m.top + (panels.length - 1) * (titleH + plotH + gap) + titleH + plotH
			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(0,${lastBottom})`)
				.call(
					d3
						.axisBottom(x)
						.ticks(n)
						.tickFormat(d => `T${(d as number) + 1}`),
				)

			const showFocus = (i: number): void => {
				const cx = x(n > 1 ? i : 0)
				crosshairs.forEach(c =>
					c.attr('x1', cx).attr('x2', cx).style('display', null),
				)
				dotGroups.forEach(({dots, y, p}) => {
					dots
						.style('display', null)
						.selectAll('circle')
						.data([p])
						.join('circle')
						.attr('cx', cx)
						.attr('cy', q => y(q.values[i] ?? 0))
						.attr('r', 3.5)
						.attr('fill', q => q.color)
						.attr('stroke', 'var(--bg)')
						.attr('stroke-width', 1.5)
				})
			}
			const hideFocus = (): void => {
				crosshairs.forEach(c => c.style('display', 'none'))
				dotGroups.forEach(({dots}) => dots.style('display', 'none'))
			}

			lineHost.append(svg.node()!)
			lineGeom = {left: m.left, step, n}
			showFocusFn = showFocus
			hideFocusFn = hideFocus
		}

		if (!lineHost.dataset.bound) {
			lineHost.dataset.bound = '1'
			lineHost.addEventListener('pointermove', e => {
				const svg = lineHost.querySelector('svg')
				if (!svg) return
				const [xm] = d3.pointer(e, svg)
				const {left, step, n} = lineGeom
				showFocusFn?.(
					Math.max(0, Math.min(n - 1, Math.round((xm - left) / (step || 1)))),
				)
			})
			lineHost.addEventListener('pointerleave', () => hideFocusFn?.())
			lineHost.addEventListener('focusin', e => {
				const hit = (e.target as Element | null)?.closest<SVGRectElement>(
					'.tok-hit',
				)
				const i = hit ? Number(hit.getAttribute('data-key')) : NaN
				if (Number.isInteger(i)) showFocusFn?.(i)
			})
			lineHost.addEventListener('focusout', () => hideFocusFn?.())
		}
		makeRoving(lineHost, '[data-hit]')
	}

	chartResizeScope.observe(lineHost, drawLine)

	wireInfoPanel([heatHost, lineHost], panel, mark =>
		mark.classList.contains('tok-hit')
			? `turn:${mark.getAttribute('data-key') ?? ''}`
			: mark.getAttribute('data-key'),
	)

	disposeRates = onRatesChange(container, () => renderTokens(container, ds))

	if (focusAfter) {
		document.getElementById(focusAfter)?.focus()
		focusAfter = null
	}
	return () => {
		chartResizeScope.dispose()
		disposeRates?.()
		disposeRates = null
	}
}
