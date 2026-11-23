import * as d3 from 'd3'
import {Delaunay} from 'd3'
import {
	sankey,
	sankeyJustify,
	type SankeyNode,
	type SankeyLink,
} from 'd3-sankey'
import type {FlowLink, FlowNode, LoopsDataset} from '../types'
import {fmtCompact, fmtInt, fmtPct, stageColor, stageLabel} from '../format'
import {createResizeScope, el, makeRoving, prefersReducedMotion} from '../util'
import {createInfoPanel, type PanelContent} from '../panel'
import {
	collectStageSizes,
	metricOf,
	originNode,
	rank,
	splitCycles,
} from './sankey-model'

/**
 * Plate II — Loop Sankey ("dots and hairlines" editorial plate).
 *
 * d3-sankey computes column ranks and vertical order; nodes render as
 * area-scaled circles (d3.scaleSqrt) and transitions as hairlines converging
 * on node edges. Hovering/focusing either a node OR a link highlights its
 * connected path and updates the sticky marginalia; clicking or pressing Enter
 * pins the selection until released.
 */

type SNode = SankeyNode<FlowNode, FlowLink>
type SLink = SankeyLink<FlowNode, FlowLink>
type Metric = 'context' | 'prompt'

const R_MAX = 14
const R_MIN = 2.5
const LINK_W = [1, 4] as const
const LINK_SAMPLE_PX = 10

interface ProximityTarget {
	kind: 'node' | 'link'
	key: string
	el: Element
	x: number
	y: number
}

const shortLabel = (stage: string): string =>
	stage.startsWith('tool:') ? stage.slice(5) : stageLabel(stage)
const CHAR_W = 8.2

const METRIC_LABEL: Record<Metric, string> = {
	context: 'context size',
	prompt: 'prompt size',
}
const METRIC_HELP: Record<Metric, string> = {
	context: 'mean cumulative context (chars) when steps of this stage ran',
	prompt: 'mean prompt length (user message, tool args, or dispatch brief)',
}

export function renderSankey(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	const {nodes, links} = ds.flows
	container.replaceChildren()
	if (!nodes.length) {
		container.append(el('p', {class: 'muted'}, 'No flow data.'))
		return () => {}
	}

	const {forward, back} = splitCycles(nodes, links)
	const nodeById = new Map(nodes.map(n => [n.id, n]))
	const backKeySet = new Set(back.map(l => `${l.source}->${l.target}`))
	const linkByKey = new Map<string, FlowLink>()
	for (const l of links) linkByKey.set(`${l.source}->${l.target}`, l)
	const sizes = collectStageSizes(ds.hierarchy, nodes)

	const maxBack = d3.max(back, l => l.value) ?? 0
	const backThreshold = Math.max(8, Math.round(maxBack * 0.18))
	const minorBackCount = back.filter(l => l.value < backThreshold).length

	let metric: Metric = 'context'
	let showAllBack = false

	// ── Editorial Toolbar: segmented metric toggle + concentric legend + loop-backs + zoom ──
	const btnContext = el(
		'button',
		{type: 'button', class: 'seg-btn', 'aria-pressed': 'true'},
		'Context size',
	)
	const btnPrompt = el(
		'button',
		{type: 'button', class: 'seg-btn', 'aria-pressed': 'false'},
		'Prompt size',
	)
	const metricGroup = el(
		'div',
		{class: 'seg-group', role: 'group', 'aria-label': 'Dot area metric'},
		btnContext,
		btnPrompt,
	)

	const backToggle = el(
		'button',
		{
			type: 'button',
			class: 'btn',
			'aria-pressed': 'false',
			title: 'Reveal minor loop-back transitions at rest',
		},
		`All loop-backs (${fmtInt(back.length)})`,
	)
	if (minorBackCount === 0) backToggle.hidden = true

	const legendHost = el('div', {class: 'sankey-legend', role: 'img'})

	const zoomIn = el(
		'button',
		{
			type: 'button',
			class: 'zoom-btn',
			'aria-label': 'Zoom in',
			title: 'Zoom in',
		},
		'+',
	)
	const zoomOut = el(
		'button',
		{
			type: 'button',
			class: 'zoom-btn',
			'aria-label': 'Zoom out',
			title: 'Zoom out',
		},
		'−',
	)
	const zoomFit = el(
		'button',
		{
			type: 'button',
			class: 'zoom-btn',
			'aria-label': 'Fit diagram to view',
			title: 'Fit to view',
		},
		'⛶',
	)
	const zoomReset = el(
		'button',
		{
			type: 'button',
			class: 'zoom-btn',
			'aria-label': 'Reset zoom',
			title: 'Reset zoom',
		},
		'↺',
	)
	zoomReset.hidden = true
	const zoomBar = el(
		'div',
		{class: 'zoom-controls', role: 'toolbar', 'aria-label': 'Zoom controls'},
		zoomIn,
		zoomOut,
		zoomFit,
		zoomReset,
	)

	const toolbar = el(
		'div',
		{class: 'sankey-toolbar'},
		el('span', {class: 'sankey-metric'}, 'Dot area', metricGroup),
		legendHost,
		backToggle,
		zoomBar,
	)

	const host = el('div', {
		class: 'chart-host sankey-host',
		role: 'group',
		'aria-label':
			'Loop Sankey diagram; use arrow keys to move between nodes and links',
	})
	const frame = el('div', {class: 'sankey-frame'}, host)

	// ── Marginalia content (nodes AND links) ───────────────────────────────
	const origin = originNode(nodes, links)
	const outTotalOf = (id: string): number =>
		links.filter(l => l.source === id).reduce((s, l) => s + l.value, 0)
	const inTotalOf = (id: string): number =>
		links.filter(l => l.target === id).reduce((s, l) => s + l.value, 0)

	const nodeContent = (n: FlowNode): PanelContent => {
		const inn = inTotalOf(n.id)
		const out = outTotalOf(n.id)
		const s = sizes.get(n.id)
		const ctx = metricOf(s, 'context')
		const pr = metricOf(s, 'prompt')
		const active = metricOf(s, metric)
		const secondary: [string, string] =
			metric === 'context'
				? [
						'mean prompt size',
						pr.n
							? `${fmtInt(Math.round(pr.mean))} chars (n=${fmtInt(pr.n)})`
							: '—',
					]
				: [
						'mean context size',
						ctx.n
							? `${fmtInt(Math.round(ctx.mean))} chars (n=${fmtInt(ctx.n)})`
							: '—',
					]

		return {
			kicker: `Stage · ${n.kind}`,
			title: stageLabel(n.stage),
			stats: [
				['Steps', fmtInt(n.count)],
				[
					`Mean ${metric}`,
					active.n ? `${fmtCompact(active.mean)} chars` : 'No data',
				],
			],
			rows: [
				[
					`mean ${METRIC_LABEL[metric]}`,
					active.n
						? `${fmtInt(Math.round(active.mean))} chars (n=${fmtInt(active.n)})`
						: 'hollow ring (no size data)',
				],
				secondary,
				[
					'mean tokens (est.)',
					s && s.tokensN
						? `≈${fmtInt(Math.round(s.tokensSum / s.tokensN))} / step`
						: '—',
				],
				['incoming', `${fmtInt(inn)} transitions`],
				['outgoing', `${fmtInt(out)} transitions`],
				['encoding', METRIC_HELP[metric]],
			],
		}
	}

	const linkContent = (linkKey: string): PanelContent | null => {
		const l = linkByKey.get(linkKey)
		if (!l) return null
		const src = nodeById.get(l.source)
		const tgt = nodeById.get(l.target)
		const isBack = backKeySet.has(linkKey)
		const isSelf = l.source === l.target
		const srcOut = outTotalOf(l.source)
		return {
			kicker: isSelf
				? 'Self-loop'
				: isBack
					? 'Return loop'
					: 'Forward transition',
			title: `${stageLabel(src?.stage ?? l.source)} → ${stageLabel(tgt?.stage ?? l.target)}`,
			stats: [
				['Transitions', fmtInt(l.value)],
				['Share of source', fmtPct(l.value, srcOut)],
			],
			rows: [
				['from stage', stageLabel(src?.stage ?? l.source)],
				['to stage', stageLabel(tgt?.stage ?? l.target)],
				[
					'direction',
					isSelf ? 'self-loop' : isBack ? 'return loop (cyclic)' : 'forward',
				],
				['edge kind', l.kind],
			],
		}
	}

	// Highlight state
	let svgSel: d3.Selection<SVGSVGElement, undefined, null, undefined> | null =
		null
	const clearHighlight = (): void => {
		if (!svgSel) return
		svgSel.classed('is-highlighting', false)
		svgSel.selectAll('.is-hi').classed('is-hi', false)
	}
	const highlightByKey = (kind: 'node' | 'link', key: string): void => {
		if (!svgSel) return
		clearHighlight()
		svgSel.classed('is-highlighting', true)
		if (kind === 'node') {
			svgSel
				.selectAll<SVGPathElement, unknown>('.sankey-link')
				.filter(function () {
					const k = this.getAttribute('data-key') ?? ''
					const [s, t] = k.split('->')
					return s === key || t === key
				})
				.classed('is-hi', true)
			svgSel
				.selectAll<SVGGElement, unknown>('.sankey-node')
				.filter(function () {
					const id = this.getAttribute('data-key') ?? ''
					if (id === key) return true
					return links.some(
						l =>
							(l.source === key && l.target === id) ||
							(l.target === key && l.source === id),
					)
				})
				.classed('is-hi', true)
		} else {
			const [s, t] = key.split('->')
			svgSel
				.selectAll<SVGPathElement, unknown>('.sankey-link')
				.filter(function () {
					return this.getAttribute('data-key') === key
				})
				.classed('is-hi', true)
			svgSel
				.selectAll<SVGGElement, unknown>('.sankey-node')
				.filter(function () {
					const id = this.getAttribute('data-key')
					return id === s || id === t
				})
				.classed('is-hi', true)
		}
	}
	const highlightFor = (target: Element): void => {
		const key = target.getAttribute('data-key') ?? ''
		const kind = target.getAttribute('data-hit') === 'link' ? 'link' : 'node'
		highlightByKey(kind, key)
	}

	const panel = createInfoPanel({
		headingId: 'sankey-panel-title',
		heading: 'Stage & transition details',
		contentFor: key => {
			if (key.startsWith('link:')) return linkContent(key.slice(5))
			const n = nodeById.get(key)
			return n ? nodeContent(n) : null
		},
		defaultContent: () => (origin ? nodeContent(origin) : null),
		onPinChange: pinned => {
			if (pinned === null) {
				clearHighlight()
			} else if (pinned.startsWith('link:')) {
				highlightByKey('link', pinned.slice(5))
			} else {
				highlightByKey('node', pinned)
			}
		},
	})

	const layout = el('div', {class: 'sankey-layout'}, frame, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		`Hollow rings mark stages with no recorded size. `,
		`${fmtInt(back.length)} return arcs curve underneath as dashed lines, with minor cycles under ${fmtInt(backThreshold)}× dimmed until hovered or toggled. `,
		`Drag to pan, scroll with Ctrl/⌘ to zoom, and click any dot or line to pin its notes.`,
	)
	container.append(toolbar, layout, foot)

	// ── Concentric bottom-aligned area legend (compact editorial bubble key) ──
	const drawLegend = (max: number): void => {
		legendHost.replaceChildren()
		const r = d3
			.scaleSqrt()
			.domain([0, Math.max(1, max)])
			.range([0, R_MAX])
		const values = max > 0 ? [max, max / 4, max / 16] : []
		const cx = R_MAX + 2
		const base = R_MAX * 2 + 12
		const labelX = R_MAX * 2 + 16
		const w = values.length ? labelX + 94 : 116
		const h = base + 6
		const svg = d3
			.create('svg')
			.attr('width', w)
			.attr('height', h)
			.attr('viewBox', `0 0 ${w} ${h}`)
			.attr('aria-hidden', 'true')
		const g = svg.append('g').attr('class', 'legend-circles')
		const labelYs = [8, 22, 36]
		values.forEach((v, i) => {
			const rad = r(v)
			const topY = base - rad * 2
			const ly = labelYs[i] ?? topY
			g.append('circle')
				.attr('cx', cx)
				.attr('cy', base - rad)
				.attr('r', rad)
			g.append('line')
				.attr('x1', cx)
				.attr('x2', labelX - 4)
				.attr('y1', topY)
				.attr('y2', ly)
			g.append('text')
				.attr('x', labelX)
				.attr('y', ly + 4)
				.text(`${fmtCompact(v)}${i === 0 ? ' chars' : ''}`)
		})
		if (!values.length)
			g.append('text')
				.attr('x', 0)
				.attr('y', base - 4)
				.text('no size data')
		legendHost.setAttribute(
			'aria-label',
			values.length
				? `Area legend: circles of ${values.map(v => fmtInt(Math.round(v))).join(', ')} characters, mean ${METRIC_LABEL[metric]} per step`
				: 'Area legend: no size data',
		)
		legendHost.append(svg.node()!)
	}

	// ── Draw ────────────────────────────────────────────────────────────────
	let lastWidth = 0
	let zoom: d3.ZoomBehavior<SVGSVGElement, undefined> | null = null
	let contentBox = {x: 0, y: 0, w: 0, h: 0}
	let viewport = {w: 0, h: 0}
	let lastHoverTarget: ProximityTarget | null = null

	const draw = (width: number): void => {
		lastWidth = width
		host.replaceChildren()
		const height = Math.max(460, Math.min(800, nodes.length * 44))
		const labelOf = (n: FlowNode): string =>
			`${shortLabel(n.stage)} · ${fmtInt(n.count)}`
		const labelW = (pred: (n: FlowNode) => boolean): number =>
			(d3.max(nodes.filter(pred), n => labelOf(n).length) ?? 0) * CHAR_W
		const maxRank = d3.max(nodes, n => rank(n.stage)) ?? 0
		const margin = {
			top: 42 + R_MAX,
			right: 18 + R_MAX + 10 + labelW(n => rank(n.stage) === maxRank),
			bottom: 44 + R_MAX,
			left: 18 + R_MAX + 10 + labelW(n => rank(n.stage) === 0),
		}
		viewport = {w: width, h: height}

		const ranksPresent = [...new Set(nodes.map(n => rank(n.stage)))].sort(
			d3.ascending,
		)
		const layerOf = new Map(ranksPresent.map((rk, i) => [rk, i]))
		const makeGen = (pinned: boolean) => {
			const gen = sankey<FlowNode, FlowLink>()
				.nodeId(d => d.id)
				.nodeWidth(1)
				.nodePadding(24)
				.nodeSort((a, b) => d3.descending(a.value ?? 0, b.value ?? 0))
				.extent([
					[margin.left, margin.top],
					[width - margin.right, height - margin.bottom],
				])
			return pinned
				? gen.nodeAlign((node, n) =>
						Math.min(n - 1, layerOf.get(rank(node.stage)) ?? 0),
					)
				: gen.nodeAlign(sankeyJustify)
		}
		const input = () => ({
			nodes: nodes.map(n => ({...n})),
			links: forward.map(l => ({...l})),
		})
		let graph: ReturnType<ReturnType<typeof makeGen>>
		try {
			graph = makeGen(true)(input())
		} catch {
			graph = makeGen(false)(input())
		}

		const cx = (n: SNode): number => n.x0 ?? 0
		const cy = (n: SNode): number => ((n.y0 ?? 0) + (n.y1 ?? 0)) / 2
		const pos = new Map(graph.nodes.map(n => [n.id, n]))
		const minX = d3.min(graph.nodes, cx) ?? 0

		const columns = d3
			.groups(graph.nodes, n => Math.round(cx(n)))
			.sort((a, b) => a[0] - b[0])
		const family = (s: string): string => (s.startsWith('tool:') ? 'tool' : s)

		const metricValue = (id: string): number =>
			metricOf(sizes.get(id), metric).mean
		const maxMetric = d3.max(nodes, n => metricValue(n.id)) ?? 0
		const r = d3
			.scaleSqrt()
			.domain([0, Math.max(1, maxMetric)])
			.range([0, R_MAX])
		const radiusOf = (id: string): {r: number; hollow: boolean} => {
			const rr = r(metricValue(id))
			return rr < R_MIN ? {r: R_MIN, hollow: true} : {r: rr, hollow: false}
		}
		drawLegend(maxMetric)

		const linkW = d3
			.scaleSqrt()
			.domain([0, d3.max(links, l => l.value) ?? 1])
			.range([LINK_W[0], LINK_W[1]])

		const svg = d3
			.create('svg')
			.attr('viewBox', `0 0 ${width} ${height}`)
			.attr('width', width)
			.attr('height', height)
			.attr('role', 'img')
			.attr('class', `sankey-svg${showAllBack ? ' show-all-back' : ''}`)
			.attr(
				'aria-label',
				`Sankey of observed step-stage transitions; dot area shows mean ${METRIC_LABEL[metric]} per step`,
			)
		svg.append('title').text('Observed step-stage transitions (Sankey)')
		svgSel = svg

		const layer = svg.append('g').attr('class', 'zoom-layer')

		layer
			.append('g')
			.attr('class', 'sankey-headers')
			.selectAll('text')
			.data(columns)
			.join('text')
			.attr('class', 'sankey-header')
			.attr('x', ([, ns]) => cx(ns[0]!))
			.attr('y', 18)
			.attr('text-anchor', (_, i) =>
				i === 0 ? 'end' : i === columns.length - 1 ? 'start' : 'middle',
			)
			.attr('dx', (_, i) => (i === 0 ? 6 : i === columns.length - 1 ? -6 : 0))
			.text(([, ns]) => [...new Set(ns.map(n => family(n.stage)))].join(' / '))

		const linkPath = d3.linkHorizontal<
			{source: [number, number]; target: [number, number]},
			[number, number]
		>()
		const shorten = (
			s: SNode,
			t: SNode,
		): {source: [number, number]; target: [number, number]} => {
			const rs = radiusOf(s.id).r
			const rt = radiusOf(t.id).r
			return {source: [cx(s) + rs, cy(s)], target: [cx(t) - rt, cy(t)]}
		}

		layer
			.append('g')
			.attr('fill', 'none')
			.attr('class', 'sankey-links')
			.selectAll<SVGPathElement, SLink>('path')
			.data(graph.links)
			.join('path')
			.attr('class', 'sankey-link')
			.attr(
				'd',
				d => linkPath(shorten(d.source as SNode, d.target as SNode)) ?? '',
			)
			.attr('stroke-width', d => linkW(d.value))
			.attr(
				'data-key',
				d => `${(d.source as SNode).id}->${(d.target as SNode).id}`,
			)

		const hitsG = layer
			.append('g')
			.attr('fill', 'none')
			.attr('class', 'sankey-hits')

		const backG = layer
			.append('g')
			.attr('fill', 'none')
			.attr('class', 'sankey-back')
		const backPath = (d: FlowLink): string => {
			const s = pos.get(d.source)
			const t = pos.get(d.target)
			if (!s || !t) return ''
			const rs = radiusOf(s.id).r
			const rt = radiusOf(t.id).r
			const x0 = cx(s)
			const x1 = cx(t)
			if (d.source === d.target) {
				const y = cy(s) - rs
				return `M${x0 - 2.5},${y} C${x0 - 15},${y - 18} ${x0 + 15},${y - 18} ${x0 + 2.5},${y}`
			}
			const y0 = cy(s) + rs
			const y1 = cy(t) + rt
			const bow = 26 + Math.abs(x1 - x0) * 0.14
			return `M${x0},${y0} C${x0},${Math.max(y0, y1) + bow} ${x1},${Math.max(y0, y1) + bow} ${x1},${y1}`
		}
		backG
			.selectAll<SVGPathElement, FlowLink>('path')
			.data(back)
			.join('path')
			.attr(
				'class',
				d => `sankey-link is-back${d.value < backThreshold ? ' is-minor' : ''}`,
			)
			.attr('stroke-width', d => Math.max(1, linkW(d.value) * 0.7))
			.attr('stroke-dasharray', '4 3')
			.attr('d', backPath)
			.attr('data-key', d => `${d.source}->${d.target}`)

		const hitSpecs = [
			...graph.links.map(d => ({
				d: linkPath(shorten(d.source as SNode, d.target as SNode)) ?? '',
				key: `${(d.source as SNode).id}->${(d.target as SNode).id}`,
				label: `${stageLabel((d.source as SNode).stage)} to ${stageLabel((d.target as SNode).stage)}, ${fmtInt(d.value)} transitions`,
			})),
			...back.map(d => ({
				d: backPath(d),
				key: `${d.source}->${d.target}`,
				label: `loop back: ${stageLabel(nodeById.get(d.source)?.stage ?? '')} to ${stageLabel(nodeById.get(d.target)?.stage ?? '')}, ${fmtInt(d.value)} transitions`,
			})),
		]
		hitsG
			.selectAll<SVGPathElement, (typeof hitSpecs)[number]>('path')
			.data(hitSpecs)
			.join('path')
			.attr('class', 'sankey-linkhit')
			.attr('d', d => d.d)
			.attr('stroke-width', 8)
			.attr('data-hit', 'link')
			.attr('data-key', d => d.key)
			.attr('tabindex', -1)
			.attr('role', 'button')
			.attr('aria-label', d => d.label)

		backG
			.selectAll<SVGCircleElement, FlowLink>('circle')
			.data(back.filter(d => d.source !== d.target))
			.join('circle')
			.attr(
				'class',
				d => `sankey-back-dot${d.value < backThreshold ? ' is-minor' : ''}`,
			)
			.attr('r', 1.75)
			.attr('cx', d => cx(pos.get(d.target)!))
			.attr('cy', d => cy(pos.get(d.target)!) + radiusOf(d.target).r + 2)

		// Smart label anchoring: place left of dot when the node fans out heavily rightward (user, reason)
		// so labels stay clear of outgoing link bundles.
		const labelLeft = (d: SNode): boolean =>
			cx(d) === minX || d.stage === 'reason'

		const node = layer
			.append('g')
			.attr('class', 'sankey-nodes')
			.selectAll<SVGGElement, SNode>('g')
			.data(graph.nodes)
			.join('g')
			.attr(
				'class',
				d => `sankey-node${radiusOf(d.id).hollow ? ' is-empty' : ''}`,
			)
			.attr('transform', d => `translate(${cx(d)},${cy(d)})`)
			.attr('data-hit', 'node')
			.attr('data-key', d => d.id)
			.attr('tabindex', -1)
			.attr('role', 'button')
			.attr('aria-label', d => {
				const m = metricOf(sizes.get(d.id), metric)
				return `${stageLabel(d.stage)}, ${fmtInt(d.count)} steps, mean ${METRIC_LABEL[metric]} ${m.n ? fmtInt(Math.round(m.mean)) + ' characters' : 'unknown'}`
			})
		node
			.append('circle')
			.attr('class', 'sankey-dot')
			.attr('r', d => radiusOf(d.id).r)
			.attr('fill', d => (radiusOf(d.id).hollow ? 'none' : stageColor(d.stage)))
			.attr('stroke', d => stageColor(d.stage))
		node.append('circle').attr('class', 'sankey-hit').attr('r', 9)
		node
			.append('text')
			.attr('class', 'sankey-label')
			.attr('x', d =>
				labelLeft(d) ? -(radiusOf(d.id).r + 8) : radiusOf(d.id).r + 8,
			)
			.attr('text-anchor', d => (labelLeft(d) ? 'end' : 'start'))
			.attr('dy', '0.35em')
			.text(d => labelOf(d))

		host.append(svg.node()!)
		const bb = (layer.node() as SVGGElement).getBBox()
		contentBox = {x: bb.x, y: bb.y, w: bb.width, h: bb.height}

		const targets: ProximityTarget[] = graph.nodes.map(d => ({
			kind: 'node',
			key: d.id,
			el: node.nodes().find(g => g.getAttribute('data-key') === d.id)!,
			x: cx(d),
			y: cy(d),
		}))
		hitsG
			.selectAll<SVGPathElement, {key: string}>('path')
			.nodes()
			.forEach(p => {
				const len = p.getTotalLength()
				const steps = Math.max(1, Math.round(len / LINK_SAMPLE_PX))
				for (let i = 0; i <= steps; i++) {
					const pt = p.getPointAtLength((len * i) / steps)
					targets.push({
						kind: 'link',
						key: p.getAttribute('data-key') ?? '',
						el: p,
						x: pt.x,
						y: pt.y,
					})
				}
			})
		const delaunay = Delaunay.from(
			targets,
			t => t.x,
			t => t.y,
		)

		const panelKeyFor = (t: ProximityTarget): string =>
			t.kind === 'link' ? `link:${t.key}` : t.key

		const overlay = svg
			.append('rect')
			.attr('class', 'sankey-overlay')
			.attr('width', width)
			.attr('height', height)
			.attr('fill', 'transparent')
			.attr('aria-hidden', 'true')

		const clearHover = (): void => {
			lastHoverTarget = null
			const pinned = panel.pinnedKey()
			if (pinned !== null) {
				if (pinned.startsWith('link:')) highlightByKey('link', pinned.slice(5))
				else highlightByKey('node', pinned)
				return
			}
			const focused = document.activeElement?.closest('[data-hit]')
			if (focused && host.contains(focused)) {
				highlightFor(focused)
				panel.showKey(markKeyOf(focused))
			} else {
				clearHighlight()
				panel.showKey(null)
			}
		}

		overlay.on('pointermove', (ev: PointerEvent) => {
			if (panel.pinnedKey() !== null) return
			const focused = document.activeElement?.closest('[data-hit]')
			if (focused && host.contains(focused)) {
				highlightFor(focused)
				panel.showKey(markKeyOf(focused))
				return
			}
			const [x, y] = d3.pointer(ev, layer.node())
			const t = targets[delaunay.find(x, y)]!
			lastHoverTarget = t
			highlightFor(t.el)
			panel.showKey(panelKeyFor(t))
		})
		overlay.on('pointerleave', () => clearHover())
		overlay.on('click', (ev: MouseEvent) => {
			const [x, y] = d3.pointer(ev, layer.node())
			const t = lastHoverTarget ?? targets[delaunay.find(x, y)]
			if (t) panel.pinKey(panelKeyFor(t))
		})

		zoom = d3
			.zoom<SVGSVGElement, undefined>()
			.scaleExtent([0.5, 8])
			.filter((ev: Event) => {
				if (ev.type === 'wheel')
					return (ev as WheelEvent).ctrlKey || (ev as WheelEvent).metaKey
				return !(ev as MouseEvent).button
			})
			.on('zoom', (ev: d3.D3ZoomEvent<SVGSVGElement, undefined>) => {
				layer.attr('transform', ev.transform.toString())
				const isIdentity =
					Math.abs(ev.transform.k - 1) < 0.01 &&
					Math.abs(ev.transform.x) < 1 &&
					Math.abs(ev.transform.y) < 1
				zoomReset.hidden = isIdentity
			})
		svg.call(zoom)
		svg.on('dblclick.zoom', null)

		// Restore active pinned highlight across redraws
		const pinned = panel.pinnedKey()
		if (pinned !== null) {
			if (pinned.startsWith('link:')) highlightByKey('link', pinned.slice(5))
			else highlightByKey('node', pinned)
		}

		makeRoving(host, '[data-hit]')
		panel.refresh()
	}

	const markKeyOf = (mark: Element | null): string | null => {
		if (!mark) return null
		const k = mark.getAttribute('data-key')
		if (!k) return null
		return mark.getAttribute('data-hit') === 'link' ? `link:${k}` : k
	}

	host.addEventListener('focusin', e => {
		if (panel.pinnedKey() !== null) return
		const t = (e.target as Element).closest('[data-hit]')
		if (t) highlightFor(t)
		panel.showKey(markKeyOf(t))
	})
	host.addEventListener('focusout', e => {
		if (panel.pinnedKey() !== null) return
		const nx = e.relatedTarget as Element | null
		if (!nx || !nx.closest('[data-hit]')) clearHighlight()
		if (markKeyOf(nx?.closest('[data-hit]') ?? null) === null)
			panel.showKey(null)
	})
	host.addEventListener('keydown', e => {
		const ke = e as KeyboardEvent
		if (ke.key === 'Escape' && panel.pinnedKey() !== null) {
			ke.preventDefault()
			panel.pinKey(null)
			return
		}
		if (ke.key === 'Enter' || ke.key === ' ') {
			const t = (ke.target as Element | null)?.closest('[data-hit]')
			const k = markKeyOf(t ?? null)
			if (k) {
				ke.preventDefault()
				panel.pinKey(k)
			}
		}
	})
	const onDocEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && panel.pinnedKey() !== null) panel.pinKey(null)
	}
	document.addEventListener('keydown', onDocEsc)

	const zoomTo = (t: d3.ZoomTransform): void => {
		if (!zoom || !svgSel) return
		const sel = prefersReducedMotion()
			? svgSel
			: (svgSel.transition().duration(250) as unknown as typeof svgSel)
		zoom.transform(sel, t)
	}
	const scaleBy = (k: number): void => {
		if (!zoom || !svgSel) return
		const sel = prefersReducedMotion()
			? svgSel
			: (svgSel.transition().duration(200) as unknown as typeof svgSel)
		zoom.scaleBy(sel, k)
	}
	zoomIn.onclick = () => scaleBy(1.4)
	zoomOut.onclick = () => scaleBy(1 / 1.4)
	zoomReset.onclick = () => zoomTo(d3.zoomIdentity)
	zoomFit.onclick = () => {
		if (!contentBox.w || !contentBox.h) return
		const pad = 12
		const k = Math.min(
			8,
			Math.max(
				0.5,
				Math.min(
					(viewport.w - 2 * pad) / contentBox.w,
					(viewport.h - 2 * pad) / contentBox.h,
				),
			),
		)
		const tx = (viewport.w - k * contentBox.w) / 2 - k * contentBox.x
		const ty = (viewport.h - k * contentBox.h) / 2 - k * contentBox.y
		zoomTo(d3.zoomIdentity.translate(tx, ty).scale(k))
	}

	const setMetric = (m: Metric) => {
		if (metric === m) return
		metric = m
		btnContext.setAttribute('aria-pressed', String(m === 'context'))
		btnPrompt.setAttribute('aria-pressed', String(m === 'prompt'))
		if (lastWidth) draw(lastWidth)
	}
	btnContext.onclick = () => setMetric('context')
	btnPrompt.onclick = () => setMetric('prompt')

	backToggle.onclick = () => {
		showAllBack = !showAllBack
		backToggle.setAttribute('aria-pressed', String(showAllBack))
		svgSel?.classed('show-all-back', showAllBack)
	}

	const resizeScope = createResizeScope()
	resizeScope.observe(container, draw)
	return () => {
		resizeScope.dispose()
		document.removeEventListener('keydown', onDocEsc)
	}
}
