import { describe, expect, it } from 'vitest';
import { STATUS_COLORS, canonicalStatus, colorFor, statusColor } from '../src/colors';
import { stageColor } from '../src/format';
import type { Stage } from '../src/types';

describe('canonicalStatus / statusColor', () => {
  it('maps every documented dataset spelling onto the canonical hue', () => {
    expect(statusColor('completed')).toBe('#15803d');
    expect(statusColor('done')).toBe('#15803d');
    expect(statusColor('success')).toBe('#15803d');
    expect(statusColor('running')).toBe('#0284c7');
    expect(statusColor('in_progress')).toBe('#0284c7');
    expect(statusColor('waiting')).toBe('#a16207');
    expect(statusColor('needs_input')).toBe('#a16207');
    expect(statusColor('cancelled')).toBe('#b91c1c');
    expect(statusColor('error')).toBe('#b91c1c');
    expect(statusColor('pending')).toBe('#6b7280');
  });

  it('is case-insensitive and renders unknown statuses neutral grey', () => {
    expect(statusColor('DONE')).toBe('#15803d');
    expect(statusColor('some-future-status')).toBe('#6b7280');
    expect(statusColor(undefined)).toBe('#6b7280');
    expect(canonicalStatus('nope')).toBeUndefined();
  });
});

describe('reservation rule: status hues are unique in the system', () => {
  it('no canonical status hue equals any canonical stage or agent hue', () => {
    const namedStages: Stage[] = ['user', 'reason', 'observe', 'respond', 'delegate', 'worker', 'wake'];
    const reserved = new Set([
      ...namedStages.map((s) => stageColor(s)),
      stageColor('tool:anything'),
      '#2563eb', // agentColor('user')
      '#4f46e5', // agentColor('orchestrator')
      '#6b7280', // the neutral fallback, shared by design
    ]);
    for (const [status, hue] of Object.entries(STATUS_COLORS)) {
      // '#6b7280' (todo) is the one deliberate shared neutral
      if (hue === '#6b7280') continue;
      expect(reserved.has(hue), `status ${status} collides with a reserved hue`).toBe(false);
    }
  });
});

describe('colorFor', () => {
  it('dispatches on the domain tag', () => {
    expect(colorFor({ domain: 'status', value: 'done' })).toBe(statusColor('done'));
    expect(colorFor({ domain: 'agent', value: 'orchestrator' })).toBe('#4f46e5');
    expect(colorFor({ domain: 'stage', value: 'user' })).toBe('#2563eb'); // the stage IS the agent's own action
    expect(colorFor({ domain: 'stage', value: 'reason' })).toBe('#4f46e5');
  });
});
