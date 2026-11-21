import type {LoopNode} from './types'
import {
	KIND_LABEL,
	fmtChars,
	fmtInt,
	fmtTime,
	fmtTokens,
	isCodeLike,
} from './format'
import {costOf, fmtCost, fmtRate, rateFor} from './cost'
import {el} from './util'

/**
 * Shared hover-driven info panel — the permanent rectangular details column
 * the Loop Sankey view introduced (2026-09-03), generalized so each section
 * hosts one beside its chart. A panel is always visible: it shows the
 * section's origin/default content until a mark is hovered or keyboard-focused,
 * swaps to that mark's details, and reverts on mouse-out/blur. The DOM reuses
 * the Sankey panel's classes and a11y semantics: aside labelled by its own
 * heading, `aria-live="polite"`, 170ms swap entrance disabled under
 * `prefers-reduced-motion` (see styles.css).
 *
 * The content model is the former tooltip's TipContent minus actions (pin /
 * zoom actions were pin-surface UX; the panel is permanent). Section views
 * feed it from the content builders the pre-2026-09-03 tooltips used, so the
 * details the old tooltips showed are exactly what these panels show.
 */

export interface PanelContent {
	title: string
	/** Quiet uppercase kicker line (replaces chunky pill badges in the editorial spread). */
	kicker?: string
	/** Backwards-compatible badges list — formatted as a quiet dot-separated kicker if `kicker` is omitted. */
	badges?: {text: string}[]
	/** Optional 1–2 hero tabular numerals shown prominently above the metadata rows. */
	stats?: [label: string, value: string][]
	rows: [label: string, value: string][]
	/** Optional capped, scrollable full-text block (e.g. the prompt that opened a turn). */
	text?: {body: string; mono: boolean; truncated?: boolean; label?: string}
}

export interface InfoPanel {
	/** The aside to place beside the section's chart(s). */
	root: HTMLElement
	/** Swap to the keyed element's details; null reverts to the default. Ignored while pinned. */
	showKey(key: string | null, animate?: boolean): void
	/** Pin (or toggle off if same key / null) a keyed element so hover does not overwrite it. */
	pinKey(key: string | null): void
	/** Currently pinned key, or null. */
	pinnedKey(): string | null
	/** Re-render the current content without animation (after a redraw or toggle). */
	refresh(): void
}

export function createInfoPanel(opts: {
	/** Unique DOM id for the panel heading — the aside's accessible name. */
	headingId: string
	heading: string
	/** Content for a hovered/focused mark's key; null falls back to the default. */
	contentFor: (key: string) => PanelContent | null
	/** The section's origin content (a root entity, or an overview of totals). */
	defaultContent: () => PanelContent | null
	/** Optional hook called when pin state changes (e.g. to release highlight). */
	onPinChange?: (pinnedKey: string | null) => void
}): InfoPanel {
	const heading = el('h3', {id: opts.headingId}, opts.heading)
	const pinBtn = el(
		'button',
		{
			type: 'button',
			class: 'marginalia-pin',
			title: 'Release pinned entry (Esc)',
		},
		'Pinned ×',
	)
	pinBtn.hidden = true
	const bar = el('div', {class: 'sankey-panel-bar'}, heading, pinBtn)
	let body = el('div', {class: 'sankey-panel-body'})
	const root = el(
		'aside',
		{
			class: 'sankey-panel',
			'aria-labelledby': opts.headingId,
			'aria-live': 'polite',
		},
		bar,
		body,
	)

	let currentKey: string | null = null
	let pinned: string | null = null

	const render = (animate: boolean): void => {
		const activeKey = pinned ?? currentKey
		const c =
			(activeKey !== null ? opts.contentFor(activeKey) : null) ??
			opts.defaultContent()
		if (!c) return
		pinBtn.hidden = pinned === null

		const head = el('div', {class: 'sankey-panel-head'})
		const kickerText =
			c.kicker ??
			(c.badges?.length ? c.badges.map(b => b.text).join(' · ') : '')
		if (kickerText)
			head.append(el('span', {class: 'marginalia-kicker'}, kickerText))
		head.append(el('strong', {class: 'sankey-panel-title'}, c.title))

		const next = el(
			'div',
			{class: `sankey-panel-body${animate ? ' is-swapping' : ''}`},
			head,
		)

		if (c.stats?.length) {
			const strip = el('div', {class: 'marginalia-stats'})
			for (const [lab, val] of c.stats) {
				strip.append(
					el(
						'div',
						{},
						el('div', {class: 'marginalia-stat-val'}, val),
						el('div', {class: 'marginalia-stat-lab'}, lab),
					),
				)
			}
			next.append(strip)
		}

		if (c.rows.length) {
			const dl = el('dl', {class: 'sankey-panel-rows'})
			for (const [k, v] of c.rows) dl.append(el('dt', {}, k), el('dd', {}, v))
			next.append(dl)
		}
		if (c.text) {
			const lab = el(
				'div',
				{class: 'sankey-panel-textlabel'},
				c.text.label ?? 'Full text',
			)
			if (c.text.truncated)
				lab.append(el('span', {class: 'muted'}, ' (truncated at 6,000 chars)'))
			const pre = el('pre', {
				class: `sankey-panel-text${c.text.mono ? ' mono' : ''}`,
				tabindex: '0',
			})
			pre.textContent = c.text.body || '(empty)'
			next.append(lab, pre)
		}
		body.replaceWith(next)
		body = next
	}

	const setPin = (key: string | null): void => {
		if (pinned === key) return
		pinned = key
		if (key !== null) currentKey = key
		render(true)
		opts.onPinChange?.(pinned)
	}

	pinBtn.addEventListener('click', () => setPin(null))
	render(false) // show the default (origin) content immediately — panels are never blank

	return {
		root,
		showKey(key, animate = true) {
			if (pinned !== null) return
			if (currentKey === key) return
			currentKey = key
			render(animate)
		},
		pinKey(key) {
			if (key === null) {
				setPin(null)
			} else {
				setPin(pinned === key ? null : key)
			}
		},
		pinnedKey() {
			return pinned
		},
		refresh() {
			render(false)
		},
	}
}

/**
 * Hover/focus/pin wiring for a panel over one or more chart hosts whose
 * interactive marks carry `[data-hit]` (the app-wide interaction hook).
 * Listeners are delegated once per host — redraws replace only the marks.
 * A pinned mark wins over hover/focus until released (click again, button, or Esc).
 */
export function wireInfoPanel(
	hosts: readonly HTMLElement[],
	panel: InfoPanel,
	keyOf: (mark: Element) => string | null = m => m.getAttribute('data-key'),
	opts: {pinOnClick?: boolean} = {},
): void {
	const allowPin = opts.pinOnClick ?? true
	const markOf = (t: Element | null): Element | null =>
		t?.closest('[data-hit]') ?? null
	const inHosts = (m: Element | null): m is Element =>
		m !== null && hosts.some(h => h.contains(m))
	const focusedKey = (): string | null => {
		const m = markOf(document.activeElement)
		return inHosts(m) ? keyOf(m) : null
	}
	for (const host of hosts) {
		host.addEventListener('pointerover', e => {
			const m = markOf(e.target as Element | null)
			if (m) panel.showKey(keyOf(m))
		})
		host.addEventListener('pointerout', e => {
			if (!inHosts(markOf((e as PointerEvent).relatedTarget as Element | null)))
				panel.showKey(focusedKey())
		})
		host.addEventListener('focusin', e => {
			const m = markOf(e.target as Element | null)
			if (m) panel.showKey(keyOf(m))
		})
		host.addEventListener('focusout', e => {
			if (!inHosts(markOf(e.relatedTarget as Element | null)))
				panel.showKey(null)
		})
		if (allowPin) {
			host.addEventListener('click', e => {
				const m = markOf(e.target as Element | null)
				if (m) {
					const k = keyOf(m)
					if (k !== null) panel.pinKey(k)
				} else if (panel.pinnedKey() !== null) {
					panel.pinKey(null)
				}
			})
			host.addEventListener('keydown', e => {
				const ke = e as KeyboardEvent
				if (ke.key === 'Escape' && panel.pinnedKey() !== null) {
					ke.preventDefault()
					panel.pinKey(null)
					return
				}
				if (ke.key === 'Enter' || ke.key === ' ') {
					const m = markOf(ke.target as Element | null)
					if (m) {
						const k = keyOf(m)
						if (k !== null) {
							ke.preventDefault()
							panel.pinKey(k)
						}
					}
				}
			})
		}
	}
	if (allowPin) {
		document.addEventListener('keydown', e => {
			if (e.key === 'Escape' && panel.pinnedKey() !== null) panel.pinKey(null)
		})
	}
}

/** Standard content for any LoopNode — every schema field the former tooltips showed, sizes first. */
export function nodePanel(
	node: LoopNode,
	extraRows: [string, string][] = [],
): PanelContent {
	const m = node.meta
	const rows: [string, string][] = []
	rows.push(['kind', KIND_LABEL[node.kind]])
	if (m?.agent) rows.push(['agent', m.agent])
	if (m?.role) rows.push(['role', m.role])
	if (m?.toolName) rows.push(['tool', m.toolName])
	if (m?.summary) rows.push(['summary', m.summary])
	if (m?.status) rows.push(['status', m.status])
	if (m?.assignee) rows.push(['assignee', m.assignee])
	if (m?.isError) rows.push(['error', 'yes'])
	rows.push([
		'size',
		m
			? `${fmtChars(m.chars)} · ${fmtTokens(m.tokensEst)}`
			: `value ${fmtInt(node.value)}`,
	])
	if (m?.contextChars !== undefined)
		rows.push([
			'context at this point',
			`${fmtChars(m.contextChars)}${m.contextTokensEst !== undefined ? ` · ${fmtTokens(m.contextTokensEst)}` : ''}`,
		])
	if (m?.promptChars !== undefined)
		rows.push(['prompt size', fmtChars(m.promptChars)])
	if (m?.durationMs !== undefined)
		rows.push(['duration', `${fmtInt(m.durationMs)} ms`])
	if (m?.createdAt) rows.push(['created', fmtTime(m.createdAt)])
	if (m?.threadId) rows.push(['thread', m.threadId])
	if (m?.turnIndex !== undefined)
		rows.push([
			'turn',
			`#${m.turnIndex + 1}${m.stepIndex !== undefined ? ` · step ${m.stepIndex}` : ''}`,
		])
	if (m?.messageId) rows.push(['message', m.messageId])
	if (m?.toolCallId) rows.push(['call id', m.toolCallId])
	rows.push(['id', node.id])
	rows.push(...extraRows)
	const body = m?.fullText ?? m?.excerpt ?? ''
	return {
		title: node.name,
		badges: [
			{text: KIND_LABEL[node.kind]},
			...(m?.agent ? [{text: m.agent}] : []),
		],
		rows,
		text: body
			? {body, mono: isCodeLike(node), truncated: m?.truncated}
			: undefined,
	}
}

/**
 * Insert the assumed-rate cost row after the size row — the position the
 * former `withCostRow()` used. Rates are read at call time, so rows always
 * reflect the current Rates settings on the next swap. Pure: returns a new
 * PanelContent, leaving `content` untouched.
 */
export function withCostRow(
	content: PanelContent,
	tokens: number | undefined,
	agent: string | undefined,
): PanelContent {
	if (tokens === undefined) return content
	const row: [string, string] = [
		'cost (assumed)',
		`${fmtCost(costOf(tokens, agent))} · ${fmtRate(rateFor(agent))}`,
	]
	const i = content.rows.findIndex(
		([label]) => label === 'size' || label === 'tokens',
	)
	const rows = [...content.rows]
	if (i < 0) rows.push(row)
	else rows.splice(i + 1, 0, row)
	return {...content, rows}
}
