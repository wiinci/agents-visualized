import { describe, expect, it } from 'vitest';
import { fmtInt, fmtTokens, statusGlyph } from '../src/format';

describe('statusGlyph', () => {
  it('maps the same synonym set as statusColor, so glyph and colour agree', () => {
    expect(statusGlyph('completed')).toBe('✓');
    expect(statusGlyph('done')).toBe('✓');
    expect(statusGlyph('running')).toBe('▶');
    expect(statusGlyph('in_progress')).toBe('▶');
    expect(statusGlyph('waiting')).toBe('⏸');
    expect(statusGlyph('needs_input')).toBe('⏸');
    expect(statusGlyph('error')).toBe('✗');
    expect(statusGlyph('cancelled')).toBe('✗');
    expect(statusGlyph('pending')).toBe('○');
  });
  it('falls back to the open-circle glyph for unknown statuses', () => {
    expect(statusGlyph('invented-status')).toBe('○');
    expect(statusGlyph(undefined)).toBe('○');
  });
});

describe('formatters', () => {
  it('declare estimate and missing-data states', () => {
    expect(fmtTokens(undefined)).toBe('—');
    expect(fmtTokens(1234)).toBe('≈1,234 tokens (est.)');
    expect(fmtInt(0)).toBe('0');
  });
});
