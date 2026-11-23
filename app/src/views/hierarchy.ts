import * as d3 from 'd3'
import type {LoopNode, LoopsDataset, NodeKind} from '../types'
import {buildThreadNames, projectDisplayName} from '../data'
import {
	agentColor,
	agentDisplayName,
	fmtCompact,
	fmtInt,
	fmtPct,
	nodeAriaLabel,
} from '../format'
import {createResizeScope, el, makeRoving, prefersReducedMotion} from '../util'
import {onRatesChange} from '../cost'
import {createInfoPanel, nodePanel, withCostRow, wireInfoPanel} from '../panel'

type HNode = d3.HierarchyRectangularNode<LoopNode>

const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
	'project',
	'thread',
	'worker-thread',
	'turn',
])

/**
 * Plate III — Horizontal icicle (d3.partition): depth runs left→right
 * (project → thread → turn → step → nested worker threads), bar height encodes
 * character volume, and colour encodes agent. Clicking any container zooms into
 * it; a semantic breadcrumb trail navigates back up the ancestry.
 */
export function renderHierarchy(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	const threadNames = buildThreadNames(ds)
	const projName = projectDisplayName(ds)

	const displayNameOf = (n: LoopNode): string => {
		if (n.kind === 'project') return projName
		if (n.kind === 'thread' || n.kind === 'worker-thread') {
			const tid = n.meta?.threadId ?? n.id
			return threadNames.get(tid)?.full ?? n.name
		}
		return n.name
	}
	const shortNameOf = (n: LoopNode): string => {
		if (n.kind === 'project') return projName
		if (n.kind === 'thread' || n.kind === 'worker-thread') {
			const tid = n.meta?.threadId ?? n.id
			return threadNames.get(tid)?.short ?? n.name
		}
		return n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name
	}

	const root = d3
		.hierarchy<LoopNode>(ds.hierarchy)
		.sum(d =>
			CONTAINER_KINDS.has(d.kind)
				? 0
				: Math.max(1, d.meta?.chars ?? d.value ?? 0),
		)
		.sort(
			(a, b) =>
				(a.data.meta?.stepIndex ?? 0) - (b.data.meta?.stepIndex ?? 0) ||
				(a.data.meta?.turnIndex ?? 0) - (b.data.meta?.turnIndex ?? 0),
		)

	const totalChars = root.value ?? 1

	const agents = Array.from(
		new Set(
			root
				.descendants()
				.map(d => d.data.meta?.agent)
				.filter((a): a is string => !!a),
		),
	)
	const legend = el('div', {
		class: 'legend',
		role: 'list',
		'aria-label': 'Agent colours',
	})
	for (const a of agents)
		legend.append(
			el(
				'span',
				{class: 'legend-item', role: 'listitem'},
				el('i', {class: 'swatch', style: `--c:${agentColor(a)}`}),
				agentDisplayName(a),
			),
		)

	const crumbNav = el('nav', {
		class: 'breadcrumb',
		'aria-label': 'Hierarchy zoom path',
	})
	const crumbList = el('ol', {})
	crumbNav.append(crumbList)
	const controls = el('div', {class: 'toolbar'}, legend, crumbNav)

	const host = el('div', {
		class: 'chart-host',
		role: 'group',
		'aria-label':
			'Turn hierarchy icicle; arrow keys move between cells, Enter zooms in',
	})

	const byId = new Map<string, HNode>()
	root.each(d => byId.set(d.data.id, d as HNode))

	const cellContent = (n: HNode) => {
		const chars = n.data.meta?.chars ?? n.value ?? 0
		const share = fmtPct(n.value ?? chars, totalChars)
		const extra: [string, string][] = [
			['share of project', share],
			['depth', String(n.depth)],
			['descendants', fmtInt(n.descendants().length - 1)],
			[
				'path',
				n
					.ancestors()
					.reverse()
					.map(a => displayNameOf(a.data))
					.join(' › '),
			],
		]
		const base = withCostRow(
			nodePanel(n.data, extra),
			n.data.meta?.tokensEst,
			n.data.meta?.agent,
		)
		base.title = displayNameOf(n.data)
		base.kicker = `${n.data.kind} · ${agentDisplayName(n.data.meta?.agent)}`
		base.stats = [
			['Volume', `${fmtCompact(chars)} chars`],
			['Project share', share],
		]
		return base
	}

	const panel = createInfoPanel({
		headingId: 'hierarchy-panel-title',
		heading: 'Cell details',
		contentFor: key => {
			const n = byId.get(key)
			return n ? cellContent(n) : null
		},
		defaultContent: () => {
			const r = byId.get(root.data.id)
			return r ? cellContent(r) : null
		},
	})
	const layout = el('div', {class: 'info-layout'}, host, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		`${fmtInt(root.descendants().length)} nodes total. Container columns (project, thread, turn) sit in lighter tints; individual steps use fuller fills. Click a container to drill in, or use the breadcrumb trail to back out.`,
	)
	container.append(controls, layout, foot)
	wireInfoPanel([host], panel, undefined, {pinOnClick: false})

	let focusNode: HNode | null = null
	let lastWidth = 0

	const updateBreadcrumbs = (zoomRoot: HNode, laid: HNode) => {
		crumbList.replaceChildren()
		const ancestors = zoomRoot.ancestors().reverse()
		ancestors.forEach((anc, idx) => {
			const isLast = idx === ancestors.length - 1
			const label = anc === laid ? projName : shortNameOf(anc.data)
			const btn = el(
				'button',
				{
					type: 'button',
					...(isLast ? {'aria-current': 'page'} : {}),
				},
				label,
			)
			if (!isLast) {
				btn.addEventListener('click', () => zoomTo(anc === laid ? null : anc))
			}
			crumbList.append(el('li', {}, btn))
		})
	}

	const draw = (width: number): void => {
		lastWidth = width
		host.replaceChildren()
		const maxDepth = root.height
		const colW = Math.max(125, Math.min(220, (width - 8) / (maxDepth + 1)))
		const height = Math.max(520, Math.min(960, root.leaves().length * 3.8))
		const partition = d3
			.partition<LoopNode>()
			.size([height, colW * (maxDepth + 1)])
			.padding(1)
		const laid = partition(root as d3.HierarchyNode<LoopNode>)
		const zoomRoot = focusNode ?? laid

		const y = d3
			.scaleLinear()
			.domain([zoomRoot.x0, zoomRoot.x1])
			.range([0, height])
		const xShift = zoomRoot.y0

		const svg = d3
			.create('svg')
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('width', width)
			.attr('height', height)
			.attr('role', 'img')
			.attr(
				'aria-label',
				'Icicle of project, threads, turns and steps sized by characters',
			)
		svg.append('title').text('Turn hierarchy (icicle, sized by chars)')

		const visible = laid
			.descendants()
			.filter(
				d =>
					d.x1 > zoomRoot.x0 &&
					d.x0 < zoomRoot.x1 &&
					d.y0 >= xShift &&
					d.y0 - xShift < width,
			)

		const fillOpacity = (d: HNode): number =>
			CONTAINER_KINDS.has(d.data.kind)
				? 0.24
				: d.data.kind === 'reasoning'
					? 0.55
					: d.data.kind === 'tool-result'
						? 0.78
						: 0.9

		const cell = svg
			.append('g')
			.selectAll<SVGGElement, HNode>('g')
			.data(visible)
			.join('g')
			.attr('class', 'ic-cell')
			.attr(
				'transform',
				d => `translate(${d.y0 - xShift},${y(Math.max(d.x0, zoomRoot.x0))})`,
			)
			.attr('data-hit', 'node')
			.attr('data-key', d => d.data.id)
			.attr('tabindex', -1)
			.attr('role', 'button')
			.attr('aria-label', d => nodeAriaLabel(d.data))
			.on('click', (_, d) => {
				if (d === zoomRoot && d.parent) zoomTo(d.parent as HNode)
				else if (d.children?.length) zoomTo(d)
			})
			.on('keydown', (ev: KeyboardEvent, d) => {
				if (ev.key === 'Enter' || ev.key === ' ') {
					ev.preventDefault()
					if (d === zoomRoot && d.parent) zoomTo(d.parent as HNode)
					else if (d.children?.length) zoomTo(d)
				}
			})

		cell
			.append('rect')
			.attr('width', d => Math.max(1, d.y1 - d.y0 - 1))
			.attr('height', d =>
				Math.max(
					1,
					y(Math.min(d.x1, zoomRoot.x1)) - y(Math.max(d.x0, zoomRoot.x0)) - 1,
				),
			)
			.attr('fill', d => agentColor(d.data.meta?.agent))
			.attr('fill-opacity', fillOpacity)
			.attr('rx', 2)

		const isInverted = (d: HNode): boolean => fillOpacity(d) >= 0.75

		const label = cell
			.append('text')
			.attr('x', 6)
			.attr('y', 16)
			.attr('class', d => `ic-label${isInverted(d) ? ' is-inv' : ''}`)
		label.append('tspan').text(d => shortNameOf(d.data))
		label
			.append('tspan')
			.attr('class', d => `ic-sub${isInverted(d) ? ' is-inv' : ''}`)
			.attr('x', 6)
			.attr('dy', 15)
			.text(d => {
				const chars = d.data.meta?.chars ?? d.value ?? 0
				return `${fmtCompact(chars)} · ${fmtPct(d.value ?? chars, totalChars)}`
			})

		label.style('display', d =>
			y(Math.min(d.x1, zoomRoot.x1)) - y(Math.max(d.x0, zoomRoot.x0)) < 35 ||
			d.y1 - d.y0 < 82
				? 'none'
				: null,
		)

		host.append(svg.node()!)
		makeRoving(host, '[data-hit]')
		updateBreadcrumbs(zoomRoot, laid)
	}

	const zoomTo = (n: HNode | null) => {
		focusNode = n && n.children ? n : n ? (n.parent as HNode | null) : null
		if (!prefersReducedMotion()) host.classList.add('is-fading')
		requestAnimationFrame(() => {
			if (lastWidth) draw(lastWidth)
			host.classList.remove('is-fading')
		})
	}

	const resizeScope = createResizeScope()
	resizeScope.observe(container, draw)
	const disposeRates = onRatesChange(container, panel.refresh)
	return () => {
		resizeScope.dispose()
		disposeRates()
	}
}
