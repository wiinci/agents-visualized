import { describe, expect, it } from 'vitest';
import type { LoopNode } from '../src/types';
import { collectThreads, isStepKind, turnKey } from '../src/data';

/** Minimal loop-node factory for fixtures. */
const node = (kind: LoopNode['kind'], extra: Partial<LoopNode> = {}): LoopNode => ({
  id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
  kind,
  ...extra,
} as LoopNode);

describe('turnKey', () => {
  it('produces the app-wide threadId#turnIndex convention (0-based index)', () => {
    expect(turnKey('th1', 0)).toBe('th1#0');
    expect(turnKey('thread-abc', 12)).toBe('thread-abc#12');
  });
});

describe('collectThreads', () => {
  // project → thread(th1) → turn0(2 steps) → turn1(1 step)
  //           th1/turn1 step nests worker-thread(wt1) with 2 steps of its own
  const wt1 = node('worker-thread', {
    id: 'wt1',
    meta: { threadId: 'wt1' },
    children: [
      node('turn', { children: [node('reasoning'), node('text')] }),
    ],
  });
  const taskInTurn1 = node('task', { children: [wt1] });
  const th1 = node('thread', {
    id: 'th1',
    meta: { threadId: 'th1' },
    children: [
      node('turn', { children: [node('user-message'), node('reasoning')] }),
      node('turn', { children: [node('user-message'), taskInTurn1] }),
    ],
  });
  const root = node('project', { id: 'proj', children: [th1] });

  it('indexes each thread by its threadId', () => {
    const threads = collectThreads(root);
    expect([...threads.keys()].sort()).toEqual(['th1', 'wt1']);
  });

  it('numbers stepIndexInThread sequentially from 0 within each thread', () => {
    const threads = collectThreads(root);
    const th1idx = threads.get('th1')!.steps.map((s) => s.stepIndexInThread);
    const wt1idx = threads.get('wt1')!.steps.map((s) => s.stepIndexInThread);
    expect(th1idx).toEqual([0, 1, 2, 3]);
    expect(wt1idx).toEqual([0, 1]);
  });

  it('records the owning turn for each step', () => {
    const threads = collectThreads(root);
    const steps = threads.get('th1')!.steps;
    expect(steps[0]!.turn.kind).toBe('turn');
    expect(steps[0]!.turn).toBe(threads.get('th1')!.thread.children![0]);
  });

  it('excludes container kinds from steps but keeps threading them', () => {
    expect(isStepKind('turn')).toBe(false);
    expect(isStepKind('thread')).toBe(false);
    expect(isStepKind('worker-thread')).toBe(false);
    expect(isStepKind('task')).toBe(true);
  });
});
