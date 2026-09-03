// The DOCUMENTED loop model — encoded verbatim from SCHEMA.md ("The documented loop model").
// Source: Obvious operating instructions. This is NOT observed data; every loop carries provenance: 'documented'.
import type { LoopDef, LoopsDataset } from './types.js';

const DOC = 'Documented model (from Obvious operating instructions), not observed. ';

const loops: LoopDef[] = [
  {
    id: 'turn',
    name: 'Turn loop',
    provenance: 'documented',
    description: DOC + 'One user message and everything the assistant does until its single closing message.',
    phases: [
      { id: 'turn:receive', name: 'receive', description: 'user message', observedKinds: ['user-message'] },
      { id: 'turn:orient', name: 'orient', description: 'search/list existing artifacts, read context', observedKinds: ['tool-call', 'tool-result'] },
      { id: 'turn:plan', name: 'plan', description: 'create/update tasks in the task tree', observedKinds: ['tool-call'] },
      { id: 'turn:act', name: 'act', description: 'tool calls', observedKinds: ['tool-call', 'reasoning'] },
      { id: 'turn:observe', name: 'observe', description: 'tool results; repeat act↔observe', observedKinds: ['tool-result'] },
      { id: 'turn:respond', name: 'respond', description: 'single closing message; earlier text folds into an activity log', observedKinds: ['text'] },
    ],
    edges: [
      { from: 'turn:receive', to: 'turn:orient', kind: 'next' },
      { from: 'turn:orient', to: 'turn:plan', kind: 'next' },
      { from: 'turn:plan', to: 'turn:act', kind: 'next' },
      { from: 'turn:act', to: 'turn:observe', kind: 'next' },
      { from: 'turn:observe', to: 'turn:act', kind: 'repeat', label: 'act↔observe' },
      { from: 'turn:observe', to: 'turn:respond', kind: 'next' },
      { from: 'turn:respond', to: 'turn:receive', kind: 'exit', label: 'closing message' },
    ],
  },
  {
    id: 'delegation',
    name: 'Delegation loop',
    provenance: 'documented',
    description: DOC + 'Orchestrator decomposes work, dispatches workers (each running its own Turn loop in its own thread), sleeps, and is woken by completion notices.',
    phases: [
      { id: 'delegation:decompose', name: 'decompose', description: 'split into self-contained deliverables', observedKinds: ['reasoning'] },
      { id: 'delegation:dispatch', name: 'dispatch', description: 'tasks create + tasks start; worker runs its own Turn loop in its own thread', observedKinds: ['tool-call', 'task', 'worker-thread'] },
      { id: 'delegation:sleep', name: 'sleep', description: 'orchestrator ends turn; never polls', observedKinds: ['text'] },
      { id: 'delegation:wake', name: 'wake', description: 'completion / needs_input / failure notice', observedKinds: ['wake'] },
      { id: 'delegation:review', name: 'review', description: 'read result vs acceptance criteria', observedKinds: ['reasoning', 'tool-call', 'tool-result'] },
      { id: 'delegation:steer', name: 'steer', description: 'send back for rework; repeat', observedKinds: ['tool-call'] },
      { id: 'delegation:close', name: 'close', description: 'tasks update --status=completed', observedKinds: ['tool-call', 'task'] },
      { id: 'delegation:synthesize', name: 'synthesize', description: 'present in own words', observedKinds: ['text'] },
    ],
    edges: [
      { from: 'delegation:decompose', to: 'delegation:dispatch', kind: 'next' },
      { from: 'delegation:dispatch', to: 'delegation:sleep', kind: 'next' },
      { from: 'delegation:sleep', to: 'delegation:wake', kind: 'next' },
      { from: 'delegation:wake', to: 'delegation:review', kind: 'next' },
      { from: 'delegation:review', to: 'delegation:steer', kind: 'repeat', label: 'rework' },
      { from: 'delegation:steer', to: 'delegation:wake', kind: 'repeat', label: 'review→steer→wake' },
      { from: 'delegation:review', to: 'delegation:close', kind: 'next' },
      { from: 'delegation:close', to: 'delegation:synthesize', kind: 'next' },
      { from: 'delegation:synthesize', to: 'delegation:decompose', kind: 'exit' },
    ],
  },
  {
    id: 'skill',
    name: 'Skill loop',
    provenance: 'documented',
    description: DOC + 'Domain-matched skills are loaded, their instructions injected every turn, then unloaded.',
    phases: [
      { id: 'skill:match', name: 'match', description: 'task domain has a skill', observedKinds: ['reasoning'] },
      { id: 'skill:load', name: 'load', description: 'skills load', observedKinds: ['tool-call'] },
      { id: 'skill:follow', name: 'follow', description: 'skill instructions injected every turn', observedKinds: ['reasoning', 'tool-call'] },
      { id: 'skill:unload', name: 'unload', description: 'skills unload', observedKinds: ['tool-call'] },
    ],
    edges: [
      { from: 'skill:match', to: 'skill:load', kind: 'next' },
      { from: 'skill:load', to: 'skill:follow', kind: 'next' },
      { from: 'skill:follow', to: 'skill:unload', kind: 'next' },
      { from: 'skill:unload', to: 'skill:match', kind: 'exit' },
    ],
  },
  {
    id: 'memory',
    name: 'Memory loop',
    provenance: 'documented',
    description: DOC + 'After each turn, facts and summaries are auto-extracted, stored, and injected as Active Memory into the next turn.',
    phases: [
      { id: 'memory:extract', name: 'extract', description: 'after each turn: facts + summaries auto-extracted', observedKinds: [] },
      { id: 'memory:store', name: 'store', description: 'persist facts (memory list / search)', observedKinds: [] },
      { id: 'memory:inject', name: 'inject', description: 'Active Memory in next turn\u2019s context', observedKinds: [] },
      { id: 'memory:use', name: 'use', description: 'agent reasons with injected memory', observedKinds: ['reasoning'] },
    ],
    edges: [
      { from: 'memory:extract', to: 'memory:store', kind: 'next' },
      { from: 'memory:store', to: 'memory:inject', kind: 'next' },
      { from: 'memory:inject', to: 'memory:use', kind: 'next' },
      { from: 'memory:use', to: 'memory:extract', kind: 'repeat', label: 'use→extract' },
    ],
  },
  {
    id: 'human',
    name: 'Human-in-the-loop',
    provenance: 'documented',
    description: DOC + 'Gated actions and questions pause the agent until a human decides.',
    phases: [
      { id: 'human:gate', name: 'gate', description: 'propose-plan / ask-user / confirmation-gated \u{1F512} action', observedKinds: ['tool-call'] },
      { id: 'human:notify', name: 'notify', description: 'user is notified of the pending decision', observedKinds: [] },
      { id: 'human:decide', name: 'decide', description: 'approve / edit / reject', observedKinds: ['user-message'] },
      { id: 'human:wake', name: 'wake', description: 'agent woken with the decision', observedKinds: ['wake'] },
      { id: 'human:continue', name: 'continue', description: 'agent resumes work', observedKinds: ['reasoning', 'tool-call'] },
    ],
    edges: [
      { from: 'human:gate', to: 'human:notify', kind: 'next' },
      { from: 'human:notify', to: 'human:decide', kind: 'next' },
      { from: 'human:decide', to: 'human:wake', kind: 'next' },
      { from: 'human:wake', to: 'human:continue', kind: 'next' },
      { from: 'human:continue', to: 'human:gate', kind: 'exit' },
    ],
  },
];

export const loopModel: LoopsDataset['loopModel'] = { provenance: 'documented', loops };
