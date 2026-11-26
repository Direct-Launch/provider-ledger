import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyStore } from '../service/ledger.ts';
import type { SessionRef } from '../service/ledger.ts';
import { applySession } from '../service/ledger.ts';
import type { LedgerSettings, Store } from '../shared/types.ts';

export const scratch = (prefix = 'provider-ledger-test-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));

/** An assistant message at `created` (epoch ms) with the given cost. */
export const msg = (created: number, provider: string, model: string, cost: number, extra: { output?: number; seconds?: number } = {}): unknown => ({
  info: {
    role: 'assistant',
    providerID: provider,
    modelID: model,
    cost,
    tokens: { input: 1000, output: extra.output ?? 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, completed: created + (extra.seconds ?? 10) * 1000 },
  },
  parts: [],
});

/** A message that switches the agent in force from `created` (epoch ms) on. */
export const switchTo = (created: number, agent: string): unknown => ({
  info: { type: 'agent-switched', agent, time: { created } },
});

/** A folder of customer projects, used as a workspace root in the tests. */
export const ROOT = '/work/customers';

/** A store with one session per entry: its directory, its own agent and its messages. */
export const storeOf = (
  sessions: Array<{ id: string; directory?: string | null; agent?: string | null; messages: unknown[] }>,
  settings: Partial<LedgerSettings> = {},
): Store => {
  const store = emptyStore();
  store.settings = { ...store.settings, ...settings };
  sessions.forEach((s, i) => {
    const ref: SessionRef = { id: s.id, updated: 1000 + i, directory: s.directory ?? null, agent: s.agent ?? null };
    applySession(store, ref, s.messages);
  });
  return store;
};
