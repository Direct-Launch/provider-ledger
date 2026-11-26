import { describe, expect, test } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createService } from '../service/app.ts';
import { deriveLedger } from '../service/ledger.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { loadStore, saveStore } from '../service/store.ts';
import { defaultSettings } from '../service/spend.ts';
import { msg, scratch } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

const v1Store = () => ({
  version: 1,
  watermark: 123,
  syncedAt: NOW - 5000,
  lastError: null,
  pending: 0,
  sessions: {
    s1: { updated: 100, buckets: { '2026-11-26|anthropic|claude': { messages: 3, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 4, samples: [], p50: null, p90: null } } },
  },
  balances: { anthropic: { provider: 'anthropic', fetchedAt: NOW - 1000, ok: true, configured: true, windows: {} } },
  ollamaUsage: { fetchedAt: NOW - 1000, range: '7d', models: [] },
});

describe('store version 4 migration', () => {
  test('a version 1 store drops its sessions, keeps balances and Ollama usage, and is marked as re-reading', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify(v1Store()));
    const store = await loadStore(path, NOW);
    expect(store.version).toBe(4);
    expect(store.sessions).toEqual({});
    expect(store.watermark).toBe(0);
    expect(store.rebuilding).toBe(true);
    expect(store.balances.anthropic?.ok).toBe(true);
    expect(store.ollamaUsage?.range).toBe('7d');
    expect(store.budgets).toEqual({});
    expect(deriveLedger(store, NOW).hasData).toBe(false);
    // The old file is copied aside once.
    expect((await readdir(dir)).sort()).toEqual(['store.json', 'store.json.v1-backup']);
    expect(JSON.parse(await readFile(join(dir, 'store.json.v1-backup'), 'utf8')).version).toBe(1);
  });

  test('a version 2 store migrates the same way and keeps its caps', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify({ ...v1Store(), version: 2, budgets: { anthropic: 25, bad: -1, worse: 'x', ollama: 10 } }));
    const store = await loadStore(path, NOW);
    expect(store.version).toBe(4);
    expect(store.sessions).toEqual({});
    expect(store.budgets).toEqual({ anthropic: 25, ollama: 10 });
  });

  test('a version 3 store is re-read too, because its bucket keys carry no agent', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify({ ...v1Store(), version: 3, sessions: { s1: { updated: 1, project: 'X', buckets: {} } }, budgets: { a: 5, b: 0, c: 'x', d: null } }));
    const store = await loadStore(path, NOW);
    expect(store.sessions).toEqual({});
    expect(store.rebuilding).toBe(true);
    expect(store.budgets).toEqual({ a: 5 });
    expect(store.settings).toEqual(defaultSettings());
    expect((await readdir(dir)).sort()).toEqual(['store.json', 'store.json.v3-backup']);
  });

  test('a version 4 store loads as it is, with its settings, and a bad value in the file falls back to the default', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify({
      ...v1Store(),
      version: 4,
      sessions: { s1: { updated: 1, project: 'X', buckets: {} } },
      budgets: { a: 5, b: 0, c: 'x', d: null },
      settings: { roots: ['/work/customers/', 'relative/path'], codingAgents: ['build', 'code'], localProviders: 'ollama' },
    }));
    const store = await loadStore(path, NOW);
    expect(Object.keys(store.sessions)).toEqual(['s1']);
    expect(store.rebuilding).toBeUndefined();
    expect(store.budgets).toEqual({ a: 5 });
    // one bad list does not discard the good ones, and each bad one keeps its default
    expect(store.settings.roots).toEqual([]);
    expect(store.settings.codingAgents).toEqual(['build', 'code']);
    expect(store.settings.localProviders).toEqual(defaultSettings().localProviders);
    expect((await readdir(dir)).sort()).toEqual(['store.json']);
  });

  test('a store with no settings key gets the defaults', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify({ ...v1Store(), version: 4, sessions: {} }));
    expect((await loadStore(path, NOW)).settings).toEqual(defaultSettings());
  });

  test('settings survive a save and a reload, and a migration keeps the ones a store already had', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    const store = await loadStore(path, NOW);
    store.settings.roots = ['/work/customers'];
    store.settings.utilityModels = ['*/tiny'];
    await saveStore(path, store, NOW);
    expect((await loadStore(path, NOW)).settings).toMatchObject({ roots: ['/work/customers'], utilityModels: ['*/tiny'] });

    const old = join(dir, 'old.json');
    await writeFile(old, JSON.stringify({ ...v1Store(), version: 3, settings: { roots: ['/work/customers'] } }));
    const migrated = await loadStore(old, NOW);
    expect(migrated.rebuilding).toBe(true);
    expect(migrated.settings.roots).toEqual(['/work/customers']);
  });

  test('a store written by a newer version is set aside, not read', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify({ ...v1Store(), version: 9 }));
    const store = await loadStore(path, NOW);
    expect(store.sessions).toEqual({});
    expect(store.rebuilding).toBeUndefined();
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  test('budgets survive a save and a reload', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    const store = await loadStore(path, NOW);
    store.budgets.anthropic = 40;
    await saveStore(path, store, NOW);
    expect((await loadStore(path, NOW)).budgets).toEqual({ anthropic: 40 });
  });
});

describe('the rebuild, end to end', () => {
  test('the panel says it is re-reading while pending, and stops once a clean run leaves nothing', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify(v1Store()));
    const refs = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, updated: 100 + i, directory: `/work/customers/C${i % 2}` }));
    const reader: OpenCodeReader = { listSessions: async () => refs, listMessages: async () => [msg(NOW - 1000, 'anthropic', 'claude', 1)] };
    const service = await createService({ token: 't', storePath: path, reader, now: () => NOW, autoSync: false, homeDir: dir });
    service.store.settings.roots = ['/work/customers'];

    expect(service.panelPayload()).toMatchObject({ rebuilding: true, hasData: false, sessionsTracked: 0 });

    // Batches of 40 are the default; force a small one through the runBatch path by listing more than 40.
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, updated: 100 + i, directory: null }));
    const big: OpenCodeReader = { listSessions: async () => many, listMessages: async () => [msg(NOW - 1000, 'anthropic', 'claude', 1)] };
    const svc2 = await createService({ token: 't', storePath: join(dir, 'store2.json'), reader: big, now: () => NOW, autoSync: false, homeDir: dir });
    svc2.store.rebuilding = true;
    await svc2.runBatch();
    expect(svc2.panelPayload()).toMatchObject({ rebuilding: true, pending: 5, hasData: true });
    await svc2.runBatch();
    expect(svc2.panelPayload()).toMatchObject({ rebuilding: false, pending: 0 });
    expect(svc2.store.rebuilding).toBeUndefined();

    await service.runBatch();
    const panel = service.panelPayload();
    expect(panel).toMatchObject({ rebuilding: false, pending: 0, sessionsTracked: 5, hasData: true });
    expect(panel.periods.all.projects.map((p) => p.project).sort()).toEqual(['C0', 'C1']);
  });

  test('a failed run keeps the flag', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await writeFile(path, JSON.stringify(v1Store()));
    const reader: OpenCodeReader = { listSessions: async () => { throw new Error('down'); }, listMessages: async () => [] };
    const service = await createService({ token: 't', storePath: path, reader, now: () => NOW, autoSync: false, homeDir: dir });
    await service.runBatch();
    expect(service.panelPayload().rebuilding).toBe(true);
  });
});
