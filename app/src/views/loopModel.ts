import * as d3 from 'd3'
import type {LoopModelLoop, LoopPhase, LoopsDataset} from '../types'
import {KIND_LABEL, fmtInt} from '../format'
import {createResizeScope, el, makeRoving} from '../util'
import {createInfoPanel, wireInfoPanel, type PanelContent} from '../panel'

const BOILERPLATE_LEAD_RE =
	/^(?:documented model|canonical model|not observed)\b[^.?!]*[.?!]\s+/i

/**
 * Remove repeated provenance boilerplate (such as "Documented model (from
 * Obvious operating instructions), not observed.") shared across loop cards,
 * since Plate I states that context once in its header and deck.
 */
export function cleanLoopDescriptions(
	descriptions: readonly string[],
): string[] {
	const trimmed = descriptions.map(d => d.trim())
	let sharedLead = ''
	if (trimmed.length >= 2) {
		const firstMatch = trimmed[0]?.match(/^[^.?!]+[.?!]\s+/)
		if (firstMatch) {
			const candidate = firstMatch[0]
			if (
				trimmed.every(
					d => d.startsWith(candidate) && d.length > candidate.length,
				)
			) {
				sharedLead = candidate
			}
		}
	}
	return trimmed.map(d => {
		const withoutShared = sharedLead ? d.slice(sharedLead.length) : d
		return withoutShared.replace(BOILERPLATE_LEAD_RE, '').trim()
	})
}

/**
 * Plate I: The five operating loops from `loopModel`, each drawn as a directed
 * cycle in a spacious 2-column grid paired with sticky marginalia. Hovering,
 * focusing, or clicking any phase or edge reveals its specification and mapped
 * trace node kinds.
 */
export function renderLoopModel(
	container: HTMLElement,
	ds: LoopsDataset,
): () => void {
	container.replaceChildren()
	const loops = ds.loopModel.loops
	const cleanDescriptions = cleanLoopDescriptions(loops.map(l => l.description))
	const grid = el('div', {class: 'loops-grid'})

	const contentMap = new Map<string, PanelContent>()
	const loopPhaseKeys = new Map<string, string[]>()
	const loopEdgeKeys = new Map<string, string[]>()
	for (const loop of loops) {
		const phaseById = new Map(loop.phases.map(p => [p.id, p]))
		const pKeys: string[] = []
		loop.phases.forEach((p, idx) => {
			const k = `phase:${loop.id}:${p.id}`
			pKeys.push(k)
			contentMap.set(k, {
				kicker: `Phase · ${loop.name}`,
				title: `${idx + 1}. ${p.name}`,
				accent: 'var(--fg)',
				stats: [
					['Position', `${idx + 1} of ${loop.phases.length}`],
					['Trace kinds', String(p.observedKinds.length)],
				],
				share: {
					ratio: (idx + 1) / loop.phases.length,
					label: `step ${idx + 1} of ${loop.phases.length} in ${loop.name}`,
				},
				rows: [
					[
						'trace kinds',
						p.observedKinds.length
							? p.observedKinds.map(k => KIND_LABEL[k] ?? k).join(', ')
							: 'conceptual only',
					],
				],
				text: {
					body: p.description,
					mono: false,
					label: 'Specification',
				},
			})
		})
		loopPhaseKeys.set(loop.id, pKeys)

		const eKeys: string[] = []
		loop.edges.forEach((e, idx) => {
			const k = `edge:${loop.id}:${idx}`
			eKeys.push(k)
			const fromName = phaseById.get(e.from)?.name ?? e.from
			const toName = phaseById.get(e.to)?.name ?? e.to
			contentMap.set(k, {
				kicker: `Transition · ${e.kind}`,
				title: `${fromName} → ${toName}`,
				accent:
					e.kind === 'repeat'
						? '#9a4a12'
						: e.kind === 'exit'
							? '#15803d'
							: 'var(--fg-muted)',
				rows: [
					['loop', loop.name],
					['condition', e.label ?? 'unconditional step'],
				],
			})
		})
		loopEdgeKeys.set(loop.id, eKeys)
	}

	const totalPhases = loops.reduce((n, l) => n + l.phases.length, 0)
	const totalRepeats = loops.reduce(
		(n, l) => n + l.edges.filter(e => e.kind === 'repeat').length,
		0,
	)

	const allPhaseKeys = [...loopPhaseKeys.values()].flat()
	const panel = createInfoPanel({
		headingId: 'loops-panel-title',
		heading: 'Phase specification',
		contentFor: key => contentMap.get(key) ?? null,
		sequenceFor: key => {
			if (key === null) return allPhaseKeys
			const parts = key.split(':')
			const kind = parts[0]
			const loopId = parts[1] ?? ''
			if (kind === 'phase') return allPhaseKeys
			if (kind === 'edge') return loopEdgeKeys.get(loopId) ?? null
			return allPhaseKeys
		},
		defaultContent: () => ({
			kicker: 'Reference blueprint',
			title: 'Five operating loops',
			stats: [
				['Loops', fmtInt(loops.length)],
				[
					'Phases / repeats',
					`${fmtInt(totalPhases)} / ${fmtInt(totalRepeats)}`,
				],
			],
			rows: loops.map((l): [string, string] => [
				l.name,
				`${l.phases.length} phases`,
			]),
		}),
	})

	const hosts: HTMLElement[] = []
	const resizeScope = createResizeScope()
	loops.forEach((loop, loopIdx) => {
		const fig = el('figure', {class: 'multiple loop-card'})
		fig.append(
			el(
				'figcaption',
				{},
				el('span', {class: 'multiple-title'}, loop.name),
				el('span', {class: 'multiple-meta'}, cleanDescriptions[loopIdx] ?? ''),
			),
		)
		const host = el('div', {
			class: 'chart-host',
			role: 'group',
			'aria-label': `${loop.name} loop; arrow keys move between phases and edges`,
		})
		fig.append(host)
		grid.append(fig)
		hosts.push(host)

		resizeScope.observe(host, w => drawLoop(host, loop, Math.max(260, w)))
	})

	const layout = el('div', {class: 'info-layout'}, grid, panel.root)
	const foot = el(
		'footer',
		{class: 'plate-foot'},
		'Solid grey arrows advance the cycle, dashed amber arrows loop back to repeat, and green arrows exit. Select any numbered phase or arrow to read its spec.',
	)
	container.append(layout, foot)
	const disposeWire = wireInfoPanel(hosts, panel)
	return () => {
		disposeWire()
		resizeScope.dispose()
	}
}

function wrapWords(text: string, maxChars: number): string[] {
	const words = text.split(/\s+/)
	const lines: string[] = []
	let cur = ''
	for (const w of words) {
		if (!cur) {
			cur = w
		} else if (cur.length + 1 + w.length <= maxChars) {
			cur += ` ${w}`
		} else {
			lines.push(cur)
			cur = w
		}
	}
	if (cur) lines.push(cur)
	return lines
}

function drawLoop(host: HTMLElement, loop: LoopModelLoop, width: number): void {
	host.replaceChildren()
	const n = loop.phases.length
	const size = Math.min(width, 350)
	const cx = width / 2
	const cy = size / 2
	const R = Math.max(66, size / 2 - 68)
	const nodeR = 19
	const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n
	const pos = (i: number) => ({
		x: cx + R * Math.cos(angle(i)),
		y: cy + R * Math.sin(angle(i)),
	})
	const idx = new Map(loop.phases.map((p, i) => [p.id, i]))

	const svg = d3
		.create('svg')
		.attr('viewBox', `0 0 ${width} ${size}`)
		.attr('width', width)
		.attr('height', size)
		.attr('role', 'img')
		.attr('aria-label', `${loop.name}: ${n} phases, ${loop.edges.length} edges`)
	svg.append('title').text(`${loop.name} (reference blueprint)`)

	const defs = svg.append('defs')
	for (const k of ['next', 'repeat', 'exit']) {
		defs
			.append('marker')
			.attr('id', `lm-arrow-${loop.id}-${k}`)
			.attr('viewBox', '0 0 10 10')
			.attr('refX', 8.5)
			.attr('refY', 5)
			.attr('markerWidth', 6.5)
			.attr('markerHeight', 6.5)
			.attr('orient', 'auto')
			.append('path')
			.attr('d', 'M0,0 L10,5 L0,10 z')
			.attr('class', `lm-arrowhead is-${k}`)
	}

	// Edges
	const edgeG = svg.append('g').attr('fill', 'none')
	edgeG
		.selectAll<SVGPathElement, {e: LoopModelLoop['edges'][number]; i: number}>(
			'path',
		)
		.data(loop.edges.map((e, i) => ({e, i})))
		.join('path')
		.attr('class', d => `lm-edge is-${d.e.kind}`)
		.attr('marker-end', d => `url(#lm-arrow-${loop.id}-${d.e.kind})`)
		.attr('d', d => {
			const a = idx.get(d.e.from) ?? 0
			const b = idx.get(d.e.to) ?? 0
			const p = pos(a)
			const q = pos(b)
			if (a === b) {
				const ang = angle(a)
				return `M${p.x + nodeR * Math.cos(ang - 0.6)},${p.y + nodeR * Math.sin(ang - 0.6)} A15,15 0 1,1 ${p.x + nodeR * Math.cos(ang + 0.6)},${p.y + nodeR * Math.sin(ang + 0.6)}`
			}
			const dx = q.x - p.x
			const dy = q.y - p.y
			const dist = Math.hypot(dx, dy)
			const ux = dx / dist
			const uy = dy / dist
			const sx = p.x + ux * nodeR
			const sy = p.y + uy * nodeR
			const tx = q.x - ux * (nodeR + 2)
			const ty = q.y - uy * (nodeR + 2)
			const mx = (sx + tx) / 2
			const my = (sy + ty) / 2
			const toCenter = {x: cx - mx, y: cy - my}
			const len = Math.hypot(toCenter.x, toCenter.y) || 1
			const bulge = d.e.kind === 'repeat' ? 0.52 : -0.22
			const cxp = mx + (toCenter.x / len) * dist * bulge
			const cyp = my + (toCenter.y / len) * dist * bulge
			return `M${sx},${sy} Q${cxp},${cyp} ${tx},${ty}`
		})
		.attr('data-hit', 'edge')
		.attr('data-key', d => `edge:${loop.id}:${d.i}`)
		.attr('tabindex', -1)
		.attr('role', 'button')
		.attr(
			'aria-label',
			d =>
				`${d.e.kind} edge from ${loop.phases[idx.get(d.e.from) ?? 0]?.name ?? d.e.from} to ${loop.phases[idx.get(d.e.to) ?? 0]?.name ?? d.e.to}${d.e.label ? `, ${d.e.label}` : ''}`,
		)

	// Repeat-edge labels: centered neatly inside the cycle and wrapped cleanly to avoid node collisions
	const repeatLabels = loop.edges.filter(e => e.kind === 'repeat' && e.label)
	const labG = svg.append('g')
	repeatLabels.forEach((e, ri) => {
		const p = pos(idx.get(e.from) ?? 0)
		const q = pos(idx.get(e.to) ?? 0)
		const mx = (p.x + q.x) / 2
		const my = (p.y + q.y) / 2
		const lx = mx + (cx - mx) * 0.62
		const ly =
			my +
			(cy - my) * 0.62 +
			(repeatLabels.length > 1 ? (ri - (repeatLabels.length - 1) / 2) * 20 : 0)
		const lines = wrapWords(e.label ?? '', 20)
		const txt = labG
			.append('text')
			.attr('class', 'lm-edge-label')
			.attr('x', lx)
			.attr('y', ly - ((lines.length - 1) * 11) / 2)
			.attr('text-anchor', 'middle')
		lines.forEach((ln, li) => {
			txt
				.append('tspan')
				.attr('x', lx)
				.attr('dy', li === 0 ? '0em' : '1.15em')
				.text(ln)
		})
	})

	// Phases
	const node = svg
		.append('g')
		.selectAll<SVGGElement, LoopPhase>('g')
		.data(loop.phases)
		.join('g')
		.attr('class', 'lm-phase')
		.attr('transform', (_, i) => `translate(${pos(i).x},${pos(i).y})`)
		.attr('data-hit', 'phase')
		.attr('data-key', p => `phase:${loop.id}:${p.id}`)
		.attr('tabindex', -1)
		.attr('role', 'button')
		.attr('aria-label', p => `${p.name}: ${p.description}`)
	node.append('circle').attr('r', nodeR)
	node
		.append('text')
		.attr('class', 'lm-num')
		.attr('dy', '0.35em')
		.attr('text-anchor', 'middle')
		.text((_, i) => String(i + 1))

	// Radial label placement so top/bottom/side labels stay clear of the ring
	node.each(function (p, i) {
		const ang = angle(i)
		const cos = Math.cos(ang)
		const sin = Math.sin(ang)
		const g = d3.select(this)
		const lines = wrapWords(p.name, 16)
		let anchor: 'start' | 'middle' | 'end' = 'middle'
		let xOff = 0
		let yOff = sin >= 0 ? nodeR + 15 : -nodeR - 7 - (lines.length - 1) * 13
		if (Math.abs(cos) > 0.65) {
			anchor = cos > 0 ? 'start' : 'end'
			xOff = cos > 0 ? nodeR + 7 : -(nodeR + 7)
			yOff = -((lines.length - 1) * 6) + 4
		}
		const txt = g
			.append('text')
			.attr('class', 'lm-label')
			.attr('x', xOff)
			.attr('y', yOff)
			.attr('text-anchor', anchor)
		lines.forEach((ln, li) => {
			txt
				.append('tspan')
				.attr('x', xOff)
				.attr('dy', li === 0 ? '0em' : '1.15em')
				.text(ln)
		})
	})

	host.append(svg.node()!)
	makeRoving(host, '[data-hit]')
}
