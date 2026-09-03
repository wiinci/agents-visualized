// Entry point: `npm run extract` (== `npx tsx pipeline/extract.ts` from the agents-visualized root).
// Reads every thread/message/task/memory fact in the current project via the Obvious SDK and writes
// ../data/loops.json per ../SCHEMA.md. Idempotent: re-running overwrites the file with a fresh snapshot.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTask, listAllMessages, listAllTasks, listAllThreads, listMemoryFacts, loadSdk } from './sdk.js';
import { normalize, type ThreadInput } from './normalize.js';
import { validateDataset } from './validate.js';
import type { RawTask } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'data', 'loops.json');

async function main(): Promise<void> {
  const projectId = process.env.PROJECT_ID;
  if (!projectId) throw new Error('PROJECT_ID is not set — run on the project sandbox where the Obvious SDK is configured.');
  const sdk = loadSdk();

  const threads = await listAllThreads(sdk);
  threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.error(`[extract] ${threads.length} threads`);

  const threadInputs: ThreadInput[] = [];
  for (const thread of threads) {
    const messages = await listAllMessages(sdk, thread.id);
    console.error(`[extract]   ${thread.id} ${thread.parentThreadId ? '(worker)' : '(root)'} ${messages.length} messages — ${thread.name ?? ''}`);
    threadInputs.push({ thread, messages });
  }

  // tasks.list already returns the full record; tasks.get is called per task to pick up any field
  // (e.g. completionNote) that list may omit or that changed since. Falls back to the list record.
  const listed = await listAllTasks(sdk);
  const tasks: RawTask[] = [];
  for (const t of listed) tasks.push((await getTask(sdk, t.id)) ?? t);
  tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.error(`[extract] ${tasks.length} tasks`);

  const memory = await listMemoryFacts(sdk);
  console.error(`[extract] ${memory.length} memory facts`);

  let projectName: string | undefined;
  try {
    const p = await (sdk as unknown as { projects?: { get?: (x: Record<string, never>) => Promise<{ name?: string }> } }).projects?.get?.({});
    projectName = p?.name;
  } catch { /* optional */ }

  const { dataset, report } = normalize({ projectId, projectName, threads: threadInputs, tasks, memory });

  const problems = validateDataset(dataset);
  if (problems.length) {
    console.error('[extract] validation FAILED:\n  ' + problems.join('\n  '));
    process.exitCode = 1;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(dataset, null, 2) + '\n');

  console.error(`[extract] wrote ${OUT}`);
  console.log(JSON.stringify({ out: OUT, ...report, valid: problems.length === 0 }, null, 2));
}

main().catch((err: unknown) => {
  const e = err as { code?: string; message?: string };
  console.error('[extract] failed:', e.code ?? '', e.message ?? String(err));
  process.exit(1);
});
