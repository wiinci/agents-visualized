import * as d3 from 'd3'
import type {LoopNode, LoopsDataset} from '../types'
import {
	agentDisplayName,
	fmtCompact,
	fmtInt,
	nodeAriaLabel,
	statusColor,
	statusGlyph,
} from '../format'
import {createResizeScope, el, makeRoving} from '../util'
import {onRatesChange} from '../cost'
import {createInfoPanel, nodePanel, withCostRow, wireInfoPanel} from '../panel'

type TNode = d3.HierarchyPointNode<LoopNode>

function wrapLines(text: string, maxChars: number, maxLines = 2): string[] {
	const words = text.trim().split(/\s+/)
	const lines: string[] = []
	let cur = ''
	for (const w of words) {
		if (!cur) cur = w
		else if (cur.length + 1 + w.length <= maxChars) cur += ` ${w}`
		else {
			lines.push(cur)
			cur = w
			if (lines.length === maxLines - 1) break
		}
	}
	const restStart = lines.join(' ').length
	if (lines.length === maxLines - 1) {
		const remaining = text.trim().slice(restStart).trim()
		if (remaining.length > maxChars) {
			lines.push(`${remaining.slice(0, maxChars - 1).trimEnd()}…`)
		} else if (remaining) {
			lines.push(remaining)
		}
	} else if (cur) {
		lines.push(cur)
	}
	return lines
}

/**
 * Plate IV — Left-to-right delegation tree: root brief → subtasks → worker
 * threads. Circle area encodes dispatch prompt size; solid circles mark tasks,
 * hollow ringed circles mark worker threads; colour + glyph encode status.
 */
export function renderDelegation(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	// Unwrap empty synthetic `project/delegation` root when there is a single root brief beneath it.
	const effectiveRoot =
		ds.delegation.kind === 'project' &&
		(ds.delegation.meta?.chars ?? 0) === 0 &&
		ds.delegation.children?.length === 1
			? ds.delegation.children[0]!
			: ds.delegation

	const root = d3.hierarchy<LoopNode>(effectiveRoot)
	const all = root.descendants()
	const statuses = Array.from(
		new Set(all.map(d => d.data.meta?.status).filter((s): s is string => !!s)),
	)

	const legend = el('div', {
		class: 'legend',
		role: 'list',
		'aria-label': 'Status and node-type key',
	})
	for (const s of statuses)
		legend.append(
			el(
				'span',
				{class: 'legend-item', role: 'listitem'},
				el('i', {
					class: 'swatch swatch-circle',
					style: `--c:${statusColor(s)}`,
				}),
				`${statusGlyph(s)} ${s.replace(/_/g, ' ')}`,
			),
		)
	legend.append(
		el('span', {class: 'legend-sep', 'aria-hidden': 'true'}),
		el(
			'span',
			{class: 'legend-item', role: 'listitem'},
			el('i', {class: 'swatch swatch-circle', style: '--c:var(--fg-muted)'}),
			'Task',
		),
		el(
			'span',
			{class: 'legend-item', role: 'listitem'},
			el('i', {class: 'swatch swatch-ring'}),
			'Worker thread',
		),
	)

	const host = el('div', {
		class: 'chart-host',
		role: 'group',
		'aria-label':
			'Delegation tree; arrow keys move between tasks and worker threads',
	})

	const promptOf = (n: LoopNode): number =>
		n.meta?.promptChars ?? n.meta?.chars ?? 0

	const byId = new Map(all.map(d => [d.data.id, d.data]))
	const nodeContent = (n: LoopNode) => {
		const isWorker = n.kind === 'worker-thread'
		const content = withCostRow(
			nodePanel(n, [['children', fmtInt(n.children?.length ?? 0)]]),
			n.meta?.tokensEst,
			n.meta?.agent,
		)
		content.kicker = `${isWorker ? 'Worker thread' : 'Delegated task'} · ${n.meta?.status?.replace(/_/g, ' ') ?? 'observed'}`
		content.stats = isWorker
			? [
					['Thread output', `${fmtCompact(n.meta?.chars ?? 0)} chars`],
					['Dispatch prompt', `${fmtCompact(promptOf(n))} chars`],
				]
			: [
					['Prompt brief', `${fmtCompact(promptOf(n))} chars`],
					['Children', fmtInt(n.children?.length ?? 0)],
				]
		if (content.text)
			content.text.label = isWorker
				? 'Dispatch prompt (worker’s first user message)'
				: 'Task description / prompt'
		return content
	}

	const panel = createInfoPanel({
		headingId: 'delegation-panel-title',
		heading: 'Delegation details',
		contentFor: key => {
			const n = byId.get(key)
			return n ? nodeContent(n) : null
		},
		defaultContent: () => nodeContent(effectiveRoot),
	})

	const layout = el('div', {class: 'info-layout'}, host, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		`Reading key: ${fmtInt(all.filter(d => d.data.kind === 'task').length)} tasks and ${fmtInt(all.filter(d => d.data.kind === 'worker-thread').length)} worker threads. Dashed curves mark worker dispatches. Hover, focus, or click any node to inspect its full dispatch prompt.`,
	)
	container.append(legend, layout, foot)
	wireInfoPanel([host], panel)

	const r = d3
		.scaleSqrt()
		.domain([0, d3.max(all, d => promptOf(d.data)) ?? 1])
		.range([7, 20])

	const draw = (width: number): void => {
		host.replaceChildren()
		const leaves = Math.max(1, root.leaves().length)
		const height = Math.max(300, Math.min(820, leaves * 96 + 72))
		const m = {
			top: 36,
			right: Math.min(250, Math.max(175, width * 0.28)),
			bottom: 32,
			left: 36,
		}
		const tree = d3
			.tree<LoopNode>()
			.size([
				height - m.top - m.bottom,
				Math.max(220, width - m.left - m.right),
			])
			.separation((a, b) => (a.parent === b.parent ? 1.15 : 1.4))
		const laid = tree(root)

		const svg = d3
			.create('svg')
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('width', width)
			.attr('height', height)
			.attr('role', 'img')
			.attr(
				'aria-label',
				'Delegation tree from root task to subtasks to worker threads',
			)
		svg.append('title').text('Delegation tree (observed)')
		const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`)

		g.append('g')
			.attr('fill', 'none')
			.attr('class', 'tree-links')
			.selectAll('path')
			.data(laid.links())
			.join('path')
			.attr(
				'class',
				d =>
					`tree-link${d.target.data.kind === 'worker-thread' ? ' is-dispatch' : ''}`,
			)
			.attr('d', d => {
				if (d.target.data.kind === 'worker-thread') {
					const sx = d.source.y
					const sy = d.source.x
					const tx = d.target.y
					const ty = d.target.x
					const dip = 30
					return `M${sx},${sy} C${sx + 48},${sy + dip} ${tx - 48},${ty + dip} ${tx},${ty}`
				}
				return (
					d3
						.linkHorizontal<d3.HierarchyPointLink<LoopNode>, TNode>()
						.x(n => n.y)
						.y(n => n.x)(d) ?? ''
				)
			})

		const node = g
			.append('g')
			.selectAll<SVGGElement, TNode>('g')
			.data(laid.descendants())
			.join('g')
			.attr('class', 'tree-node')
			.attr('transform', d => `translate(${d.y},${d.x})`)
			.attr('data-hit', 'node')
			.attr('data-key', d => d.data.id)
			.attr('tabindex', -1)
			.attr('role', 'button')
			.attr(
				'aria-label',
				d =>
					`${nodeAriaLabel(d.data)}, prompt ${fmtInt(promptOf(d.data))} characters`,
			)

		node
			.append('circle')
			.attr('r', d => r(promptOf(d.data)))
			.attr('fill', d =>
				d.data.kind === 'worker-thread'
					? 'var(--bg)'
					: statusColor(d.data.meta?.status),
			)
			.attr('stroke', d => statusColor(d.data.meta?.status))
			.attr('stroke-width', d => (d.data.kind === 'worker-thread' ? 2.75 : 1.5))

		node
			.append('text')
			.attr('class', 'tree-glyph')
			.attr('dy', '0.35em')
			.attr('text-anchor', 'middle')
			.attr('fill', d =>
				d.data.kind === 'worker-thread'
					? statusColor(d.data.meta?.status)
					: '#faf8f4',
			)
			.text(d => statusGlyph(d.data.meta?.status))

		node.each(function (d) {
			const gNode = d3.select(this)
			const rad = r(promptOf(d.data))
			const isWorker = d.data.kind === 'worker-thread'
			const xOff = rad + 9

			if (isWorker) {
				// Worker leaf: lead with output scale & status rather than repeating the parent task title verbatim.
				const txt = gNode
					.append('text')
					.attr('class', 'tree-label')
					.attr('x', xOff)
					.attr('y', -3)
				txt
					.append('tspan')
					.attr('font-weight', '600')
					.text(
						`${agentDisplayName(d.data.meta?.agent)} · ${fmtCompact(d.data.meta?.chars ?? 0)} chars`,
					)
				txt
					.append('tspan')
					.attr('class', 'tree-sub')
					.attr('x', xOff)
					.attr('dy', '1.25em')
					.text(
						`${(d.data.meta?.status ?? 'worker').replace(/_/g, ' ')} · prompt ${fmtCompact(promptOf(d.data))}`,
					)
				return
			}

			// Task node: root label sits cleanly above its circle (never crossing the fan-out links);
			// child task labels sit right of their circles with 2-line wrapping.
			const isRoot = d.depth === 0
			const lines = wrapLines(d.data.name, isRoot ? 32 : 34, 2)
			const tx = isRoot ? 0 : xOff
			const yStart = isRoot
				? -(rad + 22 + (lines.length - 1) * 14)
				: lines.length > 1
					? -11
					: -3
			const txt = gNode
				.append('text')
				.attr('class', 'tree-label')
				.attr('x', tx)
				.attr('y', yStart)
			lines.forEach((ln, li) => {
				txt
					.append('tspan')
					.attr('x', tx)
					.attr('dy', li === 0 ? '0em' : '1.18em')
					.text(ln)
			})
			txt
				.append('tspan')
				.attr('class', 'tree-sub')
				.attr('x', tx)
				.attr('dy', '1.25em')
				.text(
					[
						d.data.meta?.status?.replace(/_/g, ' '),
						`prompt ${fmtCompact(promptOf(d.data))} chars`,
					]
						.filter(Boolean)
						.join(' · '),
				)
		})

		host.append(svg.node()!)
		makeRoving(host, '[data-hit]')
	}

	const resizeScope = createResizeScope()
	resizeScope.observe(container, draw)
	const disposeRates = onRatesChange(container, panel.refresh)
	return () => {
		resizeScope.dispose()
		disposeRates()
	}
}
