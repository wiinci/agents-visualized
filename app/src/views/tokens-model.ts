export interface AgentSeries {
	agent: string
	delta: number[]
	cum: number[]
}

export function buildAgentSeries(
	agents: readonly string[],
	turnCount: number,
	valueAt: (agent: string, turnIndex: number) => number,
): AgentSeries[] {
	return agents.map(agent => {
		const delta = Array.from({length: turnCount}, (_, turnIndex) =>
			valueAt(agent, turnIndex),
		)
		const cum: number[] = []
		delta.reduce((total, value, turnIndex) => {
			cum[turnIndex] = total + value
			return cum[turnIndex] ?? total
		}, 0)
		return {agent, delta, cum}
	})
}

export function perTurnTotals(series: readonly AgentSeries[]): number[] {
	const turnCount = series[0]?.delta.length ?? 0
	return Array.from({length: turnCount}, (_, turnIndex) =>
		series.reduce((total, item) => total + (item.delta[turnIndex] ?? 0), 0),
	)
}

export function cumulativeTurnTotals(series: readonly AgentSeries[]): number[] {
	const turnCount = series[0]?.cum.length ?? 0
	return Array.from({length: turnCount}, (_, turnIndex) =>
		series.reduce((total, item) => total + (item.cum[turnIndex] ?? 0), 0),
	)
}
