// @vitest-environment jsdom
import {describe, expect, it} from 'vitest'
import {
	buildAgentSeries,
	cumulativeTurnTotals,
	perTurnTotals,
} from '../src/views/tokens-model'

describe('tokens series helpers', () => {
	it('separates per-turn deltas from cumulative totals', () => {
		const values: Record<string, number[]> = {
			worker: [2, 3],
			orchestrator: [5, 1],
		}
		const series = buildAgentSeries(
			['worker', 'orchestrator'],
			2,
			(agent, index) => values[agent]?.[index] ?? 0,
		)

		expect(perTurnTotals(series)).toEqual([7, 4])
		expect(cumulativeTurnTotals(series)).toEqual([7, 11])
		expect(series[0]).toEqual({agent: 'worker', delta: [2, 3], cum: [2, 5]})
	})

	it('supports turns with no activity and zero-length series', () => {
		const series = buildAgentSeries(['worker'], 3, () => 0)
		expect(perTurnTotals(series)).toEqual([0, 0, 0])
		expect(cumulativeTurnTotals(series)).toEqual([0, 0, 0])
		expect(perTurnTotals([])).toEqual([])
	})
})
