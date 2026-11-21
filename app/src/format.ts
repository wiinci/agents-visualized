import * as d3 from 'd3';
import type { LoopNode, NodeKind } from './types';
import { canonicalStatus, type StatusVocab } from './colors';

export const fmtInt = d3.format(',d');
export const fmtCompact = d3.format('.3~s');
export const fmtChars = (n: number | undefined): string => (n === undefined ? '—' : `${fmtInt(n)} chars`);
export const fmtTokens = (n: number | undefined): string => (n === undefined ? '—' : `≈${fmtInt(n)} tokens (est.)`);
export const fmtTime = (iso: string | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
};

/** Colour vocabulary lives in `./colors` behind a domain-checked union; format.ts keeps text/glyph concerns only. */
export { agentColor, stageColor, statusColor } from './colors';

const STATUS_GLYPHS: Readonly<Record<StatusVocab, string>> = {
  completed: '✓',
  in_progress: '▶',
  blocked: '⏸',
  failed: '✗',
  todo: '○',
};

/** Status glyph for any dataset spelling — same synonym table as statusColor, so glyph and colour agree. */
export function statusGlyph(status: string | undefined): string {
  const canonical = canonicalStatus(status);
  return canonical ? STATUS_GLYPHS[canonical] : '○';
}

export const KIND_LABEL: Record<NodeKind, string> = {
  project: 'project', thread: 'thread', turn: 'turn',
  'user-message': 'user message', reasoning: 'reasoning', text: 'assistant text', 'tool-call': 'tool call', 'tool-result': 'tool result',
  task: 'task', 'worker-thread': 'worker thread', wake: 'wake', phase: 'phase (documented)',
};

/** Kinds whose text is code/JSON — rendered monospace in the info panels' text blocks. */
export function isCodeLike(node: LoopNode): boolean {
  if (node.kind === 'tool-call' || node.kind === 'tool-result') return true;
  const t = node.meta?.fullText ?? node.meta?.excerpt ?? '';
  return /^\s*[[{]/.test(t);
}

export function stageLabel(stage: string): string {
  return stage.startsWith('tool:') ? `tool: ${stage.slice(5)}` : stage;
}

export function nodeAriaLabel(node: LoopNode): string {
  const m = node.meta;
  const bits = [node.name, KIND_LABEL[node.kind] ?? node.kind];
  if (m?.agent) bits.push(m.agent);
  if (m?.chars !== undefined) bits.push(`${fmtInt(m.chars)} characters`);
  if (m?.status) bits.push(`status ${m.status}`);
  return bits.join(', ');
}
