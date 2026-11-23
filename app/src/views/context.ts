import * as d3 from 'd3'
import type {LoopsDataset} from '../types'
import {buildThreadNames, collectThreads, type StepRef} from '../data'
import {
	agentColor,
	agentDisplayName,
	fmtCompact,
	fmtInt,
	nodeAriaLabel,
} from '../format'
import {createResizeScope, el, makeRoving} from '../util'
import {onRatesChange} from '../cost'
import {createInfoPanel, nodePanel, withCostRow, wireInfoPanel} from '../panel'

/**
 * Plate V — Small multiples, one per thread: cumulative context characters over
 * step index. Defaults to a shared Y-axis so thread scales compare honestly,
 * with a segmented toggle to fit each thread independently.
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

	const threadNames = buildThreadNames(ds)
	const nameOf = (tid: string, fallback: string) =>
		threadNames.get(tid)?.full ?? fallback

	const globalMax =
		d3.max(threads, t =>
			d3.max(t.steps, s => s.node.meta?.contextChars ?? 0),
		) ?? 1

	let sharedScale = true

	// Segmented scale toggle
	const btnShared = el(
		'button',
		{type: 'button', class: 'seg-btn', 'aria-pressed': 'true'},
		'Shared scale',
	)
	const btnLocal = el(
		'button',
		{type: 'button', class: 'seg-btn', 'aria-pressed': 'false'},
		'Fit each thread',
	)
	const scaleGroup = el(
		'div',
		{class: 'seg-group', role: 'group', 'aria-label': 'Vertical axis scale'},
		btnShared,
		btnLocal,
	)
	const toolbar = el(
		'div',
		{class: 'toolbar'},
		el('span', {class: 'sankey-metric muted small'}, 'Y-axis', scaleGroup),
	)

	const grid = el('div', {class: 'multiples'})

	const stepById = new Map<
		string,
		{s: StepRef; total: number; threadLabel: string}
	>()
	for (const t of threads) {
		const tid = t.thread.meta?.threadId ?? t.thread.id
		const lbl = nameOf(tid, t.thread.name)
		for (const s of t.steps)
			stepById.set(s.node.id, {s, total: t.steps.length, threadLabel: lbl})
	}
	const totalSteps = threads.reduce((n, t) => n + t.steps.length, 0)
	const largestFinal = threads.reduce(
		(best, t) => {
			const tid = t.thread.meta?.threadId ?? t.thread.id
			const last = t.steps[t.steps.length - 1]
			const end =
				(last?.node.meta?.contextChars ?? 0) + (last?.node.meta?.chars ?? 0)
			return end > best.end ? {thread: nameOf(tid, t.thread.name), end} : best
		},
		{thread: '', end: -1},
	)

	const panel = createInfoPanel({
		headingId: 'context-panel-title',
		heading: 'Step details',
		contentFor: key => {
			const found = stepById.get(key)
			if (!found) return null
			const base = withCostRow(
				nodePanel(found.s.node, [
					['thread', found.threadLabel],
					['thread step', `#${found.s.stepIndexInThread} of ${found.total}`],
					['turn', found.s.turn.name],
				]),
				found.s.node.meta?.tokensEst,
				found.s.node.meta?.agent,
			)
			base.kicker = `${found.s.node.kind} · ${agentDisplayName(found.s.node.meta?.agent)}`
			base.stats = [
				[
					'Context',
					`${fmtCompact(found.s.node.meta?.contextChars ?? 0)} chars`,
				],
				['Step size', `${fmtCompact(found.s.node.meta?.chars ?? 0)} chars`],
			]
			return base
		},
		defaultContent: () => ({
			kicker: `${fmtInt(threads.length)} threads`,
			title: 'Context trajectories',
			stats: [
				['Peak context', `${fmtCompact(largestFinal.end)} chars`],
				['Total steps', fmtInt(totalSteps)],
			],
			rows: [
				['shared y-axis max', `${fmtCompact(globalMax)} chars`],
				['largest thread', largestFinal.thread],
				['interaction', 'hover, focus, or click a point to pin'],
			],
		}),
	})

	const layout = el('div', {class: 'info-layout'}, grid, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		`Lines track cumulative context at each step; faint bars below show each step’s own size, and vertical dashed rules mark turn breaks. Switch to "Fit each thread" to inspect quieter threads up close.`,
	)
	container.append(toolbar, layout, foot)

	const hosts: HTMLElement[] = []
	const redrawFns: (() => void)[] = []
	const resizeScope = createResizeScope()

	for (const t of threads) {
		const tid = t.thread.meta?.threadId ?? t.thread.id
		const threadTitle = nameOf(tid, t.thread.name)
		const agent =
			t.thread.meta?.agent ??
			t.steps.find(s => s.node.meta?.agent !== 'user')?.node.meta?.agent
		const last = t.steps[t.steps.length - 1]?.node.meta
		const localMax =
			d3.max(t.steps, s =>
				Math.max(s.node.meta?.contextChars ?? 0, s.node.meta?.chars ?? 0),
			) ?? 1

		const card = el('figure', {class: 'multiple'})
		const cap = el(
			'figcaption',
			{},
			el('span', {class: 'multiple-title'}, threadTitle),
			' ',
			el(
				'span',
				{class: 'badge', style: `--badge:${agentColor(agent)}`},
				agentDisplayName(agent),
			),
			el(
				'span',
				{class: 'multiple-meta'},
				`${fmtInt(t.steps.length)} steps · ${t.thread.children?.filter(c => c.kind === 'turn').length ?? 0} turns · ends at ${fmtCompact((last?.contextChars ?? 0) + (last?.chars ?? 0))} chars`,
			),
		)
		const host = el('div', {
			class: 'chart-host',
			role: 'group',
			'aria-label': `Context growth for ${threadTitle}; arrow keys move between steps`,
		})
		card.append(cap, host)
		grid.append(card)
		hosts.push(host)

		let lastW = 0
		const draw = (width: number): void => {
			lastW = width
			host.replaceChildren()
			const height = 236
			const m = {top: 24, right: 14, bottom: 40, left: 58}
			const yDomainMax = sharedScale ? globalMax : localMax
			const x = d3
				.scaleLinear()
				.domain([0, Math.max(1, t.steps.length - 1)])
				.range([m.left, width - m.right])
			const y = d3
				.scaleLinear()
				.domain([0, Math.max(1, yDomainMax)])
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
					`Context size over ${t.steps.length} steps in ${threadTitle}`,
				)
			svg.append('title').text(`Context growth: ${threadTitle}`)

			svg
				.append('g')
				.attr('class', 'axis')
				.attr('transform', `translate(0,${height - m.bottom})`)
				.call(
					d3
						.axisBottom(x)
						.ticks(Math.min(7, t.steps.length))
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
				.attr('y', height - 4)
				.attr('text-anchor', 'end')
				.text('step →')
			svg
				.append('text')
				.attr('class', 'axis-label')
				.attr('x', m.left)
				.attr('y', m.top - 8)
				.text(sharedScale ? 'context chars (shared)' : 'context chars (local)')

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

			const barW = Math.max(1, Math.min(6, (x(1) - x(0)) * 0.55))
			svg
				.append('g')
				.selectAll('rect')
				.data(t.steps)
				.join('rect')
				.attr('class', 'step-bar')
				.attr('x', (_, i) => x(i) - barW / 2)
				.attr('width', barW)
				.attr('y', s => y(Math.min(yDomainMax, s.node.meta?.chars ?? 0)))
				.attr(
					'height',
					s => y(0) - y(Math.min(yDomainMax, s.node.meta?.chars ?? 0)),
				)
				.attr('fill', s => agentColor(s.node.meta?.agent))
				.attr('fill-opacity', 0.25)

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
				.attr('stroke-width', 1.75)
				.attr('d', line)

			// Calm overplotting on dense threads (>45 steps) while keeping every step focusable/hoverable.
			const dense = t.steps.length > 45
			const r = d3
				.scaleSqrt()
				.domain([0, d3.max(t.steps, s => s.node.meta?.chars ?? 0) ?? 1])
				.range(dense ? [1.8, 5.2] : [2.8, 7.2])
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
				.attr('fill-opacity', dense ? 0.65 : 0.88)
				.attr('stroke', 'var(--bg)')
				.attr('stroke-width', dense ? 0.75 : 1.25)
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

		redrawFns.push(() => {
			if (lastW) draw(lastW)
		})
		resizeScope.observe(host, draw)
	}

	const setShared = (on: boolean) => {
		if (sharedScale === on) return
		sharedScale = on
		btnShared.setAttribute('aria-pressed', String(on))
		btnLocal.setAttribute('aria-pressed', String(!on))
		for (const fn of redrawFns) fn()
	}
	btnShared.onclick = () => setShared(true)
	btnLocal.onclick = () => setShared(false)

	wireInfoPanel(hosts, panel)
	const disposeRates = onRatesChange(container, panel.refresh)
	return () => {
		resizeScope.dispose()
		disposeRates()
	}
}
