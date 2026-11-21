import { describe, expect, it } from 'vitest';
import { agentClassOf, costOf, fmtCost, fmtRate } from '../src/cost';

describe('agentClassOf', () => {
  it('maps agent ids to classes', () => {
    expect(agentClassOf('user')).toBe('user');
    expect(agentClassOf('orchestrator')).toBe('orchestrator');
    expect(agentClassOf('worker:coder')).toBe('worker');
    expect(agentClassOf('worker')).toBe('worker');
    expect(agentClassOf('mystery-agent')).toBe('other');
    expect(agentClassOf(undefined)).toBe('other');
  });
});

describe('fmtCost', () => {
  it('keeps four decimals below a cent so small turns do not collapse to $0.00', () => {
    expect(fmtCost(0.0015)).toBe('$0.0015');
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(0.02)).toBe('$0.02');
    expect(fmtCost(3)).toBe('$3.00');
  });
  it('rounds in binary floats, not decimal — 0.015 is really 0.01499…', () => {
    expect(fmtCost(0.015)).toBe('$0.01'); // documents d3's float behaviour, not a bug
  });
  it('renders non-finite input as an em dash', () => {
    expect(fmtCost(NaN)).toBe('—');
    expect(fmtCost(Infinity)).toBe('—');
  });
});

describe('fmtRate', () => {
  it('labels the unit', () => {
    expect(fmtRate(3)).toBe('$3.00 / 1M tokens');
  });
});

describe('costOf', () => {
  it('prices estimated tokens at the default assumed rate', () => {
    // Default rate is 3 USD / 1M tokens (DEFAULT_RATE in cost.ts).
    expect(costOf(1_000_000, 'orchestrator')).toBeCloseTo(3, 10);
    expect(costOf(1, 'worker:x')).toBeCloseTo(3e-6, 12);
  });
  it('treats undefined or non-finite tokens as zero cost', () => {
    expect(costOf(undefined, 'user')).toBe(0);
    expect(costOf(Number.NaN, 'user')).toBe(0);
  });
});
