// @vitest-environment jsdom
import {describe, expect, it} from 'vitest'
import {createInfoPanel, withCostRow, type PanelContent} from '../src/panel'

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
})
