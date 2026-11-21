/** Yield to the main thread (Modern Web Guidance: break-up-long-tasks), with the mandated setTimeout fallback. */
export async function yieldToMain(): Promise<void> {
	const sch = (
		globalThis as unknown as {scheduler?: {yield?: () => Promise<void>}}
	).scheduler
	if (sch && typeof sch.yield === 'function') {
		await sch.yield()
		return
	}
	await new Promise<void>(r => setTimeout(r, 0))
}

/** Run `fn(item)` over `items`, yielding whenever the 50 ms long-task budget is exhausted. */
export async function forEachYielding<T>(
	items: readonly T[],
	fn: (item: T, i: number) => void,
): Promise<void> {
	let deadline = performance.now() + 50
	for (let i = 0; i < items.length; i++) {
		fn(items[i] as T, i)
		if (performance.now() >= deadline) {
			await yieldToMain()
			deadline = performance.now() + 50
		}
	}
}

export const prefersReducedMotion = (): boolean =>
	matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Roving tabindex for a group of focusable chart elements (accessibility guide §5):
 * one tab stop per group, arrow keys move within it, Home/End jump.
 */
const rovingBound = new WeakSet<Element>()
export function makeRoving(container: Element, selector: string): void {
	const items = (): HTMLElement[] =>
		Array.from(container.querySelectorAll<HTMLElement>(selector))
	const setCurrent = (el: HTMLElement) => {
		for (const it of items()) it.tabIndex = it === el ? 0 : -1
	}
	const first = items()[0]
	for (const it of items()) it.tabIndex = -1
	if (first) first.tabIndex = 0
	if (rovingBound.has(container)) return // re-render: only reset tabindexes, listeners already delegated
	rovingBound.add(container)

	container.addEventListener('focusin', e => {
		const t = (e.target as Element | null)?.closest<HTMLElement>(selector)
		if (t && container.contains(t)) setCurrent(t)
	})
	container.addEventListener('keydown', e => {
		const ke = e as KeyboardEvent
		const t = (ke.target as Element | null)?.closest<HTMLElement>(selector)
		if (!t) return
		const list = items()
		const i = list.indexOf(t)
		if (i < 0) return
		let next: HTMLElement | undefined
		switch (ke.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				next = list[(i + 1) % list.length]
				break
			case 'ArrowLeft':
			case 'ArrowUp':
				next = list[(i - 1 + list.length) % list.length]
				break
			case 'Home':
				next = list[0]
				break
			case 'End':
				next = list[list.length - 1]
				break
			default:
				return
		}
		if (next) {
			ke.preventDefault()
			setCurrent(next)
			next.focus()
		}
	})
}

/**
 * Observe container width; call `render(width)` (debounced to animation frames).
 * Returns a disposer — call it before re-rendering the same region so old
 * observers don't keep observing detached DOM for the life of the page.
 */
export function onResize(
	el: Element,
	render: (width: number) => void,
): () => void {
	let raf = 0
	let last = -1
	const ro = new ResizeObserver(entries => {
		const w = Math.floor(
			entries[0]?.contentRect.width ?? el.getBoundingClientRect().width,
		)
		if (w === last || w === 0) return
		last = w
		cancelAnimationFrame(raf)
		raf = requestAnimationFrame(() => render(w))
	})
	ro.observe(el)
	return () => {
		cancelAnimationFrame(raf)
		ro.disconnect()
	}
}

export interface ResizeScope {
	observe(el: Element, render: (width: number) => void): void
	dispose(): void
}

export function createResizeScope(): ResizeScope {
	const disposers = new Set<() => void>()
	return {
		observe(el, render) {
			const dispose = onResize(el, render)
			disposers.add(dispose)
		},
		dispose() {
			for (const dispose of disposers) dispose()
			disposers.clear()
		},
	}
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag)
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') e.className = v
		else e.setAttribute(k, v)
	}
	for (const c of children) e.append(c)
	return e
}
