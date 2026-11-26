import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';

import { createService } from '../service/app.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { CSV_HEADER } from '../service/export.ts';
import { loadStore } from '../service/store.ts';
import { ROOT, msg, scratch } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const TOKEN = 'tok';

const reader: OpenCodeReader = {
  listSessions: async () => [
    { id: 'a', updated: 10, directory: `${ROOT}/Acme & Co/site` },
    { id: 'b', updated: 11, directory: '/home/user/tools' },
    { id: 'c', updated: 12 },
  ],
  listMessages: async (id) => [msg(NOW - 1000, 'anthropic', 'claude', id === 'a' ? 8.9 : id === 'b' ? 1 : 0.1)],
};

let server: http.Server;
let base = '';
let storePath = '';
let home = '';
let service: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const dir = await scratch('provider-ledger-routes-');
  storePath = join(dir, 'store.json');
  home = join(dir, 'home');
  await mkdir(join(home, 'Downloads'), { recursive: true });
  service = await createService({ token: TOKEN, storePath, reader, now: () => NOW, autoSync: false, homeDir: home });
  service.store.settings.roots = [ROOT];
  await service.runBatch();
  server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const call = async (path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

describe('/panel carries the clients and the budgets', () => {
  test('the Clients view data: three keys, the Unattributed one named, shares add to 100', async () => {
    const { json } = await call('/panel');
    const d30 = json.periods.d30;
    expect(d30.projects.map((p: { project: string }) => p.project)).toEqual(['Acme & Co', 'tools', 'Unattributed']);
    expect(d30.unattributed.cost).toBeCloseTo(0.1, 9);
    expect(d30.projects.reduce((a: number, p: { share: number }) => a + p.share, 0)).toBeCloseTo(100, 9);
    expect(json.rebuilding).toBe(false);
    expect(json.overCap).toBe(0);
  });
});

describe('POST /budgets', () => {
  test('sets a cap, survives a reload, shows in /panel and /status as a warning row', async () => {
    const set = await call('/budgets', 'POST', { provider: 'anthropic', capUsd: 11 }); // 10.0 / 11 = 90.9 %
    expect(set.json).toEqual({ ok: true, capUsd: 11 });
    expect((await loadStore(storePath, NOW)).budgets).toEqual({ anthropic: 11 });
    const panel = (await call('/panel')).json;
    expect(panel.budgets[0]).toMatchObject({ provider: 'anthropic', capUsd: 11, state: 'warning' });
    expect(panel.overCap).toBe(0);
    const status = (await call('/status')).json;
    expect(guestStatusViewSchema.safeParse(status).success).toBe(true);
    expect(status.rows[0]).toMatchObject({ id: 'cap-p-anthropic', dot: 'warning' });
  });

  test('10.02 of 10 is an error row and a badge of 1', async () => {
    // $10.00 spent; a cap of 9.98 is over by 2 cents.
    await call('/budgets', 'POST', { provider: 'anthropic', capUsd: 9.98 });
    const panel = (await call('/panel')).json;
    expect(panel.budgets[0].state).toBe('error');
    expect(panel.overCap).toBe(1);
    expect((await call('/status')).json.rows[0]).toMatchObject({ id: 'cap-p-anthropic', dot: 'error' });
  });

  test('refuses zero, negative, NaN (absent), strings and nonsense bodies; the stored cap is unchanged', async () => {
    for (const body of [{ provider: 'anthropic', capUsd: 0 }, { provider: 'anthropic', capUsd: -3 }, { provider: 'anthropic' }, { provider: 'anthropic', capUsd: '10' }, { capUsd: 5 }, 'not json', '[]']) {
      const r = await call('/budgets', 'POST', body);
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(false);
      expect(typeof r.json.error).toBe('string');
    }
    expect((await loadStore(storePath, NOW)).budgets).toEqual({ anthropic: 9.98 });
  });

  test('null clears the cap and its status row goes', async () => {
    expect((await call('/budgets', 'POST', { provider: 'anthropic', capUsd: null })).json).toEqual({ ok: true, capUsd: null });
    expect((await call('/panel')).json.budgets.every((b: { capUsd: number | null }) => b.capUsd === null)).toBe(true);
    expect((await call('/status')).json.rows.some((r: { id: string }) => r.id.startsWith('cap-'))).toBe(false);
  });

  test('GET is 405', async () => {
    expect((await call('/budgets')).status).toBe(405);
    expect((await call('/export')).status).toBe(405);
  });
});

describe('POST /export', () => {
  test('writes the csv and answers its path', async () => {
    const { json } = await call('/export', 'POST', {});
    expect(json).toEqual({ ok: true, path: join(home, 'Downloads', 'provider-ledger-2026-11-26.csv'), rows: 3, fellBack: false });
    const text = await readFile(json.path, 'utf8');
    expect(text.split('\n')[0]).toBe(CSV_HEADER);
    expect(text).toContain('2026-11-26,anthropic,claude,Acme & Co,uncategorised,cloud,1,1000,100,0,0,0,8.9');
    expect(text).toContain(',Unattributed,');
  });
});
