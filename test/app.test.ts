import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guestStatusViewSchema, quotaProviderSchemasV1 } from '@openchamber/sdk/schemas';

import { createService } from '../service/app.ts';
import type { FetchFn, OpenCodeReader } from '../service/opencode.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const TOKEN = 'test-token';

const reader: OpenCodeReader = {
  listSessions: async () => [{ id: 's1', updated: NOW - 1000 }],
  listMessages: async () => [
    { info: { role: 'assistant', providerID: 'deepseek', modelID: 'chat', cost: 0.42, tokens: { input: 1000, output: 400, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 20_000, completed: NOW - 10_000 } }, parts: [] },
  ],
};
const fetchFn: FetchFn = async (url) => (
  url === 'https://api.deepseek.com/user/balance'
    ? new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '9.5' }] }), { status: 200 })
    : new Response('{}', { status: 404 })
);

let server: http.Server;
let base = '';

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-ledger-app-'));
  const service = await createService({ token: TOKEN, storePath: join(dir, 'store.json'), reader, fetchFn, now: () => NOW, autoSync: false });
  server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const call = async (path: string, init: { method?: string; body?: string; auth?: string | null } = {}): Promise<{ status: number; json: any }> => {
  const headers: Record<string, string> = {};
  if (init.auth !== null) headers.Authorization = init.auth ?? `Bearer ${TOKEN}`;
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.body });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const quotaBody = (credentials: Record<string, unknown>): string => JSON.stringify({ v: 1, requestId: 'r1', method: 'usage.read', provider: 'ext-provider-ledger', input: { credentials } });

describe('service routes', () => {
  test('every route, /health included, wants the bearer', async () => {
    expect((await call('/health', { auth: null })).status).toBe(401);
    expect((await call('/panel', { auth: 'Bearer wrong' })).status).toBe(401);
    expect((await call('/health')).json).toEqual({});
  });

  test('unknown routes are 404, wrong methods 405', async () => {
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/sync')).status).toBe(405);
  });

  test('before the first sync: a note row, an empty panel, no invented numbers', async () => {
    const status = await call('/status');
    expect(guestStatusViewSchema.safeParse(status.json).success).toBe(true);
    expect(status.json.rows[0].id).toBe('not-synced');
    const panel = await call('/panel');
    expect(panel.json.syncedAt).toBeNull();
    expect(panel.json.stale).toBe(true);
    expect(panel.json.hasData).toBe(false);
  });

  test('POST /quota before a sync: no spend windows; balances are read and cached', async () => {
    const res = await call('/quota', { method: 'POST', body: quotaBody({ deepseek: { type: 'api', key: 'k' } }) });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(Object.keys(res.json.data.usage.windows)).toEqual(['DeepSeek · balance']);
    expect(quotaProviderSchemasV1.data['usage.read'].safeParse(res.json.data).success).toBe(true);
    const panel = await call('/panel');
    expect(panel.json.balances.map((b: { account: string }) => b.account)).toEqual(['deepseek']);
    expect(panel.json.balances[0].headline).toBe('$9.50');
    expect(panel.json.balancesFetchedAt).toBe(NOW);
  });

  test('a plan seen once is remembered when the next read fails with an expired sign-in', async () => {
    const goOk = { product: 'go', access: { meters: { month: { limitMicroCents: '100', usedMicroCents: '10', resetsAt: '2026-12-01T00:00:00Z' } } } };
    const signIn = (expires: number) => ({ 'opencode-go': { type: 'oauth', access: 'a', refresh: 'r', expires, orgID: 'wrk_ABC1', server: 'https://opencode.ai/console' } });
    const dir = await mkdtemp(join(tmpdir(), 'provider-ledger-plan-'));
    const f: FetchFn = async (url) => (url.endsWith('/go/status') ? new Response(JSON.stringify(goOk), { status: 200 }) : new Response('{}', { status: 404 }));
    const goReader: OpenCodeReader = {
      listSessions: async () => [{ id: 'g1', updated: NOW - 1000 }],
      listMessages: async () => [{ info: { role: 'assistant', providerID: 'opencode-go', modelID: 'glm', cost: 0, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 5000, completed: NOW - 1000 } } }],
    };
    const svc = await createService({ token: TOKEN, storePath: join(dir, 'store.json'), reader: goReader, fetchFn: f, now: () => NOW, autoSync: false });
    await svc.handleSync();
    await svc.handleQuota(quotaBody(signIn(NOW + 60_000)));
    expect(svc.store.balances['opencode-go']?.hadPlan).toBe(true);
    await svc.handleQuota(quotaBody(signIn(NOW - 1)));
    const snap = svc.store.balances['opencode-go'];
    expect(snap).toMatchObject({ ok: false, needsSignIn: true, hadPlan: true });
    expect(snap?.error).toBe('Your OpenCode sign-in has expired — sign in again on OpenCode Console in Providers.');
    expect(svc.panelPayload().balances.find((b) => b.account === 'opencode-go')).toMatchObject({ state: 'signin', note: 'Sign in again' });
    // the spend is still shown as plan-included, not $0.00
    expect(svc.panelPayload().periods.d7.providers[0]).toMatchObject({ provider: 'opencode-go', subscription: true });
  });

  test('a first sync of a long history backfills across batches until nothing is unseen, oldest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provider-ledger-backfill-'));
    const sessions = Array.from({ length: 95 }, (_, i) => ({ id: `h${String(i).padStart(3, '0')}`, updated: Date.UTC(2026, 0, 1) + i * 86_400_000 }));
    const read: string[] = [];
    const longReader: OpenCodeReader = {
      listSessions: async () => sessions,
      listMessages: async (id) => {
        read.push(id);
        const at = sessions.find((s) => s.id === id)!.updated;
        return [{ info: { role: 'assistant', providerID: 'anthropic', modelID: 'm', cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at, completed: at + 2000 } } }];
      },
    };
    const svc = await createService({ token: TOKEN, storePath: join(dir, 'store.json'), reader: longReader, fetchFn, now: () => NOW, autoSync: false });
    const first = await svc.handleSync();
    expect(first).toMatchObject({ sessions: 40, pending: 55 });
    // the chain carries on by itself, 1 s between batches
    for (let i = 0; i < 50 && svc.store.pending > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(svc.store.pending).toBe(0);
    expect(Object.keys(svc.store.sessions)).toHaveLength(95);
    expect(read[0]).toBe('h000');
    expect(read).toEqual([...read].sort());
    expect(svc.panelPayload().firstDate).toBe('2026-01-01');
    expect(svc.panelPayload().periods.all.totals.messages).toBe(95);
  }, 10_000);

  test('a malformed quota body is 400', async () => {
    expect((await call('/quota', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await call('/quota', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  test('POST /sync reads the session and the panel, status and quota then carry real numbers', async () => {
    const sync = await call('/sync', { method: 'POST', body: '{}' });
    expect(sync.json).toMatchObject({ syncedAt: NOW, sessions: 1, pending: 0 });

    const panel = await call('/panel');
    expect(panel.json.hasData).toBe(true);
    expect(panel.json.firstDate).toBe('2026-11-26');
    expect(panel.json.periods.today.totals.cost).toBeCloseTo(0.42, 10);
    expect(panel.json.periods.all.totals.cost).toBeCloseTo(0.42, 10);
    expect(panel.json.periods.d7.providers[0]).toMatchObject({ provider: 'deepseek', name: 'DeepSeek', tokens: 1400, subscription: false });
    expect(panel.json.periods.d7.providers[0].p50).toBe(40);
    expect(panel.json.months).toHaveLength(6);
    expect(panel.json.balances).toHaveLength(1);
    expect(panel.json.balances[0].state).toBe('money');
    expect(panel.json.stale).toBe(false);

    const status = await call('/status');
    expect(guestStatusViewSchema.safeParse(status.json).success).toBe(true);
    expect(status.json.rows.map((r: { id: string }) => r.id)).toEqual(['today', 'week', 'top', 'p-deepseek']);

    const quota = await call('/quota', { method: 'POST', body: quotaBody({}) });
    expect(quota.json.data.usage.windows.today.valueLabel).toBe('$0.42 spent');
    expect(quota.json.ok).toBe(true);
  });

  test('a second sync with nothing changed reads zero sessions', async () => {
    const sync = await call('/sync', { method: 'POST', body: '{}' });
    expect(sync.json.sessions).toBe(0);
  });
});
