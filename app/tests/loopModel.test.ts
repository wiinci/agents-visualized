import {describe, expect, it} from 'vitest'
import {cleanLoopDescriptions} from '../src/views/loopModel'

describe('cleanLoopDescriptions', () => {
	it('strips a shared leading disclaimer sentence across loop cards', () => {
		const input = [
			'Documented model (from Obvious operating instructions), not observed. One user message and everything the assistant does until its single closing message.',
			'Documented model (from Obvious operating instructions), not observed. Orchestrator decomposes work and dispatches workers.',
			'Documented model (from Obvious operating instructions), not observed. Domain-matched skills are loaded and unloaded.',
		]
		expect(cleanLoopDescriptions(input)).toEqual([
			'One user message and everything the assistant does until its single closing message.',
			'Orchestrator decomposes work and dispatches workers.',
			'Domain-matched skills are loaded and unloaded.',
		])
	})

	it('leaves distinct descriptions untouched', () => {
		const input = [
			'One user message and everything the assistant does until the closing message.',
			'Orchestrator splits work into subtasks and wakes on completion.',
		]
		expect(cleanLoopDescriptions(input)).toEqual(input)
	})
})
