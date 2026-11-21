import * as d3 from 'd3'
import type {LoopsDataset} from '../types'
import {collectThreads, type StepRef} from '../data'
import {agentColor, fmtCompact, fmtInt, nodeAriaLabel} from '../format'
import {createResizeScope, el, makeRoving} from '../util'
import {onRatesChange} from '../cost'
import {createInfoPanel, nodePanel, withCostRow, wireInfoPanel} from '../panel'

/**
 * Small multiples, one per thread: contextChars (cumulative characters of
 * everything earlier in the thread) over step index. The line carries the
 * trajectory; bars underneath show each step's own size (chars) — no area
 * fill, which added unwarranted ink without information. Turn boundaries
 * are marked with vertical rules. Points are focusable and carry the step's
 * name and sizes in their aria-label; hovering or focusing a point swaps the
 * section's info panel to that step (default: a trajectory overview).
 */
export function renderContext(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	const threads = Array.from(collectThreads(ds.hierarchy).values()).filter(
		t => t.steps.length > 0,
	)
	if (!threads.length) {
		container.append(el('p', {class: 'muted'}, 'No steps with context data.'))
		return () => {}
	}

	const globalMax =
		d3.max(threads, t =>
			d3.max(t.steps, s => s.node.meta?.contextChars ?? 0),
		) ?? 1
	const note = el(
		'p',
		{class: 'view-note'},
		`One panel per thread (${threads.length}). Line/area = context size (chars) at each step; bars = that step's own size; dashed rules = turn boundaries. `,
		`Shared y-axis (max ${fmtCompact(globalMax)} chars) so threads are comparable. Hovering or focusing a point swaps the info panel to that step.`,
	)
	const grid = el('div', {class: 'multiples'})

	// Info panel, modelled on the Sankey view's: a trajectory overview by
	// default, a hovered/focused step's details otherwise — the content the
	// former tooltips composed for this section (node fields plus thread-step
	// position and turn). One panel serves every card.
	const stepById = new Map<string, {s: StepRef; total: number}>()
	for (const t of threads)
		for (const s of t.steps) stepById.set(s.node.id, {s, total: t.steps.length})
	const totalSteps = threads.reduce((n, t) => n + t.steps.length, 0)
	const largestFinal = threads.reduce(
		(best, t) => {
			const last = t.steps[t.steps.length - 1]
			const end =
				(last?.node.meta?.contextChars ?? 0) + (last?.node.meta?.chars ?? 0)
			return end > best.end ? {thread: t.thread.name, end} : best
		},
		{thread: '', end: -1},
	)
	const panel = createInfoPanel({
		headingId: 'context-panel-title',
		heading: 'Step details',
		contentFor: key => {
			const found = stepById.get(key)
			if (!found) return null
			return withCostRow(
				nodePanel(found.s.node, [
					['thread step', `#${found.s.stepIndexInThread} of ${found.total}`],
					['turn', found.s.turn.name],
				]),
				found.s.node.meta?.tokensEst,
				found.s.node.meta?.agent,
			)
		},
		defaultContent: () => ({
			title: 'Context trajectories',
			badges: [{text: `${fmtInt(threads.length)} threads`}],
			rows: [
				['threads with steps', fmtInt(threads.length)],
				['steps with context data', fmtInt(totalSteps)],
				[
					'largest context at a step',
					`${fmtCompact(globalMax)} chars — the shared y max`,
				],
				[
					'largest context at a thread end',
					`${fmtCompact(largestFinal.end)} chars (${largestFinal.thread})`,
				],
				['interaction', 'hover or focus a point for that step'],
			],
		}),
	})
	const layout = el('div', {class: 'info-layout'}, grid, panel.root)
	container.append(note, layout)

	const hosts: HTMLElement[] = []
	const resizeScope = createResizeScope()
	for (const t of threads) {
		const agent =
			t.thread.meta?.agent ??
			t.steps.find(s => s.node.meta?.agent !== 'user')?.node.meta?.agent
		const last = t.steps[t.steps.length - 1]?.node.meta
		const card = el('figure', {class: 'multiple'})
		const cap = el(
			'figcaption',
			{},
			el('strong', {}, t.thread.name),
			' ',
			el(
				'span',
				{class: 'badge', style: `--badge:${agentColor(agent)}`},
				agent ?? 'thread',
			),
			' ',
			el(
				'span',
				{class: 'muted'},
				`${fmtInt(t.steps.length)} steps · ${t.thread.children?.filter(c => c.kind === 'turn').length ?? 0} turns · context at end ${fmtInt((last?.contextChars ?? 0) + (last?.chars ?? 0))} chars`,
			),
		)
		const host = el('div', {
			class: 'chart-host',
			role: 'group',
			'aria-label': `Context growth for ${t.thread.name}; arrow keys move between steps`,
		})
		card.append(cap, host)
		grid.append(card)
		hosts.push(host)

		const draw = (width: number): void => {
			host.replaceChildren()
			const height = 220
			const m = {top: 10, right: 12, bottom: 28, left: 56}
			const x = d3
				.scaleLinear()
				.domain([0, Math.max(1, t.steps.length - 1)])
				.range([m.left, width - m.right])
			const y = d3
				.scaleLinear()
				.domain([0, globalMax])
				.nice()
				.range([height - m.bottom, m.top])
			const ctxAt = (s: StepRef) => s.node.meta?.contextChars ?? 0

			const svg = d3
				.create('svg')
				.attr('viewBox', `0 0 ${width} ${height}`)
				.attr('width', width)
				.attr('height', height)
				.attr('role', 'img')
				.attr(
					'aria-label',
					`Context size over ${t.steps.length} steps in ${t.thread.name}`,
				)
			svg.append('title').text(`Context growth — ${t.thread.name}`)

			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(0,${height - m.bottom})`)
				.call(
					d3
						.axisBottom(x)
						.ticks(Math.min(10, t.steps.length))
						.tickFormat(d => `#${d}`),
				)
			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(${m.left},0)`)
				.call(
					d3
						.axisLeft(y)
						.ticks(4)
						.tickFormat(d => fmtCompact(d as number)),
				)
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', width - m.right)
				.attr('y', height - 6)
				.attr('text-anchor', 'end')
				.text('step index →')
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', m.left)
				.attr('y', m.top - 2)
				.text('context chars')

			// Turn boundaries
			const bounds: number[] = []
			t.steps.forEach((s, i) => {
				if (i > 0 && s.turn !== t.steps[i - 1]!.turn) bounds.push(i)
			})
			svg
				.append('g')
				.selectAll('line')
				.data(bounds)
				.join('line')
				.attr('class', 'turn-rule')
				.attr('x1', i => x(i) - 0.5)
				.attr('x2', i => x(i) - 0.5)
				.attr('y1', m.top)
				.attr('y2', height - m.bottom)

			// Own-size bars
			const barW = Math.max(1, (x(1) - x(0)) * 0.6)
			svg
				.append('g')
				.selectAll('rect')
				.data(t.steps)
				.join('rect')
				.attr('class', 'step-bar')
				.attr('x', (_, i) => x(i) - barW / 2)
				.attr('width', barW)
				.attr('y', s => y(s.node.meta?.chars ?? 0))
				.attr('height', s => y(0) - y(s.node.meta?.chars ?? 0))
				.attr('fill', s => agentColor(s.node.meta?.agent))
				.attr('fill-opacity', 0.35)

			const line = d3
				.line<StepRef>()
				.x((_, i) => x(i))
				.y(s => y(ctxAt(s)))
			svg
				.append('path')
				.datum(t.steps)
				.attr('class', 'ctx-line')
				.attr('fill', 'none')
				.attr('stroke', agentColor(agent))
				.attr('stroke-width', 2)
				.attr('d', line)

			// Focusable points (radius grows with own size so hit targets are usable)
			const r = d3
				.scaleSqrt()
				.domain([0, d3.max(t.steps, s => s.node.meta?.chars ?? 0) ?? 1])
				.range([3, 9])
			svg
				.append('g')
				.selectAll<SVGCircleElement, StepRef>('circle')
				.data(t.steps)
				.join('circle')
				.attr('class', 'ctx-point')
				.attr('cx', (_, i) => x(i))
				.attr('cy', s => y(ctxAt(s)))
				.attr('r', s => r(s.node.meta?.chars ?? 0))
				.attr('fill', s => agentColor(s.node.meta?.agent))
				.attr('stroke', 'var(--bg)')
				.attr('stroke-width', 1.5)
				.attr('data-hit', 'step')
				.attr('data-key', s => s.node.id)
				.attr('tabindex', -1)
				.attr('role', 'button')
				.attr(
					'aria-label',
					(s, i) =>
						`step ${i}, ${nodeAriaLabel(s.node)}, context ${fmtInt(ctxAt(s))} characters`,
				)

			host.append(svg.node()!)
			makeRoving(host, '[data-hit]')
		}

		resizeScope.observe(host, draw)
	}
	wireInfoPanel(hosts, panel)
	const disposeRates = onRatesChange(container, panel.refresh)
	return () => {
		resizeScope.dispose()
		disposeRates()
	}
}
