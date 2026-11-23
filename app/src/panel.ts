import type {LoopNode} from './types'
import {
	KIND_LABEL,
	agentDisplayName,
	fmtChars,
	fmtInt,
	fmtTime,
	fmtTokens,
	isCodeLike,
} from './format'
import {costOf, fmtCost, fmtRate, rateFor} from './cost'
import {el} from './util'

/**
 * Shared hover/pin editorial marginalia panel — always visible beside each
 * plate, with:
 * - Visual tether (.is-pinned + accent hairline + swatch dot)
 * - Guided ← / → stepper when pinned
 * - Live hover-compare footer while pinned
 * - Compact 6lh excerpt on hover → expanded 15lh + Copy button when pinned
 * - Collapsible Trace IDs disclosure for secondary schema fields
 * - 100ms pointer-out revert debounce to eliminate gap flicker
 * - Clean AbortController teardown (zero listener leaks)
 */

export interface PanelAction {
	label: string
	onClick: () => void
	emphasis?: 'primary' | 'subtle'
}

export interface PanelShare {
	/** Fraction in [0, 1] rendered as a 3px Tufte proportional hairline. */
	ratio: number
	/** Short human caption beside the hairline (e.g. "63.1% of transcript"). */
	label: string
	/** Optional CSS colour (defaults to content.accent or var(--fg)). */
	color?: string
}

export interface PanelContent {
	title: string
	/** Quiet uppercase kicker line. */
	kicker?: string
	/** Backwards-compatible badges list — formatted as a dot-separated kicker if `kicker` is omitted. */
	badges?: {text: string}[]
	/** Optional colour tying the sidebar rail & kicker dot to the inspected mark. */
	accent?: string
	/** Optional 1–2 hero tabular numerals shown prominently above the metadata rows. */
	stats?: [label: string, value: string][]
	/** Optional 3px Tufte proportional hairline showing share of the plate total. */
	share?: PanelShare
	/** Curated editorial rows. */
	rows: [label: string, value: string][]
	/** Optional secondary technical/ID rows tucked inside a collapsed `<details>`. */
	metaRows?: [label: string, value: string][]
	/** Optional capped, scrollable full-text block (compact on hover, expanded + Copy when pinned). */
	text?: {body: string; mono: boolean; truncated?: boolean; label?: string}
	/** Optional contextual action buttons (e.g. "Zoom into branch →", "Jump to biggest cliff"). */
	actions?: PanelAction[]
	/** Optional numeric value + formatted label for live hover-compare delta while pinned. */
	compareValue?: {value: number; formatted: string}
}

export interface InfoPanel {
	/** The aside to place beside the section's chart(s). */
	root: HTMLElement
	/** Swap to the keyed element's details; null reverts to the default. While pinned, updates the compare bar. */
	showKey(key: string | null, animate?: boolean): void
	/** Pin (or toggle off if same key / null) a keyed element so hover does not overwrite it. */
	pinKey(key: string | null): void
	/** Currently pinned key, or null. */
	pinnedKey(): string | null
	/** Step to previous (-1) or next (+1) item in the pinned sequence, if available. Returns true if stepped. */
	step(delta: -1 | 1): boolean
	/** Subscribe to pin changes (used internally by wireInfoPanel for visual tethering). */
	onPin(fn: (pinnedKey: string | null) => void): () => void
	/** Re-render the current content without animation (after a redraw or toggle). */
	refresh(): void
}

function fmtDeltaPct(hoverVal: number, pinnedVal: number): string | null {
	if (!Number.isFinite(hoverVal) || !Number.isFinite(pinnedVal)) return null
	if (pinnedVal === 0) return hoverVal === 0 ? 'same' : null
	const pct = ((hoverVal - pinnedVal) / Math.abs(pinnedVal)) * 100
	if (Math.abs(pct) < 0.5) return '≈ same'
	const sign = pct > 0 ? '+' : '−'
	const mag = Math.abs(pct)
	return `${sign}${mag >= 100 ? Math.round(mag) : mag.toFixed(0)}% vs pinned`
}

export function createInfoPanel(opts: {
	/** Unique DOM id for the panel heading — the aside's accessible name. */
	headingId: string
	heading: string
	/** Content for a hovered/focused mark's key; null falls back to the default. */
	contentFor: (key: string) => PanelContent | null
	/** The section's origin content (a root entity, or an overview of totals). */
	defaultContent: () => PanelContent | null
	/** Optional ordered sequence for ← / → stepping (called with null in Overview to allow stepping right in). */
	sequenceFor?: (key: string | null) => readonly string[] | null
	/** Optional hook called when pin state changes (e.g. to release highlight). */
	onPinChange?: (pinnedKey: string | null) => void
}): InfoPanel {
	const heading = el('h3', {id: opts.headingId}, opts.heading)
	const statusNote = el('span', {class: 'marginalia-state'}, 'Overview')

	const prevBtn = el(
		'button',
		{
			type: 'button',
			class: 'marginalia-step-btn',
			'aria-label': 'Previous item',
			title: 'Previous item ([)',
		},
		'←',
	)
	const stepPos = el('span', {class: 'marginalia-step-pos'})
	const nextBtn = el(
		'button',
		{
			type: 'button',
			class: 'marginalia-step-btn',
			'aria-label': 'Next item',
			title: 'Next item (])',
		},
		'→',
	)
	const stepper = el(
		'div',
		{
			class: 'marginalia-stepper',
			role: 'group',
			'aria-label': 'Step through pinned items',
		},
		prevBtn,
		stepPos,
		nextBtn,
	)
	stepper.hidden = true

	const pinBtn = el(
		'button',
		{
			type: 'button',
			class: 'marginalia-pin',
			title: 'Release pinned entry (Esc)',
		},
		'Unpin ×',
	)
	pinBtn.hidden = true

	const controls = el(
		'div',
		{class: 'marginalia-controls'},
		statusNote,
		stepper,
		pinBtn,
	)
	const bar = el('div', {class: 'sankey-panel-bar'}, heading, controls)
	let body = el('div', {class: 'sankey-panel-body'})
	const compareBar = el('div', {class: 'marginalia-compare', hidden: 'true'})
	compareBar.hidden = true

	const root = el(
		'aside',
		{
			class: 'sankey-panel',
			'aria-labelledby': opts.headingId,
			'aria-live': 'polite',
		},
		bar,
		body,
		compareBar,
	)

	let currentKey: string | null = null
	let pinned: string | null = null
	let hoveredWhilePinned: string | null = null
	let lastRenderedContent: PanelContent | null = null
	const pinListeners = new Set<(key: string | null) => void>()

	const renderCompare = (): void => {
		if (
			pinned === null ||
			hoveredWhilePinned === null ||
			hoveredWhilePinned === pinned
		) {
			compareBar.hidden = true
			compareBar.replaceChildren()
			return
		}
		const hc = opts.contentFor(hoveredWhilePinned)
		if (!hc) {
			compareBar.hidden = true
			compareBar.replaceChildren()
			return
		}
		const targetKey = hoveredWhilePinned
		const delta =
			hc.compareValue && lastRenderedContent?.compareValue
				? fmtDeltaPct(
						hc.compareValue.value,
						lastRenderedContent.compareValue.value,
					)
				: null
		const metricBits = [hc.compareValue?.formatted, delta]
			.filter(Boolean)
			.join(' · ')
		compareBar.hidden = false
		compareBar.replaceChildren(
			el('span', {class: 'marginalia-compare-label'}, 'Hovering'),
			el('strong', {class: 'marginalia-compare-title'}, hc.title),
			...(metricBits
				? [el('span', {class: 'marginalia-compare-delta'}, metricBits)]
				: []),
			el(
				'button',
				{
					type: 'button',
					class: 'marginalia-compare-switch',
					title: 'Pin this item instead',
				},
				'Switch',
			),
		)
		const switchBtn = compareBar.querySelector('button')
		switchBtn?.addEventListener('click', () => setPin(targetKey))
	}

	const updateStepper = (): void => {
		if (!opts.sequenceFor) {
			stepper.hidden = true
			return
		}
		const seq = opts.sequenceFor(pinned)
		if (!seq || seq.length === 0) {
			stepper.hidden = true
			return
		}
		if (pinned === null) {
			stepper.hidden = false
			stepPos.textContent = `– / ${fmtInt(seq.length)}`
			prevBtn.disabled = false
			nextBtn.disabled = false
			return
		}
		const idx = seq.indexOf(pinned)
		if (idx < 0 || seq.length <= 1) {
			stepper.hidden = true
			return
		}
		stepper.hidden = false
		stepPos.textContent = `${fmtInt(idx + 1)} / ${fmtInt(seq.length)}`
		prevBtn.disabled = idx <= 0
		nextBtn.disabled = idx >= seq.length - 1
	}

	const render = (animate: boolean): void => {
		const activeKey = pinned ?? currentKey
		const c =
			(activeKey !== null ? opts.contentFor(activeKey) : null) ??
			opts.defaultContent()
		if (!c) return
		lastRenderedContent = c

		const isPinned = pinned !== null
		const isPreview = !isPinned && currentKey !== null
		root.classList.toggle('is-pinned', isPinned)
		root.classList.toggle('is-preview', isPreview)
		if (c.accent) root.style.setProperty('--panel-accent', c.accent)
		else root.style.removeProperty('--panel-accent')

		pinBtn.hidden = !isPinned
		statusNote.hidden = isPinned
		statusNote.textContent = isPreview ? 'Preview · click to pin' : 'Overview'
		updateStepper()

		const head = el('div', {class: 'sankey-panel-head'})
		const kickerText =
			c.kicker ??
			(c.badges?.length ? c.badges.map(b => b.text).join(' · ') : '')
		if (kickerText) {
			const kickerEl = el('span', {class: 'marginalia-kicker'})
			if (c.accent)
				kickerEl.append(
					el('i', {
						class: 'marginalia-dot',
						style: `--c:${c.accent}`,
						'aria-hidden': 'true',
					}),
				)
			kickerEl.append(kickerText)
			head.append(kickerEl)
		}
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

		if (c.share && Number.isFinite(c.share.ratio)) {
			const pct = Math.max(0, Math.min(100, c.share.ratio * 100))
			const track = el(
				'div',
				{class: 'marginalia-share', 'aria-hidden': 'true'},
				el(
					'div',
					{class: 'marginalia-share-track'},
					el('span', {
						class: 'marginalia-share-fill',
						style: `--w:${pct.toFixed(1)}%;--c:${c.share.color ?? c.accent ?? 'var(--fg)'}`,
					}),
				),
				el('span', {class: 'marginalia-share-label'}, c.share.label),
			)
			next.append(track)
		}

		if (c.rows.length) {
			const dl = el('dl', {class: 'sankey-panel-rows'})
			for (const [k, v] of c.rows) dl.append(el('dt', {}, k), el('dd', {}, v))
			next.append(dl)
		}

		if (c.actions?.length) {
			const actionBar = el('div', {class: 'marginalia-actions'})
			for (const a of c.actions) {
				const btn = el(
					'button',
					{
						type: 'button',
						class: `marginalia-action${a.emphasis === 'primary' ? ' is-primary' : ''}`,
					},
					a.label,
				)
				btn.addEventListener('click', a.onClick)
				actionBar.append(btn)
			}
			next.append(actionBar)
		}

		if (c.text) {
			const textBar = el('div', {class: 'sankey-panel-textbar'})
			const lab = el(
				'div',
				{class: 'sankey-panel-textlabel'},
				c.text.label ?? 'Full text',
			)
			if (c.text.truncated)
				lab.append(el('span', {class: 'muted'}, ' (truncated at 6,000 chars)'))
			textBar.append(lab)
			if (c.text.body) {
				const copyBtn = el(
					'button',
					{
						type: 'button',
						class: 'marginalia-copy',
						title: 'Copy excerpt to clipboard',
					},
					'Copy',
				)
				const bodyToCopy = c.text.body
				copyBtn.addEventListener('click', () => {
					const done = () => {
						copyBtn.textContent = 'Copied'
						window.setTimeout(() => {
							copyBtn.textContent = 'Copy'
						}, 1400)
					}
					if (navigator.clipboard?.writeText) {
						navigator.clipboard.writeText(bodyToCopy).then(done, () => {})
					}
				})
				textBar.append(copyBtn)
			}
			const pre = el('pre', {
				class: `sankey-panel-text${c.text.mono ? ' mono' : ''}`,
				tabindex: '0',
			})
			pre.textContent = c.text.body || '(empty)'
			next.append(textBar, pre)
		}

		if (c.metaRows?.length) {
			const details = el(
				'details',
				{class: 'marginalia-meta'},
				el('summary', {}, `Trace IDs (${fmtInt(c.metaRows.length)})`),
			)
			const dl = el('dl', {class: 'sankey-panel-rows'})
			for (const [k, v] of c.metaRows)
				dl.append(el('dt', {}, k), el('dd', {}, v))
			details.append(dl)
			next.append(details)
		}

		body.replaceWith(next)
		body = next
		renderCompare()
	}

	const setPin = (key: string | null): void => {
		if (pinned === key) return
		pinned = key
		hoveredWhilePinned = null
		currentKey = key
		render(true)
		opts.onPinChange?.(pinned)
		for (const fn of pinListeners) fn(pinned)
	}

	const step = (delta: -1 | 1): boolean => {
		if (!opts.sequenceFor) return false
		const seq = opts.sequenceFor(pinned)
		if (!seq || seq.length === 0) return false
		if (pinned === null) {
			// Stepping straight from Overview pins the first item (→) or last item (←).
			const startKey = delta > 0 ? seq[0] : seq[seq.length - 1]
			if (startKey === undefined) return false
			setPin(startKey)
			return true
		}
		if (seq.length <= 1) return false
		const idx = seq.indexOf(pinned)
		if (idx < 0) return false
		const nextKey = seq[idx + delta]
		if (nextKey === undefined) return false
		setPin(nextKey)
		return true
	}

	pinBtn.addEventListener('click', () => setPin(null))
	prevBtn.addEventListener('click', () => step(-1))
	nextBtn.addEventListener('click', () => step(1))

	root.addEventListener('keydown', e => {
		if (pinned === null) return
		if (e.key === 'Escape') {
			e.preventDefault()
			setPin(null)
		} else if (
			e.key === '[' ||
			(e.key === 'ArrowLeft' && !(e.target as Element)?.closest('pre'))
		) {
			if (step(-1)) e.preventDefault()
		} else if (
			e.key === ']' ||
			(e.key === 'ArrowRight' && !(e.target as Element)?.closest('pre'))
		) {
			if (step(1)) e.preventDefault()
		}
	})

	render(false) // show the default (origin) content immediately — panels are never blank

	return {
		root,
		showKey(key, animate = true) {
			if (pinned !== null) {
				if (hoveredWhilePinned === key) return
				hoveredWhilePinned = key
				renderCompare()
				return
			}
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
		step,
		onPin(fn) {
			pinListeners.add(fn)
			return () => pinListeners.delete(fn)
		},
		refresh() {
			render(false)
		},
	}
}

/**
 * Hover/focus/pin wiring for a panel over one or more chart hosts whose
 * interactive marks carry `[data-hit]`. Features:
 * - Instantaneous hover-in without animation jitter
 * - 100ms revert debounce on pointer-out so crossing small gaps never flickers
 * - Automatic visual tether (`.is-pinned` + `aria-pressed`) synced across redraws
 * - Keyboard `[` / `]` stepping and `Escape` unpinning
 * - Returns a `dispose()` teardown via AbortController (zero listener leaks)
 */
export function wireInfoPanel(
	hosts: readonly HTMLElement[],
	panel: InfoPanel,
	keyOf: (mark: Element) => string | null = m => m.getAttribute('data-key'),
	opts: {pinOnClick?: boolean; revertDelayMs?: number} = {},
): () => void {
	const allowPin = opts.pinOnClick ?? true
	const revertDelay = opts.revertDelayMs ?? 100
	const ac = new AbortController()
	const {signal} = ac
	let revertTimer: number | null = null

	const cancelRevert = (): void => {
		if (revertTimer !== null) {
			window.clearTimeout(revertTimer)
			revertTimer = null
		}
	}

	const markOf = (t: Element | null): Element | null =>
		t?.closest('[data-hit]') ?? null
	const inHosts = (m: Element | null): m is Element =>
		m !== null && hosts.some(h => h.contains(m))
	const focusedKey = (): string | null => {
		const m = markOf(document.activeElement)
		return inHosts(m) ? keyOf(m) : null
	}

	const syncPinnedMarks = (pinnedKey: string | null): void => {
		for (const host of hosts) {
			for (const mark of host.querySelectorAll('[data-hit]')) {
				const match = pinnedKey !== null && keyOf(mark) === pinnedKey
				mark.classList.toggle('is-pinned', match)
				if (mark.getAttribute('role') === 'button' || mark.tagName === 'TR') {
					if (match) mark.setAttribute('aria-pressed', 'true')
					else mark.removeAttribute('aria-pressed')
				}
			}
		}
	}

	const unsubPin = panel.onPin(syncPinnedMarks)

	// Re-apply pinned highlight automatically if a host redraws its SVG/table marks.
	const observers: MutationObserver[] = []
	if (typeof MutationObserver !== 'undefined') {
		for (const host of hosts) {
			const mo = new MutationObserver(() => {
				const pk = panel.pinnedKey()
				if (pk !== null) syncPinnedMarks(pk)
			})
			mo.observe(host, {childList: true})
			observers.push(mo)
		}
	}

	for (const host of hosts) {
		host.addEventListener(
			'pointerover',
			e => {
				const m = markOf(e.target as Element | null)
				if (!m) return
				cancelRevert()
				panel.showKey(keyOf(m), false)
			},
			{signal},
		)
		host.addEventListener(
			'pointerout',
			e => {
				if (
					inHosts(markOf((e as PointerEvent).relatedTarget as Element | null))
				)
					return
				cancelRevert()
				revertTimer = window.setTimeout(() => {
					revertTimer = null
					panel.showKey(focusedKey(), false)
				}, revertDelay)
			},
			{signal},
		)
		host.addEventListener(
			'focusin',
			e => {
				const m = markOf(e.target as Element | null)
				if (m) {
					cancelRevert()
					panel.showKey(keyOf(m), false)
				}
			},
			{signal},
		)
		host.addEventListener(
			'focusout',
			e => {
				if (!inHosts(markOf(e.relatedTarget as Element | null))) {
					cancelRevert()
					panel.showKey(null, false)
				}
			},
			{signal},
		)
		if (allowPin) {
			host.addEventListener(
				'click',
				e => {
					const m = markOf(e.target as Element | null)
					if (m) {
						const k = keyOf(m)
						if (k !== null) panel.pinKey(k)
					} else if (panel.pinnedKey() !== null) {
						panel.pinKey(null)
					}
				},
				{signal},
			)
			host.addEventListener(
				'keydown',
				e => {
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
				},
				{signal},
			)
		}
	}

	if (allowPin) {
		document.addEventListener(
			'keydown',
			e => {
				if (panel.pinnedKey() === null) return
				if (e.key === 'Escape') {
					panel.pinKey(null)
					return
				}
				const tag = (e.target as Element | null)?.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
				if (e.key === '[') {
					if (panel.step(-1)) e.preventDefault()
				} else if (e.key === ']') {
					if (panel.step(1)) e.preventDefault()
				}
			},
			{signal},
		)
	}

	return () => {
		cancelRevert()
		ac.abort()
		unsubPin()
		for (const mo of observers) mo.disconnect()
	}
}

/**
 * Standard content for any LoopNode: curated human-readable editorial rows
 * upfront, and raw schema/trace IDs tucked neatly into `metaRows`.
 * Pass `omit` to suppress rows already featured in `kicker` or `stats`.
 */
export function nodePanel(
	node: LoopNode,
	extraRows: [string, string][] = [],
	opts: {omit?: readonly string[]; extraMeta?: [string, string][]} = {},
): PanelContent {
	const m = node.meta
	const skip = new Set(opts.omit ?? [])
	const rows: [string, string][] = []
	const metaRows: [string, string][] = []

	const push = (label: string, value: string): void => {
		if (!skip.has(label)) rows.push([label, value])
	}

	push('kind', KIND_LABEL[node.kind])
	if (m?.agent) push('agent', agentDisplayName(m.agent))
	if (m?.toolName) push('tool', m.toolName)
	if (m?.summary) push('summary', m.summary)
	if (m?.status) push('status', m.status.replace(/_/g, ' '))
	if (m?.assignee) push('assignee', m.assignee)
	if (m?.isError) push('error', 'yes')
	push(
		'size',
		m
			? `${fmtChars(m.chars)} · ${fmtTokens(m.tokensEst)}`
			: `value ${fmtInt(node.value)}`,
	)
	if (m?.contextChars !== undefined)
		push(
			'context at this point',
			`${fmtChars(m.contextChars)}${m.contextTokensEst !== undefined ? ` · ${fmtTokens(m.contextTokensEst)}` : ''}`,
		)
	if (m?.promptChars !== undefined) push('prompt size', fmtChars(m.promptChars))
	if (m?.durationMs !== undefined)
		push('duration', `${fmtInt(m.durationMs)} ms`)
	if (m?.turnIndex !== undefined)
		push(
			'turn',
			`#${m.turnIndex + 1}${m.stepIndex !== undefined ? ` · step ${m.stepIndex}` : ''}`,
		)
	for (const r of extraRows) push(r[0], r[1])

	// Technical trace identifiers & raw timestamps live in the collapsible Trace IDs block
	if (m?.createdAt) metaRows.push(['created', fmtTime(m.createdAt)])
	if (m?.role) metaRows.push(['role', m.role])
	if (m?.threadId) metaRows.push(['thread', m.threadId])
	if (m?.messageId) metaRows.push(['message', m.messageId])
	if (m?.toolCallId) metaRows.push(['call id', m.toolCallId])
	metaRows.push(['id', node.id])
	if (opts.extraMeta) metaRows.push(...opts.extraMeta)

	const body = m?.fullText ?? m?.excerpt ?? ''
	return {
		title: node.name,
		badges: [
			{text: KIND_LABEL[node.kind]},
			...(m?.agent ? [{text: agentDisplayName(m.agent)}] : []),
		],
		rows,
		metaRows: metaRows.length ? metaRows : undefined,
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
