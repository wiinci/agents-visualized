import * as d3 from 'd3';
import type { Stage } from './types';

/**
 * Single source of colour semantics. Every palette is addressed through
 * `ColorSpec`, a discriminated union: a call must name its domain, so a
 * colour meant for one vocabulary cannot be passed for another. Only the
 * `stage` domain is a closed, compile-checked vocabulary — stages are
 * constructed by this app (`stageOf`). Agent names and statuses arrive as
 * data (`worker:*` ids, dataset status strings), so those domains are open
 * strings; the domain tag still keeps them from being exchanged with each
 * other or with a stage.
 *
 * Reservation rule (Tufte, "Envisioning Information": colour, like ink, is a
 * shared vocabulary):
 * - Agent hues are canonical and invariant across all views.
 * - A stage may reuse an agent's hue only when the stage IS that agent's
 *   action: `user` (the user's own message) and `reason` (the orchestrator's
 *   thinking). No other stage may borrow an agent hue.
 * - Status hues must not exactly equal any agent or canonical stage hue, so a
 *   blocked task is never confusable with a wake, nor an in-flight one with
 *   the user's marks. Two accidental collisions were shifted:
 *   `in_progress` #2563eb → #0284c7 (was the agent-user blue) and `blocked`
 *   #b45309 → #a16207 (was the worker/wake amber). Both keep ≥3:1 contrast
 *   against the light and dark page backgrounds.
 * - The status green #15803d is canonical; the `respond` stage, which
 *   previously duplicated it, now uses #047857.
 * - Status glyphs (✓ ▶ ⏸ ✗ ○) live in format.ts on the same synonym table
 *   (STATUS_SYNONYMS below), so colour is never the only indicator and the
 *   two mappings cannot drift apart.
 */

export type ColorSpec =
  | { domain: 'agent'; value: string }
  | { domain: 'stage'; value: Stage } // the one closed vocabulary — checked by tsc
  | { domain: 'status'; value: string };

/**
 * Canonical status set and the synonym table mapping every dataset spelling
 * to it. Shared by statusColor (here) and format.ts's statusGlyph, so colour
 * and glyph always agree for a given status string.
 */
export type StatusVocab = 'completed' | 'in_progress' | 'blocked' | 'failed' | 'todo';

export const STATUS_SYNONYMS: Readonly<Record<string, StatusVocab>> = {
  completed: 'completed', done: 'completed', success: 'completed',
  in_progress: 'in_progress', running: 'in_progress', active: 'in_progress',
  blocked: 'blocked', waiting: 'blocked', needs_input: 'blocked',
  failed: 'failed', error: 'failed', cancelled: 'failed',
  todo: 'todo', pending: 'todo',
};

export const canonicalStatus = (status: string | undefined): StatusVocab | undefined =>
  STATUS_SYNONYMS[(status ?? '').toLowerCase()];

export const STATUS_COLORS: Readonly<Record<StatusVocab, string>> = {
  completed: '#15803d',
  in_progress: '#0284c7',
  blocked: '#a16207',
  failed: '#b91c1c',
  todo: '#6b7280',
};

const workerScale = d3
  .scaleOrdinal<string, string>()
  .range(['#0f8b8d', '#c2410c', '#7c3aed', '#b45309', '#0e7490', '#be185d', '#4d7c0f']);

export function agentColor(agent: string | undefined): string {
  if (!agent) return '#6b7280';
  if (agent === 'user') return '#2563eb';
  if (agent === 'orchestrator') return '#4f46e5';
  if (agent.startsWith('worker:')) return workerScale(agent);
  return '#6b7280';
}

/** Status hue for any dataset spelling; unknown statuses render neutral grey. */
export function statusColor(status: string | undefined): string {
  const canonical = canonicalStatus(status);
  return canonical ? STATUS_COLORS[canonical] : '#6b7280';
}

export function stageColor(stage: Stage): string {
  if (stage.startsWith('tool:')) return '#0f766e';
  switch (stage) {
    case 'user': return '#2563eb'; // the stage IS the agent's own action
    case 'reason': return '#4f46e5'; // the orchestrator's thinking
    case 'observe': return '#0369a1';
    case 'respond': return '#047857'; // was #15803d — status green stays canonical
    case 'delegate': return '#c2410c';
    case 'worker': return '#7c3aed';
    case 'wake': return '#b45309';
    default: return '#6b7280';
  }
}

/** Domain-checked dispatch: call sites that hold a spec rather than a known domain. */
export function colorFor(spec: ColorSpec): string {
  switch (spec.domain) {
    case 'agent': return agentColor(spec.value);
    case 'stage': return stageColor(spec.value);
    case 'status': return statusColor(spec.value);
  }
}
