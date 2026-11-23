// @vitest-environment jsdom
import {describe, expect, it} from 'vitest'
import {
	createInfoPanel,
	wireInfoPanel,
	withCostRow,
	type PanelContent,
} from '../src/panel'

const content = (
	title: string,
	rows: [string, string][] = [['size', '1,000 chars']],
): PanelContent => ({
	title,
	rows,
})

describe('withCostRow', () => {
	it('inserts the cost row after the size row without mutating its input', () => {
		const input = content('turn', [
			['size', '1,000 chars'],
			['started', 'now'],
		])
		const before = [...input.rows]
		const out = withCostRow(input, 1_000_000, 'orchestrator')
		expect(out.rows.map(([label]) => label)).toEqual([
			'size',
			'cost (assumed)',
			'started',
		])
		expect(input.rows).toEqual(before) // the original is untouched
		expect(out).not.toBe(input)
	})

	it('appends when no size row exists', () => {
		const out = withCostRow(content('x', [['a', 'b']]), 1_000_000, 'user')
		expect(out.rows.at(-1)![0]).toBe('cost (assumed)')
	})

	it('is a no-op without token data and returns the same object', () => {
		const input = content('x')
		expect(withCostRow(input, undefined, 'user')).toBe(input)
	})
})

describe('createInfoPanel', () => {
	it('renders the default content on construction', () => {
		const p = createInfoPanel({
			headingId: 't1',
			heading: 'Details',
			contentFor: () => null,
			defaultContent: () => content('overview'),
		})
		expect(p.root.querySelector('h3#t1')!.textContent).toBe('Details')
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'overview',
		)
	})

	it('swaps to the keyed content and back to the default on null', () => {
		const p = createInfoPanel({
			headingId: 't2',
			heading: 'Details',
			contentFor: key =>
				key === 'n1' ? content('node one', [['steps', '3']]) : null,
			defaultContent: () => content('overview'),
		})
		p.showKey('n1')
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'node one',
		)
		p.showKey(null)
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'overview',
		)
	})

	it('is a no-op when the key is unchanged, and refresh() re-renders current state', () => {
		let calls = 0
		const p = createInfoPanel({
			headingId: 't3',
			heading: 'Details',
			contentFor: () => {
				calls += 1
				return content('k')
			},
			defaultContent: () => null,
		})
		p.showKey('a')
		const n = calls
		p.showKey('a') // unchanged → no re-render
		expect(calls).toBe(n)
		p.refresh()
		expect(calls).toBe(n + 1)
	})

	it('keeps the panel a live region labelled by its own heading', () => {
		const p = createInfoPanel({
			headingId: 't4',
			heading: 'Node details',
			contentFor: () => null,
			defaultContent: () => content('o'),
		})
		const aside = p.root as HTMLElement
		expect(aside.tagName).toBe('ASIDE')
		expect(aside.getAttribute('aria-live')).toBe('polite')
		expect(aside.getAttribute('aria-labelledby')).toBe('t4')
	})

	it('locks display while pinned and releases on toggle or null', () => {
		const p = createInfoPanel({
			headingId: 't5',
			heading: 'Details',
			contentFor: key => content(`item:${key}`),
			defaultContent: () => content('overview'),
		})
		p.pinKey('a')
		expect(p.pinnedKey()).toBe('a')
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'item:a',
		)
		p.showKey('b') // hover ignored while pinned
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'item:a',
		)
		p.pinKey('a') // toggle off
		expect(p.pinnedKey()).toBeNull()
		p.showKey('b')
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'item:b',
		)
	})

	it('steps through pinned sequences and renders hover-compare deltas', () => {
		const seq = ['a', 'b', 'c']
		const vals: Record<string, number> = {a: 100, b: 150, c: 50}
		const p = createInfoPanel({
			headingId: 't6',
			heading: 'Details',
			contentFor: key => ({
				title: `item:${key}`,
				rows: [],
				compareValue: {value: vals[key] ?? 0, formatted: `${vals[key] ?? 0}`},
				share: {ratio: 0.5, label: '50% share'},
				metaRows: [['id', key]],
			}),
			sequenceFor: () => seq,
			defaultContent: () => content('overview'),
		})
		p.pinKey('a')
		expect(p.root.classList.contains('is-pinned')).toBe(true)
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'1 / 3',
		)
		expect(p.root.querySelector('.marginalia-share-label')!.textContent).toBe(
			'50% share',
		)
		expect(p.root.querySelector('.marginalia-meta summary')!.textContent).toBe(
			'Trace IDs (1)',
		)

		// Hovering another key while pinned shows compare bar without changing title
		p.showKey('b')
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'item:a',
		)
		const cmp = p.root.querySelector('.marginalia-compare') as HTMLElement
		expect(cmp.hidden).toBe(false)
		expect(cmp.textContent).toContain('item:b')
		expect(cmp.textContent).toContain('+50% vs pinned')

		// Step forward updates pin and hides compare bar
		expect(p.step(1)).toBe(true)
		expect(p.pinnedKey()).toBe('b')
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'2 / 3',
		)
		expect(cmp.hidden).toBe(true)
	})

	it('tethers .is-pinned on chart marks and cleans up listeners on dispose', () => {
		const host = document.createElement('div')
		const btnA = document.createElement('button')
		btnA.setAttribute('data-hit', 'node')
		btnA.setAttribute('data-key', 'a')
		btnA.setAttribute('role', 'button')
		const btnB = document.createElement('button')
		btnB.setAttribute('data-hit', 'node')
		btnB.setAttribute('data-key', 'b')
		btnB.setAttribute('role', 'button')
		host.append(btnA, btnB)

		const p = createInfoPanel({
			headingId: 't7',
			heading: 'Details',
			contentFor: key => content(`item:${key}`),
			sequenceFor: () => ['a', 'b'],
			defaultContent: () => content('overview'),
		})
		const dispose = wireInfoPanel([host], p)
		btnA.click()
		expect(p.pinnedKey()).toBe('a')
		expect(btnA.classList.contains('is-pinned')).toBe(true)
		expect(btnA.getAttribute('aria-pressed')).toBe('true')
		expect(btnB.classList.contains('is-pinned')).toBe(false)

		p.step(1)
		expect(btnA.classList.contains('is-pinned')).toBe(false)
		expect(btnB.classList.contains('is-pinned')).toBe(true)

		dispose()
		// After dispose, Escape should no longer unpin via the disposed document listener
		document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))
		expect(p.pinnedKey()).toBe('b')
	})

	it('steps directly from Overview on → (first item) and ← (last item)', () => {
		const p = createInfoPanel({
			headingId: 't8',
			heading: 'Details',
			contentFor: key => content(`item:${key}`),
			sequenceFor: () => ['x', 'y', 'z'],
			defaultContent: () => content('overview'),
		})
		const nextBtn = p.root.querySelector(
			'.marginalia-step-btn[aria-label="Next item"]',
		) as HTMLButtonElement
		const prevBtn = p.root.querySelector(
			'.marginalia-step-btn[aria-label="Previous item"]',
		) as HTMLButtonElement
		const stepper = p.root.querySelector('.marginalia-stepper') as HTMLElement
		expect(stepper.hidden).toBe(false)
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'– / 3',
		)

		nextBtn.click()
		expect(p.pinnedKey()).toBe('x')
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'1 / 3',
		)
		nextBtn.click()
		expect(p.pinnedKey()).toBe('y')
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'2 / 3',
		)

		// Unpin back to Overview, then click ← to jump to last item
		p.pinKey(null)
		expect(p.root.querySelector('.sankey-panel-title')!.textContent).toBe(
			'overview',
		)
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'– / 3',
		)
		prevBtn.click()
		expect(p.pinnedKey()).toBe('z')
		expect(p.root.querySelector('.marginalia-step-pos')!.textContent).toBe(
			'3 / 3',
		)
	})
})
