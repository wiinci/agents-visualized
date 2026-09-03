// Mirror of the contract in ../SCHEMA.md. Do not change field names here without updating SCHEMA.md.

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

export type Stage =
  | 'user' | 'reason' | `tool:${string}` | 'observe' | 'delegate' | 'worker' | 'wake' | 'respond';

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
export interface LoopDef { id: string; name: string; description: string; phases: LoopPhase[]; edges: LoopEdge[]; provenance: 'documented' }

export interface LoopsDataset {
  version: 1;
  generatedAt: string;
  source: {
    projectId: string;
    threadIds: string[];
    messageCount: number;
    storage: string;
  };
  hierarchy: LoopNode;
  stats: { turns: TurnStat[]; agents: AgentStat[]; tools: ToolStat[] };
  flows: { nodes: FlowNode[]; links: FlowLink[] };
  delegation: LoopNode;
  loopModel: { provenance: 'documented'; loops: LoopDef[] };
}

// ---- Raw SDK shapes (as observed 2026-09-03 via `require('obvious').sdk`) ----

export interface RawThread {
  id: string; name: string | null; description: string | null; projectId: string;
  source: string | null; type: string | null; agentStatus: string | null;
  createdAt: string; updatedAt: string; archivedAt: string | null; parentThreadId: string | null;
  [k: string]: unknown;
}

export interface RawPart { type?: string; [k: string]: unknown }

export interface RawMessage {
  id: string; threadId: string; role: string; type: string | null;
  content: RawPart[] | RawPart | string | null;
  createdAt: string; updatedAt: string;
  [k: string]: unknown;
}

export interface RawTaskAssignee { id: string; type: string; userId: string | null; agentId: string | null; displayName: string | null; [k: string]: unknown }
export interface RawTask {
  id: string; title: string; description: string | null; status: string; priority: string | null;
  source: string | null; completionNote: string | null; completedAt: string | null;
  createdAt: string; updatedAt: string; parentId: string | null; assignees?: RawTaskAssignee[];
  [k: string]: unknown;
}

export interface RawMemoryFact { id: string; category: string; entityKey?: string | null; content: string; source?: string; [k: string]: unknown }

export interface Page<T> { items: T[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }
