// Mirrors /home/user/work/agents-visualized/SCHEMA.md exactly. Do not add fields
// here without updating SCHEMA.md (owned by the lead).

export type NodeKind =
  | 'project' | 'thread' | 'turn'
  | 'user-message' | 'reasoning' | 'text' | 'tool-call' | 'tool-result'
  | 'task' | 'worker-thread' | 'wake'
  | 'phase';

export interface LoopNodeMeta {
  role?: string; toolName?: string; toolCallId?: string; summary?: string;
  createdAt?: string; durationMs?: number; status?: string; assignee?: string;
  isError?: boolean;
  chars: number;
  tokensEst: number;
  contextChars?: number;
  contextTokensEst?: number;
  promptChars?: number;
  agent: string;
  threadId?: string; turnIndex?: number; stepIndex?: number; messageId?: string;
  excerpt?: string;
  fullText?: string;
  truncated?: boolean;
  [k: string]: unknown;
}

export interface LoopNode {
  id: string;
  name: string;
  kind: NodeKind;
  value: number;
  meta?: LoopNodeMeta;
  children?: LoopNode[];
}

export type Stage = 'user' | 'reason' | `tool:${string}` | 'observe' | 'delegate' | 'worker' | 'wake' | 'respond';

export interface FlowNode { id: string; name: string; stage: Stage; kind: NodeKind; count: number }
export interface FlowLink { source: string; target: string; value: number; kind: 'sequence' | 'delegation' | 'wake' | 'tool' }

export interface TurnStat {
  threadId: string; turnIndex: number; agent: string; startedAt: string; endedAt?: string;
  steps: number; toolCalls: number; chars: number; tokensEst: number; contextCharsAtEnd: number; userPromptChars: number;
}
export interface AgentStat { agent: string; threads: number; turns: number; toolCalls: number; chars: number; tokensEst: number }
export interface ToolStat { toolName: string; calls: number; promptChars: number; resultChars: number; errors: number }

export interface LoopPhase { id: string; name: string; description: string; observedKinds: NodeKind[] }
export interface LoopEdge { from: string; to: string; label?: string; kind: 'next' | 'repeat' | 'exit' }
export interface LoopModelLoop { id: string; name: string; description: string; phases: LoopPhase[]; edges: LoopEdge[] }

export interface LoopsDataset {
  version: 1;
  generatedAt: string;
  source: { projectId: string; threadIds: string[]; messageCount: number; storage: string };
  hierarchy: LoopNode;
  stats: { turns: TurnStat[]; agents: AgentStat[]; tools: ToolStat[] };
  flows: { nodes: FlowNode[]; links: FlowLink[] };
  delegation: LoopNode;
  loopModel: { loops: LoopModelLoop[] };
}

/** What the app actually loaded and from where. */
export interface LoadedDataset {
  data: LoopsDataset;
  url: string;
  isFixture: boolean;
  loadNote: string;
}
