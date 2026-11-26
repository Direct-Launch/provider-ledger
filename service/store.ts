// The ledger store: one JSON file outside the package. A write inside the
// package folder would reload the extension, so it lives in the user's data dir.
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { capStoreSize, emptyStore, pruneStore } from './ledger.ts';
import { defaultSettings, mergeSettings } from './spend.ts';
import { STORE_VERSION } from '../shared/types.ts';
import type { Store } from '../shared/types.ts';

export const defaultStorePath = (): string => (
  process.env.PROVIDER_LEDGER_STORE || join(homedir(), '.local', 'share', 'openchamber-provider-ledger', 'store.json')
);

type StoredShape = Partial<Store> & { version: number; sessions: Store['sessions']; balances: Store['balances'] };

/** Any version this extension has written (1 to now); what a version means is decided in `loadStore`. */
const isStore = (value: unknown): value is StoredShape => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'number' && Number.isInteger(v.version) && v.version >= 1 && v.version <= STORE_VERSION
    && typeof v.sessions === 'object' && v.sessions !== null && typeof v.balances === 'object' && v.balances !== null;
};

/** Caps from a file: only finite numbers above zero under a non-empty id survive. */
const cleanBudgets = (value: unknown): Store['budgets'] => {
  const out: Store['budgets'] = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [provider, cap] of Object.entries(value)) {
    if (provider !== '' && typeof cap === 'number' && Number.isFinite(cap) && cap > 0) out[provider] = cap;
  }
  return out;
};

/** Tool calls from a file: only entries with a marker and a rows object survive; a row with a bad count is dropped. */
const cleanTools = (value: unknown): Store['tools'] => {
  const out: Store['tools'] = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { toolsSynced, rows } = entry as { toolsSynced?: unknown; rows?: unknown };
    if (typeof toolsSynced !== 'number' || !Number.isFinite(toolsSynced) || typeof rows !== 'object' || rows === null || Array.isArray(rows)) continue;
    const clean: Record<string, { calls: number; generated: number; contextChars: number }> = {};
    for (const [key, row] of Object.entries(rows)) {
      const r = row as { calls?: unknown; generated?: unknown; contextChars?: unknown };
      if (typeof r?.calls === 'number' && typeof r.generated === 'number' && typeof r.contextChars === 'number'
        && Number.isFinite(r.calls + r.generated + r.contextChars)) {
        clean[key] = { calls: r.calls, generated: r.generated, contextChars: r.contextChars };
      }
    }
    out[id] = { toolsSynced, rows: clean };
  }
  return out;
};

/** Settings from a file: anything missing or unusable falls back to the shipped default. */
const cleanSettings = (value: unknown): Store['settings'] => {
  const merged = mergeSettings(defaultSettings(), value, false);
  return merged.ok ? merged.settings : defaultSettings();
};

/**
 * Version 4 put the agent into the bucket key (version 3 put the project there), so an older
 * store's buckets cannot be attributed. They are dropped and the sync reads the history again;
 * the balances, the Ollama reading, the caps and any settings are kept. The old file is copied
 * aside once, in case of a rollback.
 */
const migrateStore = async (path: string, old: StoredShape): Promise<Store> => {
  try {
    await copyFile(path, `${path}.v${old.version}-backup`, constants.COPYFILE_EXCL);
  } catch {
    // already backed up, or not writable: the migration does not depend on it
  }
  return {
    ...emptyStore(),
    syncedAt: typeof old.syncedAt === 'number' ? old.syncedAt : null,
    balances: old.balances,
    ollamaUsage: old.ollamaUsage ?? null,
    budgets: cleanBudgets(old.budgets),
    settings: cleanSettings(old.settings),
    rebuilding: true,
  };
};

/** Read the store. A missing file is an empty store; a corrupt one is set aside and replaced. */
export const loadStore = async (path: string, now: number): Promise<Store> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return emptyStore();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isStore(parsed)) {
      if (parsed.version < STORE_VERSION) return await migrateStore(path, parsed);
      const store: Store = { ...emptyStore(), ...parsed, version: STORE_VERSION, tools: cleanTools(parsed.tools), toolsPending: typeof parsed.toolsPending === 'number' ? parsed.toolsPending : 0, budgets: cleanBudgets(parsed.budgets), settings: cleanSettings(parsed.settings) };
      pruneStore(store, now);
      return store;
    }
  } catch {
    // fall through
  }
  try {
    await rename(path, `${path}.corrupt-${now}`);
  } catch {
    // best effort
  }
  return emptyStore();
};

/** Atomic write: temp file in the same folder, mode 0600, then rename. */
export const saveStore = async (path: string, store: Store, now: number): Promise<void> => {
  pruneStore(store, now);
  capStoreSize(store);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
};
