import * as d3 from 'd3';
import type { Stage } from './types';

/**
 * Single source of colour semantics. Every palette is addressed through
 * `ColorSpec`, a discriminated union: a call must name its domain, and the
 * value is typed per domain (stage values must be a `Stage`, not a bare
 * string), so a wrong vocabulary or a non-colourable literal fails `tsc`
 * instead of silently rendering grey.
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
 * - Status glyphs (✓ ▶ ⏸ ✗ ○) remain in format.ts, so colour is never the
 *   only indicator.
 */

type AgentName = 'user' | 'orchestrator' | (string & {});
type StatusKey = 'completed' | 'in_progress' | 'blocked' | 'failed' | 'todo' | (string & {});

export type ColorSpec =
  | { domain: 'agent'; value: AgentName }
  | { domain: 'stage'; value: Stage }
  | { domain: 'status'; value: StatusKey };

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

export function statusColor(status: string | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'completed': case 'done': case 'success': return '#15803d';
    case 'in_progress': case 'running': case 'active': return '#0284c7';
    case 'blocked': case 'waiting': case 'needs_input': return '#a16207';
    case 'failed': case 'error': case 'cancelled': return '#b91c1c';
    case 'todo': case 'pending': return '#6b7280';
    default: return '#6b7280';
  }
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
