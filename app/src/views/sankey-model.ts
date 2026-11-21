import type {FlowLink, FlowNode, LoopNode} from '../types'
import {stageOf} from '../data'

export interface StageSizes {
	n: number
	contextSum: number
	contextN: number
	promptSum: number
	promptN: number
	tokensSum: number
	tokensN: number
}

const STAGE_RANK: Readonly<Record<string, number>> = {
	user: 0,
	wake: 0,
	reason: 1,
	delegate: 2,
	worker: 3,
	observe: 3,
	respond: 4,
}

export function rank(stage: string): number {
	return stage.startsWith('tool:') ? 2 : (STAGE_RANK[stage] ?? 2)
}

export function splitCycles(
	nodes: readonly FlowNode[],
	links: readonly FlowLink[],
): {
	forward: FlowLink[]
	back: FlowLink[]
} {
	const byId = new Map(nodes.map(node => [node.id, node]))
	const rankOf = (id: string): number => rank(byId.get(id)?.stage ?? '')
	const forward: FlowLink[] = []
	const back: FlowLink[] = []
	for (const link of links) {
		;(rankOf(link.target) > rankOf(link.source) ? forward : back).push(link)
	}
	return {forward, back}
}

export function collectStageSizes(
	root: LoopNode,
	nodes: readonly FlowNode[],
): Map<string, StageSizes> {
	const byStage = new Map<string, string>(
		nodes.map(node => [node.stage, node.id]),
	)
	const out = new Map<string, StageSizes>()
	const walk = (node: LoopNode): void => {
		const id = byStage.get(stageOf(node))
		if (id && node.meta) {
			const sizes = out.get(id) ?? {
				n: 0,
				contextSum: 0,
				contextN: 0,
				promptSum: 0,
				promptN: 0,
				tokensSum: 0,
				tokensN: 0,
			}
			sizes.n++
			const context =
				node.meta.contextChars ??
				(typeof node.meta.contextCharsAtEnd === 'number'
					? node.meta.contextCharsAtEnd
					: undefined)
			if (context !== undefined) {
				sizes.contextSum += context
				sizes.contextN++
			}
			if (node.meta.promptChars !== undefined) {
				sizes.promptSum += node.meta.promptChars
				sizes.promptN++
			}
			if (node.meta.tokensEst !== undefined) {
				sizes.tokensSum += node.meta.tokensEst
				sizes.tokensN++
			}
			out.set(id, sizes)
		}
		for (const child of node.children ?? []) walk(child)
	}
	walk(root)
	return out
}

export function metricOf(
	sizes: StageSizes | undefined,
	metric: 'context' | 'prompt',
): {
	mean: number
	n: number
} {
	if (!sizes) return {mean: 0, n: 0}
	return metric === 'context'
		? {
				mean: sizes.contextN ? sizes.contextSum / sizes.contextN : 0,
				n: sizes.contextN,
			}
		: {
				mean: sizes.promptN ? sizes.promptSum / sizes.promptN : 0,
				n: sizes.promptN,
			}
}

export function originNode(
	nodes: readonly FlowNode[],
	links: readonly FlowLink[],
): FlowNode | undefined {
	const sources = nodes.filter(
		node => !links.some(link => link.target === node.id),
	)
	return sources.find(node => rank(node.stage) === 0) ?? sources[0]
}
