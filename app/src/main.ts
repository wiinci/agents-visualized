import './styles.css'
import {loadDataset} from './data'
import type {LoadedDataset, LoopsDataset} from './types'
import {fmtInt, fmtTime} from './format'
import {el, yieldToMain} from './util'
import {renderSankey} from './views/sankey'
import {renderHierarchy} from './views/hierarchy'
import {renderContext} from './views/context'
import {renderDelegation} from './views/delegation'
import {renderLoopModel} from './views/loopModel'
import {renderSummary} from './views/summary'
import {renderTokens} from './views/tokens'
import {mountRatesControl} from './cost'

interface ViewDef {
	id: string
	label: string
	blurb: string
	render: (host: HTMLElement, ds: LoopsDataset) => (() => void) | void
}

const VIEWS: ViewDef[] = [
	{
		id: 'sankey',
		label: '1 · Loop Sankey',
		blurb:
			'Observed stage transitions: user → reason → tool → observe → … → respond, plus delegate → worker → wake.',
		render: renderSankey,
	},
	{
		id: 'hierarchy',
		label: '2 · Turn hierarchy',
		blurb:
			'Project → thread → turn → step, sized by characters and coloured by agent.',
		render: renderHierarchy,
	},
	{
		id: 'context',
		label: '3 · Context growth',
		blurb: 'Context size at every step of every thread.',
		render: renderContext,
	},
	{
		id: 'delegation',
		label: '4 · Delegation tree',
		blurb: 'Root task → subtasks → worker threads, by status, sized by prompt.',
		render: renderDelegation,
	},
	{
		id: 'loops',
		label: '5 · Documented loop model',
		blurb:
			'The five canonical loops as directed cycles — the model, not the observation.',
		render: renderLoopModel,
	},
	{
		id: 'summary',
		label: '6 · Summary',
		blurb: 'Per-agent, per-tool and per-turn totals.',
		render: renderSummary,
	},
	{
		id: 'tokens',
		label: '7 · Tokens & cost',
		blurb:
			'Estimated tokens per turn and agent — heatmap plus overlaid lines or per-agent small multiples, with an assumed-rate cost estimate (never measured usage).',
		render: renderTokens,
	},
]

function byId<T extends HTMLElement>(id: string): T {
	const e = document.getElementById(id)
	if (!e) throw new Error(`#${id} missing`)
	return e as T
}

/**
 * Colour scheme (dark-mode guide): `color-scheme: light dark` + `light-dark()` in CSS do the work.
 * The toggle is two-state — "system" or the opposite of the current system scheme, pinned exactly
 * (a pin survives later OS changes). The pin is persisted in localStorage, mirrored into the
 * <meta name="color-scheme">, and applied as an inline style so it wins over the stylesheet's :root rule.
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
		// Second option = the pinned scheme if any, else the opposite of the system scheme
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
	// OS theme can change at any time: relabel the opposite option when nothing is pinned (a pin stays put).
	systemDark.addEventListener('change', () => {
		if (document.documentElement.dataset.theme === 'auto') apply(null)
	})
}

function renderSource(loaded: LoadedDataset): void {
	const {data, isFixture, url, loadNote} = loaded
	const banner = byId<HTMLDivElement>('banner')
	if (isFixture) {
		banner.hidden = false
		banner.classList.add('is-warning')
		banner.replaceChildren(
			el('strong', {}, 'Fixture data. '),
			`${loadNote} Nothing shown here is real Obvious activity.`,
		)
	} else {
		banner.hidden = false
		banner.replaceChildren(el('strong', {}, 'Live data. '), loadNote)
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
 * Tabs (WAI-ARIA tabs pattern, manual activation with arrow keys). Panels for
 * inactive tabs are `hidden`, so their ResizeObservers report width 0 and the
 * expensive SVG work is deferred until the panel is shown; rendering is also
 * spread across tasks with scheduler.yield() so no single long task blocks input.
 */
async function renderViews(ds: LoopsDataset): Promise<void> {
	const tablist = byId<HTMLDivElement>('tablist')
	const panels = byId<HTMLDivElement>('panels')
	const disposers: (() => void)[] = []
	const initial = location.hash.slice(1)
	const tabs: HTMLButtonElement[] = []

	const activate = (id: string, focus = false) => {
		for (const t of tabs) {
			const on = t.dataset.view === id
			t.setAttribute('aria-selected', String(on))
			t.tabIndex = on ? 0 : -1
			const p = document.getElementById(`panel-${t.dataset.view}`)
			if (p) p.hidden = !on
			if (on && focus) t.focus()
		}
		history.replaceState(null, '', `#${id}`)
	}

	for (const v of VIEWS) {
		const tab = el(
			'button',
			{
				type: 'button',
				role: 'tab',
				id: `tab-${v.id}`,
				'aria-controls': `panel-${v.id}`,
				'aria-selected': 'false',
				class: 'tab',
			},
			v.label,
		)
		tab.dataset.view = v.id
		tab.addEventListener('click', () => activate(v.id))
		tabs.push(tab)
		tablist.append(tab)

		const panel = el('section', {
			role: 'tabpanel',
			id: `panel-${v.id}`,
			'aria-labelledby': `tab-${v.id}`,
			class: 'panel',
			tabindex: '0',
		})
		panel.hidden = true
		panel.append(
			el('h2', {}, v.label.replace(/^\d+ · /, '')),
			el('p', {class: 'blurb muted'}, v.blurb),
		)
		const host = el('div', {class: 'view-host'})
		panel.append(host)
		panels.append(panel)
		try {
			const dispose = v.render(host, ds)
			if (dispose) disposers.push(dispose)
		} catch (e) {
			host.replaceChildren(
				el(
					'p',
					{class: 'error'},
					`This view failed to render: ${e instanceof Error ? e.message : String(e)}`,
				),
			)
			console.error(`[view ${v.id}]`, e)
		}
		await yieldToMain()
	}

	tablist.addEventListener('keydown', e => {
		const i = tabs.findIndex(t => t === document.activeElement)
		if (i < 0) return
		let n = i
		if (e.key === 'ArrowRight') n = (i + 1) % tabs.length
		else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length
		else if (e.key === 'Home') n = 0
		else if (e.key === 'End') n = tabs.length - 1
		else return
		e.preventDefault()
		activate(tabs[n]!.dataset.view!, true)
	})

	activate(VIEWS.some(v => v.id === initial) ? initial : VIEWS[0]!.id)
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
	// Assumed-rate editor (cost.ts): global control in the site header, persisted in localStorage.
	const tools = document.querySelector<HTMLElement>('.header-tools')
	if (tools) mountRatesControl(tools)
	try {
		const loaded = await loadDataset()
		renderSource(loaded)
		await renderViews(loaded.data)
	} catch (e) {
		const banner = byId<HTMLDivElement>('banner')
		banner.hidden = false
		banner.classList.add('is-error')
		banner.textContent = `Could not load any dataset: ${e instanceof Error ? e.message : String(e)}`
		byId<HTMLParagraphElement>('source-text').textContent = '—'
	}
}

void main()
