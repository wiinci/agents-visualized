// @vitest-environment jsdom
import {describe, expect, it} from 'vitest'
import type {FlowLink, FlowNode} from '../src/types'
import {originNode, rank, splitCycles} from '../src/views/sankey-model'

const node = (id: string, stage: FlowNode['stage']): FlowNode => ({
	id,
	name: id,
	stage,
	kind: 'reasoning',
	count: 1,
})

describe('Sankey graph helpers', () => {
	it('ranks tools together and identifies return edges', () => {
		expect(rank('tool:search')).toBe(2)
		expect(rank('observe')).toBe(3)
		expect(rank('unknown')).toBe(2)

		const nodes = [node('u', 'user'), node('r', 'reason'), node('o', 'observe')]
		const forward: FlowLink = {
			source: 'u',
			target: 'r',
			value: 2,
			kind: 'sequence',
		}
		const back: FlowLink = {
			source: 'o',
			target: 'r',
			value: 1,
			kind: 'sequence',
		}
		const split = splitCycles(nodes, [forward, back])

		expect(split.forward).toEqual([forward])
		expect(split.back).toEqual([back])
	})

	it('uses the leftmost source node as the origin', () => {
		const nodes = [node('u', 'user'), node('w', 'wake'), node('r', 'reason')]
		expect(originNode(nodes, [])?.id).toBe('u')
	})
})
