import './styles.css'
import * as d3 from 'd3'
import {loadDataset} from './data'
import type {LoadedDataset, LoopsDataset} from './types'
import {fmtCompact, fmtInt, fmtPct, fmtTime} from './format'
import {costOf, fmtCost, fmtRate, onRatesChange, rateFor} from './cost'
import {el, prefersReducedMotion, yieldToMain} from './util'
import {splitCycles} from './views/sankey-model'
import {renderSankey} from './views/sankey'
import {renderHierarchy} from './views/hierarchy'
import {renderContext} from './views/context'
import {renderDelegation} from './views/delegation'
import {renderLoopModel} from './views/loopModel'
import {renderSummary} from './views/summary'
import {renderTokens} from './views/tokens'

interface PlateDef {
	id: string
	navNum: string
	navLabel: string
	kickerNum: string
	kickerDomain: string
	kickerTag?: string
	title: (ds: LoopsDataset) => string
	deck: (ds: LoopsDataset) => string
	render: (host: HTMLElement, ds: LoopsDataset) => (() => void) | void
	/** Defer layout/paint below the fold via content-visibility: auto (never on Plate I). */
	defer?: boolean
}

function workerShare(ds: LoopsDataset): {
	charPct: string
	tokenPct: string
	hasWorkers: boolean
} {
	const totalChars = d3.sum(ds.stats.agents, a => a.chars)
	const workerChars = d3.sum(
		ds.stats.agents.filter(a => a.agent.startsWith('worker:')),
		a => a.chars,
	)
	const totalTok = d3.sum(ds.stats.agents, a => a.tokensEst)
	const workerTok = d3.sum(
		ds.stats.agents.filter(a => a.agent.startsWith('worker:')),
		a => a.tokensEst,
	)
	return {
		charPct: fmtPct(workerChars, totalChars),
		tokenPct: fmtPct(workerTok, totalTok),
		hasWorkers: workerChars > 0,
	}
}

function countDelegation(ds: LoopsDataset): {tasks: number; workers: number} {
	let tasks = 0
	let workers = 0
	const walk = (n: LoopsDataset['delegation']) => {
		if (n.kind === 'task') tasks += 1
		else if (n.kind === 'worker-thread') workers += 1
		for (const c of n.children ?? []) walk(c)
	}
	walk(ds.delegation)
	return {tasks, workers}
}

const PLATES: PlateDef[] = [
	{
		id: 'loops',
		navNum: 'I',
		navLabel: 'Model',
		kickerNum: 'Plate I',
		kickerDomain: 'Canonical Architecture',
		kickerTag: 'Documented model',
		title: ds =>
			`${fmtInt(ds.loopModel.loops.length)} documented loops govern how the agent reasons, acts, and delegates`,
		deck: () =>
			'Before inspecting the empirical trace, these canonical cycles establish the intended architecture — turn execution, delegation, skill retrieval, memory, and human-in-the-loop.',
		render: renderLoopModel,
		defer: false,
	},
	{
		id: 'sankey',
		navNum: 'II',
		navLabel: 'Execution Flow',
		kickerNum: 'Plate II',
		kickerDomain: 'Observed Transitions',
		kickerTag: 'Empirical trace',
		title: ds => {
			const {back} = splitCycles(ds.flows.nodes, ds.flows.links)
			const topBack = [...back].sort((a, b) => b.value - a.value)[0]
			if (topBack && topBack.value >= 10) {
				const s =
					ds.flows.nodes.find(n => n.id === topBack.source)?.stage ??
					topBack.source
				const t =
					ds.flows.nodes.find(n => n.id === topBack.target)?.stage ??
					topBack.target
				return `Observed execution cycles tightly through ${s} → ${t} (${fmtInt(topBack.value)}×) across ${fmtInt(back.length)} loop-back paths`
			}
			return `Observed transitions across ${fmtInt(ds.flows.nodes.length)} stages and ${fmtInt(back.length)} loop-back paths`
		},
		deck: () =>
			'Every observed transition from user request to assistant response. Dot area encodes mean size per step (square-root scale); hairline weight encodes transition count.',
		render: renderSankey,
		defer: false,
	},
	{
		id: 'hierarchy',
		navNum: 'III',
		navLabel: 'Hierarchy',
		kickerNum: 'Plate III',
		kickerDomain: 'Volume & Structure',
		title: ds => {
			const totalChars = d3.sum(ds.stats.agents, a => a.chars)
			const {charPct, hasWorkers} = workerShare(ds)
			return hasWorkers
				? `Delegated worker threads account for ${charPct} of all ${fmtCompact(totalChars)} observed characters`
				: `Project volume across ${fmtInt(ds.source.threadIds.length)} threads and ${fmtInt(ds.stats.turns.length)} turns`
		},
		deck: () =>
			'Depth runs left to right — project, thread, turn, and step — with bar height proportional to text and JSON bulk. Click any container cell to drill down.',
		render: renderHierarchy,
		defer: true,
	},
	{
		id: 'delegation',
		navNum: 'IV',
		navLabel: 'Delegation',
		kickerNum: 'Plate IV',
		kickerDomain: 'Task Fan-Out',
		title: ds => {
			const {tasks, workers} = countDelegation(ds)
			return `The orchestrator fans out ${fmtInt(tasks)} scoped tasks into ${fmtInt(workers)} worker thread${workers === 1 ? '' : 's'}`
		},
		deck: () =>
			'From root brief to delegated subtasks and worker runs. Circle area encodes dispatch prompt size; solid nodes mark tasks and ringed nodes mark worker threads.',
		render: renderDelegation,
		defer: true,
	},
	{
		id: 'context',
		navNum: 'V',
		navLabel: 'Context',
		kickerNum: 'Plate V',
		kickerDomain: 'Context Accumulation',
		title: ds => {
			const peak = d3.max(ds.stats.turns, t => t.contextCharsAtEnd) ?? 0
			return `Context climbs to ${fmtCompact(peak)} characters inside the largest thread`
		},
		deck: () =>
			'Step-by-step cumulative context trajectories across every observed thread, plotted on a shared vertical scale by default so relative growth reads honestly.',
		render: renderContext,
		defer: true,
	},
	{
		id: 'tokens',
		navNum: 'VI',
		navLabel: 'Tokens & Cost',
		kickerNum: 'Plate VI',
		kickerDomain: 'Estimated Consumption',
		title: ds => {
			const {tokenPct, hasWorkers} = workerShare(ds)
			return hasWorkers
				? `Worker execution drives ${tokenPct} of estimated token consumption`
				: `Estimated token consumption across ${fmtInt(ds.stats.turns.length)} observed turns`
		},
		deck: () =>
			'Estimated tokens (characters ÷ 4) and illustrative cost at editable assumed rates, broken down by turn and agent. Never measured provider billing.',
		render: renderTokens,
		defer: true,
	},
	{
		id: 'summary',
		navNum: 'VII',
		navLabel: 'Ledger',
		kickerNum: 'Appendix',
		kickerDomain: 'Complete Trace Ledger',
		title: () => 'Per-agent, per-tool, and turn-by-turn empirical ledger',
		deck: () =>
			'Exact tabular breakdown of every agent, tool invocation, and turn — serving as a numeric reference and accessible companion to the visual plates above.',
		render: renderSummary,
		defer: true,
	},
]

function byId<T extends HTMLElement>(id: string): T {
	const e = document.getElementById(id)
	if (!e) throw new Error(`#${id} missing`)
	return e as T
}

/**
 * Colour scheme (dark-mode guide): `color-scheme: light dark` + `light-dark()` in CSS do the work.
 */
function initTheme(): void {
	const sel = byId<HTMLSelectElement>('theme')
	const pinOpt = byId<HTMLOptionElement>('theme-pin')
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="color-scheme"]',
	)
	const systemDark = matchMedia('(prefers-color-scheme: dark)')
	const opposite = () => (systemDark.matches ? 'light' : 'dark')
	const label = (s: string) => `${s === 'dark' ? 'Dark' : 'Light'} (pinned)`

	const apply = (pinned: 'light' | 'dark' | null) => {
		const value = pinned ?? 'light dark'
		document.documentElement.style.colorScheme = value
		if (meta) meta.content = value
		document.documentElement.dataset.theme = pinned ?? 'auto'
		pinOpt.value = pinned ?? opposite()
		pinOpt.textContent = label(pinOpt.value)
		sel.value = pinned ?? 'auto'
	}

	const savedRaw = localStorage.getItem('theme')
	apply(savedRaw === 'light' || savedRaw === 'dark' ? savedRaw : null)

	sel.addEventListener('change', () => {
		if (sel.value === 'auto') {
			localStorage.removeItem('theme')
			apply(null)
			return
		}
		const pin = sel.value === 'dark' ? 'dark' : 'light'
		localStorage.setItem('theme', pin)
		apply(pin)
	})
	systemDark.addEventListener('change', () => {
		if (document.documentElement.dataset.theme === 'auto') apply(null)
	})
}

/** Scroll progress fallback for engines without `animation-timeline: scroll()`. */
function initScrollProgress(): void {
	if (prefersReducedMotion()) return
	if (CSS.supports('animation-timeline', 'scroll()')) return
	const bar = document.getElementById('read-progress')
	if (!bar) return
	let raf = 0
	const update = () => {
		raf = 0
		const max = document.documentElement.scrollHeight - window.innerHeight
		const pct = max > 0 ? Math.max(0, Math.min(1, window.scrollY / max)) : 0
		bar.style.transform = `scaleX(${pct})`
	}
	window.addEventListener(
		'scroll',
		() => {
			if (!raf) raf = requestAnimationFrame(update)
		},
		{passive: true},
	)
	update()
}

function renderMastheadKpis(ds: LoopsDataset): void {
	const host = byId<HTMLDivElement>('kpis')
	const {agents, tools, turns} = ds.stats
	const totalChars = d3.sum(agents, a => a.chars)
	const totalTokens = d3.sum(agents, a => a.tokensEst)
	const totalToolCalls = d3.sum(tools, t => t.calls)
	const totalErrors = d3.sum(tools, t => t.errors)
	const totalSteps = d3.sum(turns, t => t.steps)
	const totalCost = d3.sum(agents, a => costOf(a.tokensEst, a.agent))
	const peakCtx = d3.max(turns, t => t.contextCharsAtEnd) ?? 0

	const item = (label: string, value: string, sub: string) =>
		el(
			'div',
			{class: 'kpi'},
			el('div', {class: 'kpi-value'}, value),
			el('div', {class: 'kpi-label'}, label),
			el('div', {class: 'kpi-sub'}, sub),
		)

	host.replaceChildren(
		item(
			'Threads',
			fmtInt(ds.source.threadIds.length),
			`${fmtInt(ds.source.messageCount)} messages`,
		),
		item('Turns', fmtInt(turns.length), `${fmtInt(totalSteps)} observed steps`),
		item(
			'Tool calls',
			fmtInt(totalToolCalls),
			totalErrors ? `${fmtInt(totalErrors)} errors` : '0 errors',
		),
		item(
			'Volume',
			`${fmtCompact(totalChars)} chars`,
			`≈${fmtCompact(totalTokens)} est. tokens`,
		),
		item(
			'Assumed cost',
			fmtCost(totalCost),
			`${fmtRate(rateFor(undefined))} default · est.`,
		),
		item(
			'Peak context',
			`${fmtCompact(peakCtx)} chars`,
			'at end of largest turn',
		),
	)
}

function renderSource(loaded: LoadedDataset): void {
	const {data, isFixture, url, loadNote} = loaded
	const datelineText = byId<HTMLSpanElement>('dateline-text')
	const datelineDot = byId<HTMLSpanElement>('dateline-dot')
	datelineDot.classList.toggle('is-fixture', isFixture)
	datelineText.textContent = `${isFixture ? 'Fixture trace' : 'Observed trace'} · ${fmtInt(data.source.threadIds.length)} threads · ${fmtInt(data.source.messageCount)} messages · ${fmtTime(data.generatedAt)}`

	const banner = byId<HTMLDivElement>('banner')
	if (isFixture) {
		banner.hidden = false
		banner.classList.add('is-warning')
		banner.replaceChildren(
			el('strong', {}, 'Fixture dataset. '),
			`${loadNote} Nothing shown here is real Obvious activity.`,
		)
	} else {
		// Live data needs no banner box — provenance lives quietly in the dateline + colophon.
		banner.hidden = true
	}

	byId<HTMLParagraphElement>('source-text').textContent = data.source.storage
	const meta = byId<HTMLDListElement>('source-meta')
	const rows: [string, string][] = [
		['generated', fmtTime(data.generatedAt)],
		['loaded from', url],
		['project', data.source.projectId],
		[
			'threads',
			`${fmtInt(data.source.threadIds.length)} (${data.source.threadIds.join(', ')})`,
		],
		['messages', fmtInt(data.source.messageCount)],
		['schema version', String(data.version)],
	]
	meta.replaceChildren(
		...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]),
	)
	byId<HTMLSpanElement>('footer-note').textContent =
		`Token counts are estimates (chars ÷ 4). Generated ${fmtTime(data.generatedAt)} · ${isFixture ? 'fixture' : 'live'} dataset.`
}

/**
 * Scrollspy for the sticky chapter rail (scrollspy guide):
 * uses native `scroll-target-group: auto` + `:target-current` where supported
 * (syncing `aria-current` on `scrollend`), and falls back to IntersectionObserver.
 */
function initScrollspy(
	navLinks: HTMLAnchorElement[],
	sections: HTMLElement[],
): () => void {
	const setActive = (id: string | null) => {
		for (const link of navLinks) {
			const on = id !== null && link.getAttribute('href') === `#${id}`
			link.classList.toggle('target-current', on)
			link.setAttribute('aria-current', on ? 'true' : 'false')
		}
	}

	if (CSS.supports('scroll-target-group: auto')) {
		const syncAria = () => {
			const current = navLinks.find(l => l.matches(':target-current'))
			for (const l of navLinks) {
				l.setAttribute('aria-current', l === current ? 'true' : 'false')
			}
		}
		syncAria()
		const onEnd = () => syncAria()
		document.addEventListener('scrollend', onEnd)
		return () => document.removeEventListener('scrollend', onEnd)
	}

	const obs = new IntersectionObserver(
		entries => {
			const visible = entries
				.filter(e => e.isIntersecting)
				.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
			if (visible[0]?.target.id) setActive(visible[0].target.id)
		},
		{rootMargin: '-22% 0px -68% 0px', threshold: 0},
	)
	for (const sec of sections) obs.observe(sec)
	if (sections[0]) setActive(sections[0].id)
	return () => obs.disconnect()
}

async function renderEssay(ds: LoopsDataset): Promise<void> {
	const navHost = byId<HTMLDivElement>('chapter-nav')
	const platesHost = byId<HTMLDivElement>('plates')
	navHost.replaceChildren()
	platesHost.replaceChildren()

	const disposers: (() => void)[] = []
	const navLinks: HTMLAnchorElement[] = []
	const sections: HTMLElement[] = []
	const mountById = new Map<string, () => void>()
	const mounted = new Set<string>()
	const initialHash = location.hash.slice(1)

	// Open the Colophon <details> automatically when jumping to #colophon.
	document
		.querySelector<HTMLAnchorElement>('a[href="#colophon"]')
		?.addEventListener('click', () => {
			const det = document.getElementById(
				'source-details',
			) as HTMLDetailsElement | null
			if (det) det.open = true
		})

	for (const p of PLATES) {
		const link = el(
			'a',
			{href: `#${p.id}`, class: 'chapter-link'},
			el('span', {class: 'chapter-link-num'}, p.navNum),
			p.navLabel,
		)
		link.addEventListener('click', () => {
			mountById.get(p.id)?.()
		})
		navLinks.push(link)
		navHost.append(link)

		const shouldDefer = Boolean(p.defer) && p.id !== initialHash
		const section = el('section', {
			id: p.id,
			class: `plate${shouldDefer ? ' plate-deferred' : ''}`,
			tabindex: '-1',
			'aria-labelledby': `${p.id}-heading`,
		})

		const kicker = el(
			'div',
			{class: 'plate-kicker'},
			el('span', {class: 'plate-kicker-num'}, p.kickerNum),
			p.kickerDomain,
			...(p.kickerTag
				? [el('span', {class: 'plate-kicker-tag'}, p.kickerTag)]
				: []),
		)
		const head = el(
			'header',
			{class: 'plate-head'},
			kicker,
			el('h2', {id: `${p.id}-heading`, class: 'plate-title'}, p.title(ds)),
			el('p', {class: 'plate-deck'}, p.deck(ds)),
		)
		const host = el('div', {class: 'plate-host'})
		section.append(head, host)
		platesHost.append(section)
		sections.push(section)

		const mount = () => {
			if (mounted.has(p.id)) return
			mounted.add(p.id)
			try {
				const dispose = p.render(host, ds)
				if (dispose) disposers.push(dispose)
			} catch (e) {
				host.replaceChildren(
					el(
						'p',
						{class: 'error'},
						`This plate failed to render: ${e instanceof Error ? e.message : String(e)}`,
					),
				)
				console.error(`[plate ${p.id}]`, e)
			}
		}
		mountById.set(p.id, mount)
	}

	// Mount Plates I & II (plus any deep-linked plate) eagerly, yielding between tasks.
	const eagerIds = new Set(['loops', 'sankey'])
	if (initialHash && mountById.has(initialHash)) eagerIds.add(initialHash)
	for (const id of eagerIds) {
		mountById.get(id)?.()
		await yieldToMain()
	}

	// Lazy-mount remaining plates right before they scroll into view.
	const lazyObserver = new IntersectionObserver(
		entries => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					const id = entry.target.id
					mountById.get(id)?.()
					lazyObserver.unobserve(entry.target)
				}
			}
		},
		{rootMargin: '450px 0px'},
	)
	for (const sec of sections) {
		if (!mounted.has(sec.id)) lazyObserver.observe(sec)
	}
	disposers.push(() => lazyObserver.disconnect())

	const stopSpy = initScrollspy(navLinks, sections)
	disposers.push(stopSpy)

	// Honor initial hash target (e.g. /#sankey or /#tokens) cleanly.
	if (initialHash) {
		if (initialHash === 'colophon') {
			const det = document.getElementById(
				'source-details',
			) as HTMLDetailsElement | null
			if (det) det.open = true
		}
		const target = document.getElementById(initialHash)
		if (target) {
			requestAnimationFrame(() =>
				target.scrollIntoView({behavior: 'instant' as ScrollBehavior}),
			)
		}
	}

	window.addEventListener(
		'pagehide',
		() => {
			for (const dispose of disposers) dispose()
		},
		{once: true},
	)
}

async function main(): Promise<void> {
	initTheme()
	initScrollProgress()
	try {
		const loaded = await loadDataset()
		renderSource(loaded)
		renderMastheadKpis(loaded.data)
		const kpiHost = byId<HTMLDivElement>('kpis')
		onRatesChange(kpiHost, () => renderMastheadKpis(loaded.data))
		await renderEssay(loaded.data)
	} catch (e) {
		const banner = byId<HTMLDivElement>('banner')
		banner.hidden = false
		banner.classList.add('is-error')
		banner.textContent = `Could not load any dataset: ${e instanceof Error ? e.message : String(e)}`
		byId<HTMLParagraphElement>('source-text').textContent = '—'
	}
}

void main()
