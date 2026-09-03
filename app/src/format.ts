import * as d3 from 'd3';
import type { LoopNode, NodeKind } from './types';

export const fmtInt = d3.format(',d');
export const fmtCompact = d3.format('.3~s');
export const fmtChars = (n: number | undefined): string => (n === undefined ? '—' : `${fmtInt(n)} chars`);
export const fmtTokens = (n: number | undefined): string => (n === undefined ? '—' : `≈${fmtInt(n)} tokens (est.)`);
export const fmtTime = (iso: string | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
};

/** Agent colour: user / orchestrator fixed, worker:* from a categorical ramp. Colours chosen for ≥3:1 against both page backgrounds. */
const workerScale = d3.scaleOrdinal<string, string>().range(['#0f8b8d', '#c2410c', '#7c3aed', '#b45309', '#0e7490', '#be185d', '#4d7c0f']);
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
    case 'in_progress': case 'running': case 'active': return '#2563eb';
    case 'blocked': case 'waiting': case 'needs_input': return '#b45309';
    case 'failed': case 'error': case 'cancelled': return '#b91c1c';
    case 'todo': case 'pending': return '#6b7280';
    default: return '#6b7280';
  }
}

/** Text-based status marker so colour is never the only indicator. */
export function statusGlyph(status: string | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'completed': case 'done': case 'success': return '✓';
    case 'in_progress': case 'running': case 'active': return '▶';
    case 'blocked': case 'waiting': case 'needs_input': return '⏸';
    case 'failed': case 'error': case 'cancelled': return '✗';
    default: return '○';
  }
}

export const KIND_LABEL: Record<NodeKind, string> = {
  project: 'project', thread: 'thread', turn: 'turn',
  'user-message': 'user message', reasoning: 'reasoning', text: 'assistant text', 'tool-call': 'tool call', 'tool-result': 'tool result',
  task: 'task', 'worker-thread': 'worker thread', wake: 'wake', phase: 'phase (documented)',
};

/** Kinds whose text is code/JSON — rendered monospace in tooltips. */
export function isCodeLike(node: LoopNode): boolean {
  if (node.kind === 'tool-call' || node.kind === 'tool-result') return true;
  const t = node.meta?.fullText ?? node.meta?.excerpt ?? '';
  return /^\s*[[{]/.test(t);
}

export function stageLabel(stage: string): string {
  return stage.startsWith('tool:') ? `tool: ${stage.slice(5)}` : stage;
}

export function stageColor(stage: string): string {
  if (stage.startsWith('tool:')) return '#0f766e';
  switch (stage) {
    case 'user': return '#2563eb';
    case 'reason': return '#4f46e5';
    case 'observe': return '#0369a1';
    case 'respond': return '#15803d';
    case 'delegate': return '#c2410c';
    case 'worker': return '#7c3aed';
    case 'wake': return '#b45309';
    default: return '#6b7280';
  }
}

/** Short accessible name for an SVG node (screen readers get the tooltip as description). */
export function nodeAriaLabel(node: LoopNode): string {
  const m = node.meta;
  const bits = [node.name, KIND_LABEL[node.kind] ?? node.kind];
  if (m?.agent) bits.push(m.agent);
  if (m?.chars !== undefined) bits.push(`${fmtInt(m.chars)} characters`);
  if (m?.status) bits.push(`status ${m.status}`);
  return bits.join(', ');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
