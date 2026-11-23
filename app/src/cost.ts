import * as d3 from 'd3'
import {el} from './util'

/**
 * Cost estimation from estimated tokens.
 *
 * EVERYTHING here is an assumption by design: the dataset carries no provider
 * usage data, only `tokensEst` (chars ÷ 4). Cost = estimated tokens × an
 * assumed rate the reader can edit. Every UI surface built on this module
 * labels its output "est." / "assumed" — never measured, never provider data.
 *
 * Rates are USD per 1M tokens. A per-agent-class override may be set on top of
 * the default rate (agent classes: user / orchestrator / worker — any
 * `worker:<assignee>` maps to the worker class). The configuration persists in
 * localStorage and every listening view re-renders when it changes.
 */

export type AgentClass = 'user' | 'orchestrator' | 'worker' | 'other'

/** Classes shown in the Rates popover, in display order. */
export const AGENT_CLASSES: AgentClass[] = ['user', 'orchestrator', 'worker']

export interface Rates {
	/** Default assumed rate, USD per 1M tokens. */
	default: number
	/** Per-class overrides on top of the default. */
	overrides: Partial<Record<AgentClass, number>>
}

export const DEFAULT_RATE = 3 // $ per 1M tokens — illustrative, like any number on this page

const STORAGE_KEY = 'cost-rates-v1'
/** Document event dispatched after rates change; views re-render on it. */
export const RATES_EVENT = 'obvious:rates-changed'

export function agentClassOf(agent: string | undefined): AgentClass {
	if (!agent) return 'other'
	if (agent === 'user') return 'user'
	if (agent === 'orchestrator') return 'orchestrator'
	if (agent.startsWith('worker')) return 'worker'
	return 'other'
}

function sanitizeRates(raw: unknown): Rates {
	const out: Rates = {default: DEFAULT_RATE, overrides: {}}
	if (typeof raw !== 'object' || raw === null) return out
	const r = raw as Record<string, unknown>
	if (
		typeof r.default === 'number' &&
		Number.isFinite(r.default) &&
		r.default >= 0
	)
		out.default = r.default
	if (typeof r.overrides === 'object' && r.overrides !== null) {
		for (const cls of AGENT_CLASSES) {
			const v = (r.overrides as Record<string, unknown>)[cls]
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
				out.overrides[cls] = v
		}
	}
	return out
}

let cache: Rates | null = null

export function getRates(): Rates {
	if (cache) return cache
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		cache = raw
			? sanitizeRates(JSON.parse(raw))
			: {default: DEFAULT_RATE, overrides: {}}
	} catch {
		cache = {default: DEFAULT_RATE, overrides: {}}
	}
	return cache
}

function persist(rates: Rates): void {
	cache = rates
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(rates))
	} catch {
		/* private mode etc. — the in-memory rate still applies for this page view */
	}
	document.dispatchEvent(new CustomEvent(RATES_EVENT))
}

/** Assumed rate for an agent, USD per 1M tokens: class override, else default. */
export function rateFor(agent: string | undefined): number {
	const rates = getRates()
	const cls = agentClassOf(agent)
	return rates.overrides[cls] ?? rates.default
}

/** Cost of `tokens` (estimated) at the assumed rate for `agent`. USD. */
export function costOf(
	tokens: number | undefined,
	agent: string | undefined,
): number {
	if (tokens === undefined || !Number.isFinite(tokens)) return 0
	return (tokens / 1e6) * rateFor(agent)
}

const f2 = d3.format('$,.2f')
const f4 = d3.format('$,.4f')
/** "$1.23", keeping four decimals below a cent so small turns don't collapse to $0.00. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd)) return '—'
	return usd !== 0 && Math.abs(usd) < 0.01 ? f4(usd) : f2(usd)
}
export const fmtRate = (usdPerM: number): string => `${f2(usdPerM)} / 1M tokens`

/**
 * Re-render hook for views whose rendered output embeds cost figures (cells,
 * table columns, KPIs). Registers ONE document-level listener per container
 * (re-renders recreate the DOM but must not stack listeners).
 */
const ratesBound = new WeakMap<HTMLElement, EventListener>()
export function onRatesChange(
	container: HTMLElement,
	rerender: () => void,
): () => void {
	const existing = ratesBound.get(container)
	if (existing)
		return () => {
			document.removeEventListener(RATES_EVENT, existing)
			if (ratesBound.get(container) === existing) ratesBound.delete(container)
		}

	const listener: EventListener = () => rerender()
	ratesBound.set(container, listener)
	document.addEventListener(RATES_EVENT, listener)
	return () => {
		document.removeEventListener(RATES_EVENT, listener)
		if (ratesBound.get(container) === listener) ratesBound.delete(container)
	}
}

// ── Rates popover (global toolbar) ──────────────────────────────────────────

const CLASS_LABEL: Record<AgentClass, string> = {
	user: 'user',
	orchestrator: 'orchestrator',
	worker: 'worker (any worker:*)',
	other: 'other',
}

/**
 * Mount the "Rates" button + popover into the site header tools. Native
 * `popover="auto"` where supported (light dismiss + Esc for free); a
 * click-toggled fallback otherwise.
 * Inputs follow the forms guide: visible labels, min/step constraints, and
 * :user-invalid styling that only appears after the user edits a field.
 */
export function mountRatesControl(host: HTMLElement): void {
	const supportsPopover = 'popover' in HTMLElement.prototype
	const pop = el('div', {id: 'rates-pop', class: 'rates-pop'})
	if (supportsPopover) pop.setAttribute('popover', 'auto')

	const form = el('form', {novalidate: ''})
	const buildFields = (): void => {
		// Rebuilt in place on reset so the button/popover pairing stays stable.
		form.replaceChildren()
		form.append(
			el(
				'p',
				{class: 'rates-intro'},
				el('strong', {}, 'Modeled rates, not billing data.'),
				' Dollar figures multiply estimated tokens (chars ÷ 4) by the rates below.',
			),
		)
		form.append(
			rowFor(
				'default rate',
				'USD per 1M tokens, used when a class has no override',
				getRates().default,
				v => {
					if (v === null) return
					const r = getRates()
					persist({...r, default: v})
				},
			),
		)
		for (const cls of AGENT_CLASSES) {
			const override = getRates().overrides[cls]
			form.append(
				rowFor(
					`${CLASS_LABEL[cls]} rate`,
					override === undefined
						? 'inherits default'
						: `override: ${fmtRate(override)}`,
					override ?? getRates().default,
					v => {
						const r = getRates()
						const overrides = {...r.overrides}
						if (v === null) delete overrides[cls]
						else overrides[cls] = v
						persist({...r, overrides})
					},
				),
			)
		}
	}
	const rowFor = (
		label: string,
		hint: string,
		value: number,
		onInput: (v: number | null) => void,
	): HTMLElement => {
		const wrap = el('div', {class: 'rates-row'})
		const id = `rate-${label.replace(/[^a-z]+/gi, '-')}`
		const input = el('input', {
			type: 'number',
			id,
			min: '0',
			step: '0.01',
			inputmode: 'decimal',
			value: String(value),
		})
		input.addEventListener('input', () => {
			const v = input.valueAsNumber
			onInput(Number.isFinite(v) && v >= 0 ? v : null)
		})
		const lab = el('label', {for: id}, label)
		wrap.append(
			el(
				'div',
				{class: 'rates-lab'},
				lab,
				el('span', {class: 'muted small'}, hint),
			),
			input,
		)
		return wrap
	}
	buildFields()
	const resetBtn = el(
		'button',
		{type: 'button', class: 'btn'},
		'Reset to default',
	)
	resetBtn.addEventListener('click', () => {
		persist({default: DEFAULT_RATE, overrides: {}})
		buildFields() // refresh inputs to the reset values
	})
	form.append(
		el(
			'p',
			{class: 'muted small rates-hint'},
			'Blank or invalid entries fall back to the default rate.',
		),
		resetBtn,
	)
	pop.append(form)

	const btn = el(
		'button',
		{
			type: 'button',
			id: 'rates-btn',
			class: 'btn',
			'aria-haspopup': 'dialog',
			'aria-expanded': 'false',
		},
		`Edit rates (${fmtRate(getRates().default)})`,
	)
	if (supportsPopover) {
		btn.setAttribute('popovertarget', 'rates-pop')
	} else {
		btn.addEventListener('click', () => {
			const open = pop.classList.toggle('is-open')
			btn.setAttribute('aria-expanded', String(open))
			if (open) pop.focus()
		})
		pop.setAttribute('tabindex', '-1')
	}
	pop.addEventListener('toggle', () =>
		btn.setAttribute(
			'aria-expanded',
			String(
				supportsPopover
					? pop.matches(':popover-open')
					: pop.classList.contains('is-open'),
			),
		),
	)
	host.append(btn, pop)
}
