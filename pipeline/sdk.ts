// Thin, fully-paging wrapper around `require('obvious').sdk`.
// The SDK is preinstalled on the project sandbox (resolvable via NODE_PATH); no npm dependency.
import { createRequire } from 'node:module';
import type { Page, RawMemoryFact, RawMessage, RawTask, RawThread } from './types.js';

interface ObviousSdk {
  configure?: (opts: { tokenRefresh: () => Promise<string | undefined> }) => void;
  threads: {
    list: (p: Record<string, unknown>) => Promise<Page<RawThread>>;
    listMessages: (p: { threadId: string; limit?: number; offset?: number }) => Promise<Page<RawMessage>>;
  };
  tasks: {
    list: (p: Record<string, unknown>) => Promise<Page<RawTask>>;
    get: (p: { taskId: string }) => Promise<RawTask>;
  };
  memory: {
    list: (p: Record<string, unknown>) => Promise<{ facts?: RawMemoryFact[]; [k: string]: unknown }>;
  };
}

const nodeRequire = createRequire(import.meta.url);

export function loadSdk(): ObviousSdk {
  const mod = nodeRequire('obvious') as { sdk: ObviousSdk };
  // API_TOKEN has a 5-minute TTL; re-read from env on every call.
  mod.sdk.configure?.({ tokenRefresh: async () => process.env.API_TOKEN });
  return mod.sdk;
}

const PAGE = 100;

async function pageAll<T>(fetch: (offset: number) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await fetch(offset);
    const items = page.items ?? [];
    out.push(...items);
    const more = page.pagination?.hasMore ?? (items.length === PAGE);
    if (!more || items.length === 0) break;
    offset += items.length;
  }
  return out;
}

export async function listAllThreads(sdk: ObviousSdk): Promise<RawThread[]> {
  return pageAll((offset) => sdk.threads.list({ limit: PAGE, offset }));
}

export async function listAllMessages(sdk: ObviousSdk, threadId: string): Promise<RawMessage[]> {
  return pageAll((offset) => sdk.threads.listMessages({ threadId, limit: PAGE, offset }));
}

export async function listAllTasks(sdk: ObviousSdk): Promise<RawTask[]> {
  return pageAll((offset) => sdk.tasks.list({ limit: PAGE, offset }));
}

export async function getTask(sdk: ObviousSdk, taskId: string): Promise<RawTask | null> {
  try { return await sdk.tasks.get({ taskId }); } catch { return null; }
}

export async function listMemoryFacts(sdk: ObviousSdk): Promise<RawMemoryFact[]> {
  // memory.list takes no paging params (VALIDATION_FAILED on `limit`); optional --category filter only.
  try {
    const res = await sdk.memory.list({});
    return Array.isArray(res.facts) ? res.facts : [];
  } catch { return []; }
}
