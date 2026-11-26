import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { createService } from '../service/app.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { defaultSettings } from '../service/spend.ts';
import { loadStore } from '../service/store.ts';
import { PERIOD_IDS } from '../shared/types.ts';
import { ROOT, msg, scratch, switchTo } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const TOKEN = 'tok';

const reader: OpenCodeReader = {
  listSessions: async () => [
    { id: 'a', updated: 10, directory: `${ROOT}/Acme/site/src`, agent: 'build' },
    { id: 'b', updated: 11, directory: `${ROOT}/Acme/site/docs`, agent: 'plan' },
    { id: 'c', updated: 12, directory: '/home/user/.config/openchamber/chats/2026-11-26/session-1' },
  ],
  listMessages: async (id) => (id === 'c'
    ? [switchTo(NOW - 5000, 'build'), msg(NOW - 1000, 'ollama', 'llama3:8b', 0), switchTo(NOW - 900, 'plan'), msg(NOW - 800, 'ollama', 'deepseek-v4.1-flash:cloud', 1)]
    : [msg(NOW - 1000, 'anthropic', 'claude', id === 'a' ? 3 : 1)]),
};

let server: http.Server;
let base = '';
let storePath = '';
let service: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const dir = await scratch('provider-ledger-settings-');
  storePath = join(dir, 'store.json');
  service = await createService({ token: TOKEN, storePath, reader, now: () => NOW, autoSync: false, homeDir: dir });
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

describe('a first run with no settings at all', () => {
  test('spend shows at once, projects are folder names, and the chat folders are one key', async () => {
    const { json } = await call('/panel');
    expect(json.hasData).toBe(true);
    expect(json.settings).toEqual(defaultSettings());
    expect(json.defaults).toEqual(defaultSettings());
    expect(json.collapsedProjects).toEqual([]);
    const all = json.periods.d30;
    expect(all.totals.cost).toBe(5);
    expect(all.projects.map((p: { project: string }) => p.project).sort()).toEqual(['Chats', 'docs', 'src']);
    expect(PERIOD_IDS.every((id) => json.periods[id].types !== undefined)).toBe(true);
  });

  test('types need no setting either: build is coding, plan is agentic, ollama is local, :cloud is cloud', async () => {
    const types = (await call('/panel')).json.periods.d30.types;
    const by = Object.fromEntries(types.categories.map((c: { category: string; messages: number }) => [c.category, c.messages]));
    // a: build, claude (coding). b: plan, claude (agentic). c: llama3 under build (coding), the cloud model under plan (agentic).
    expect(by).toEqual({ coding: 2, agentic: 2 });
    expect(types.local.messages).toBe(1);
    expect(types.cloud.cost).toBe(5);
  });

  test('GET /settings is 405 and needs the token', async () => {
    expect((await call('/settings')).status).toBe(405);
    expect((await fetch(`${base}/settings`, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('POST /settings', () => {
  test('a workspace root re-keys the projects at once and survives a reload', async () => {
    const set = await call('/settings', 'POST', { settings: { roots: [`${ROOT}/`] } });
    expect(set.json).toEqual({ ok: true, settings: { ...defaultSettings(), roots: [ROOT] } });
    const panel = (await call('/panel')).json;
    expect(panel.periods.d30.projects.map((p: { project: string }) => p.project).sort()).toEqual(['Acme', 'Chats']);
    expect(panel.periods.d30.projects.find((p: { project: string }) => p.project === 'Acme').cost).toBe(4);
    expect((await loadStore(storePath, NOW)).settings.roots).toEqual([ROOT]);
  });

  test('a rule change re-sorts the history without reading anything', async () => {
    await call('/settings', 'POST', { settings: { codingAgents: ['build', 'plan'] } });
    const types = (await call('/panel')).json.periods.d30.types;
    expect(types.categories.map((c: { category: string; messages: number }) => [c.category, c.messages])).toEqual([['coding', 4]]);
    await call('/settings', 'POST', { settings: { localProviders: [] } });
    const after = (await call('/panel')).json.periods.d30.types;
    expect(after.local.messages).toBe(0);
    expect(after.cloud.messages).toBe(4);
  });

  test('reset restores the rules and keeps the roots', async () => {
    const reset = await call('/settings', 'POST', { reset: true });
    expect(reset.json).toEqual({ ok: true, settings: { ...defaultSettings(), roots: [ROOT] } });
  });

  test('a refused request says why and changes nothing', async () => {
    for (const body of [{ settings: { roots: ['relative'] } }, { settings: { roots: 'x' } }, { settings: 'x' }, 'not json']) {
      const r = await call('/settings', 'POST', body);
      expect(r.json.ok).toBe(false);
      expect(typeof r.json.error).toBe('string');
    }
    expect((await call('/panel')).json.settings.roots).toEqual([ROOT]);
  });

  test('merging a folder into its parent is a setting, listed so it can be restored', async () => {
    await call('/settings', 'POST', { settings: { roots: [], collapsed: ['src', 'docs'] } });
    const panel = (await call('/panel')).json;
    expect(panel.collapsedProjects).toEqual([
      { project: 'src', parent: 'site', messages: 1 },
      { project: 'docs', parent: 'site', messages: 1 },
    ]);
    const rows = panel.periods.d30.projects as Array<{ project: string; merged: number; parent: string | null }>;
    expect(rows.find((p) => p.project === 'site')).toMatchObject({ merged: 2 });
    await call('/settings', 'POST', { settings: { collapsed: [] } });
    expect((await call('/panel')).json.collapsedProjects).toEqual([]);
  });
});
