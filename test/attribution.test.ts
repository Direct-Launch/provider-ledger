import { describe, expect, test } from 'bun:test';

import { UNATTRIBUTED, placementOf, projectKeyOf } from '../service/attribution.ts';
import { PROJECTS_SHOWN, applySession, bucketKey, deriveLedger, emptyStore, mergeSessions, parseBucketKey, reattributeSessions, rekeySessions } from '../service/ledger.ts';
import { sessionRefOf, syncOnce } from '../service/opencode.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { ROOT, msg, storeOf } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const ROOTS = [ROOT];

describe('projectKeyOf with no settings', () => {
  test('the default key is the session directory\u2019s own folder name', () => {
    expect(projectKeyOf('/home/user/code/shop')).toBe('shop');
    expect(projectKeyOf('/home/user/code/shop/')).toBe('shop');
    expect(projectKeyOf('/work/customers/Acme/sub')).toBe('sub');
    expect(projectKeyOf('/work/vault')).toBe('vault');
  });

  test('a Windows path is read the same way', () => {
    expect(projectKeyOf('C:\\Users\\me\\code\\shop')).toBe('shop');
    expect(projectKeyOf('C:\\Users\\me\\code\\shop\\')).toBe('shop');
  });

  test('every OpenChamber chat has its own folder; they are one key, on any machine', () => {
    expect(projectKeyOf('/home/someone/.config/openchamber/chats/2026-11-26/session-f43b7214')).toBe('Chats');
    expect(projectKeyOf('/Users/other/.config/openchamber/chats/2026-01-02/session-1/deep')).toBe('Chats');
    expect(projectKeyOf('/home/someone/.config/openchamber/chats')).toBe('chats');
    // not OpenChamber's folder: just a folder that happens to be called chats
    expect(projectKeyOf('/home/someone/code/openchamber/chats/x')).toBe('x');
  });

  test('no directory, or one that names nothing, is Unattributed', () => {
    expect(projectKeyOf(undefined)).toBe(UNATTRIBUTED);
    expect(projectKeyOf(null)).toBe(UNATTRIBUTED);
    expect(projectKeyOf('')).toBe(UNATTRIBUTED);
    expect(projectKeyOf('   ')).toBe(UNATTRIBUTED);
    expect(projectKeyOf('/')).toBe(UNATTRIBUTED);
  });

  test('a key never carries the bucket separator', () => {
    expect(projectKeyOf('/x/A|B')).toBe('A B');
    expect(parseBucketKey(bucketKey('2026-11-26', 'p', 'm', projectKeyOf('/x/A|B')))?.project).toBe('A B');
  });
});

describe('workspace roots', () => {
  test('a session under a root takes the first folder below it, whatever sits under that', () => {
    expect(projectKeyOf('/x/Accounts/Acme/sub', ['/x/Accounts'])).toBe('Acme');
    expect(projectKeyOf('/x/Accounts/Acme', ['/x/Accounts'])).toBe('Acme');
    expect(projectKeyOf('/x/Accounts/Acme/a/b/c/d', ['/x/Accounts'])).toBe('Acme');
    // the same path with no root is its own folder
    expect(projectKeyOf('/x/Accounts/Acme/sub')).toBe('sub');
  });

  test('a trailing slash on the root or the directory changes nothing', () => {
    expect(projectKeyOf('/x/Accounts/Acme/', ['/x/Accounts/'])).toBe('Acme');
  });

  test('the root itself, a sibling that shares its prefix and a path elsewhere are not under it', () => {
    expect(projectKeyOf('/x/Accounts', ['/x/Accounts'])).toBe('Accounts');
    expect(projectKeyOf('/x/Accounts-old/Acme', ['/x/Accounts'])).toBe('Acme');
    expect(projectKeyOf('/y/elsewhere/tool', ['/x/Accounts'])).toBe('tool');
  });

  test('the deepest root wins, and any root of several can match', () => {
    expect(projectKeyOf('/x/a/b/c/d', ['/x/a', '/x/a/b'])).toBe('c');
    expect(projectKeyOf('/p/q/r', ['/x/a', '/p'])).toBe('q');
  });

  test('Windows roots are matched without regard to case', () => {
    expect(projectKeyOf('C:\\Work\\Accounts\\Acme\\sub', ['c:\\work\\accounts'])).toBe('Acme');
  });

  test('OpenChamber\u2019s own folders stay Chats even under a root', () => {
    expect(projectKeyOf('/home/u/.config/openchamber/chats/2026-11-26/s', ['/home/u'])).toBe('Chats');
  });
});

describe('the parent folder', () => {
  test('a default-keyed project sits in the folder above it', () => {
    expect(placementOf('/x/Accounts/Acme/sub')).toEqual({ project: 'sub', parent: 'Acme' });
    expect(placementOf('/top')).toEqual({ project: 'top', parent: null });
    expect(placementOf('C:\\only')).toEqual({ project: 'only', parent: null });
  });

  test('a root-level project, Chats and Unattributed have nothing to merge into', () => {
    expect(placementOf('/x/Accounts/Acme/sub', ['/x/Accounts'])).toEqual({ project: 'Acme', parent: null });
    expect(placementOf('/h/.config/openchamber/chats/d/s').parent).toBeNull();
    expect(placementOf(null).parent).toBeNull();
  });
});

describe('bucket keys', () => {
  test('the agent is the last segment and the project the one before, so a model id with a bar survives', () => {
    expect(parseBucketKey('2026-11-26|ollama|org|model:7b|Acme|build')).toEqual({
      date: '2026-11-26', provider: 'ollama', model: 'org|model:7b', project: 'Acme', agent: 'build',
    });
    expect(bucketKey('2026-11-26', 'p', 'm', 'Acme', null)).toBe('2026-11-26|p|m|Acme|?');
  });
  test('a key written before version 4 (three or fewer bars) reads as null and is dropped', () => {
    expect(parseBucketKey('2026-11-26|anthropic|claude')).toBeNull();
    expect(parseBucketKey('2026-11-26|anthropic|claude|Acme')).toBeNull();
  });
});

describe('attribution in the ledger', () => {
  const day = (n: number): number => NOW - n * 86_400_000;

  test('a session\u2019s buckets carry its project and the sessions of one project add up', () => {
    const store = storeOf([
      { id: 'a', directory: `${ROOT}/Acme/Brand`, messages: [msg(NOW - 1000, 'anthropic', 'sonnet', 1)] },
      { id: 'b', directory: `${ROOT}/Acme`, messages: [msg(NOW - 2000, 'anthropic', 'sonnet', 2)] },
      { id: 'c', directory: '/home/user/tools', messages: [msg(NOW - 3000, 'anthropic', 'sonnet', 4)] },
      { id: 'd', directory: null, messages: [msg(NOW - 4000, 'anthropic', 'sonnet', 8)] },
    ], { roots: ROOTS });
    const merged = mergeSessions(store);
    expect(merged.get('2026-11-26|anthropic|sonnet|Acme|?')?.cost).toBe(3);
    expect(merged.get('2026-11-26|anthropic|sonnet|tools|?')?.cost).toBe(4);
    expect(merged.get('2026-11-26|anthropic|sonnet|Unattributed|?')?.cost).toBe(8);

    const view = deriveLedger(store, NOW);
    const p = view.periods.d30;
    expect(p.projects.map((x) => x.project)).toEqual(['Unattributed', 'tools', 'Acme']);
    expect(p.projects.reduce((a, x) => a + x.cost, 0)).toBe(p.totals.cost);
    expect(p.projects.reduce((a, x) => a + (x.share ?? 0), 0)).toBeCloseTo(100, 9);
    expect(p.unattributed.cost).toBe(8);
    expect(p.unattributed.share).toBeCloseTo((8 / 15) * 100, 9);
  });

  test('a period with no spend has no share, and an empty period still has an Unattributed line', () => {
    const store = storeOf([{ id: 'a', directory: '/x/X', messages: [msg(NOW - 1000, 'opencode-go', 'glm', 0)] }]);
    const p = deriveLedger(store, NOW).periods.today;
    expect(p.projects[0]?.share).toBeNull();
    expect(p.unattributed).toEqual({ project: 'Unattributed', cost: 0, tokens: 0, messages: 0, share: null, parent: null, merged: 0 });
  });

  test('periods filter the project table, not only the totals', () => {
    const store = storeOf([
      { id: 'a', directory: '/x/Old', messages: [msg(day(20), 'anthropic', 's', 5)] },
      { id: 'b', directory: '/x/New', messages: [msg(day(1), 'anthropic', 's', 1)] },
    ]);
    const view = deriveLedger(store, NOW);
    expect(view.periods.d7.projects.map((x) => x.project)).toEqual(['New']);
    expect(view.periods.d30.projects.map((x) => x.project)).toEqual(['Old', 'New']);
  });

  test('a long tail folds into Others, and Unattributed is never folded', () => {
    const sessions: Array<{ id: string; directory: string | null; messages: unknown[] }> = Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`, directory: `/x/Project ${String(i).padStart(2, '0')}`, messages: [msg(NOW - 1000, 'anthropic', 's', 40 - i)],
    }));
    sessions.push({ id: 'u', directory: null, messages: [msg(NOW - 1000, 'anthropic', 's', 0.01)] });
    const p = deriveLedger(storeOf(sessions), NOW).periods.d7;
    expect(p.projects).toHaveLength(PROJECTS_SHOWN + 1);
    expect(p.projects.some((x) => x.project === 'Unattributed')).toBe(true);
    const others = p.projects.find((x) => x.project.startsWith('Others'));
    expect(others).toBeDefined();
    expect(p.projects.reduce((a, x) => a + x.cost, 0)).toBeCloseTo(p.totals.cost, 9);
  });

  test('a changed workspace root re-keys the stored sessions without reading a message', () => {
    const store = storeOf([
      { id: 'a', directory: `${ROOT}/Acme/sub`, messages: [msg(NOW - 1000, 'anthropic', 's', 2)] },
      { id: 'b', directory: `${ROOT}/Beta/sub`, messages: [msg(NOW - 2000, 'anthropic', 's', 3)] },
    ]);
    expect(deriveLedger(store, NOW).periods.d7.projects.map((x) => x.project)).toEqual(['sub']);
    store.settings.roots = ROOTS;
    expect(rekeySessions(store)).toBe(2);
    expect(deriveLedger(store, NOW).periods.d7.projects.map((x) => [x.project, x.cost])).toEqual([['Beta', 3], ['Acme', 2]]);
    store.settings.roots = [];
    expect(rekeySessions(store)).toBe(2);
    expect(deriveLedger(store, NOW).periods.d7.projects.map((x) => x.project)).toEqual(['sub']);
  });
});

describe('merging a project into its parent', () => {
  const sessions = [
    { id: 'a', directory: '/x/app/one', messages: [msg(NOW - 1000, 'anthropic', 's', 1)] },
    { id: 'b', directory: '/x/app/two', messages: [msg(NOW - 2000, 'anthropic', 's', 2)] },
    { id: 'c', directory: '/x/app', messages: [msg(NOW - 3000, 'anthropic', 's', 4)] },
  ];

  test('each row names the folder it could merge into', () => {
    const p = deriveLedger(storeOf(sessions), NOW).periods.d7;
    expect(p.projects.map((x) => [x.project, x.parent, x.merged])).toEqual([['app', 'x', 0], ['two', 'app', 0], ['one', 'app', 0]]);
  });

  test('a key that comes from folders in many places has no single parent to merge into', () => {
    const many = storeOf([
      { id: 'a', directory: '/x/p1/src', messages: [msg(NOW - 1000, 'anthropic', 's', 1)] },
      { id: 'b', directory: '/x/p2/src', messages: [msg(NOW - 2000, 'anthropic', 's', 1)] },
      { id: 'c', directory: '/x/p3/src', messages: [msg(NOW - 3000, 'anthropic', 's', 1)] },
      { id: 'd', directory: '/x/p1/lib', messages: [msg(NOW - 4000, 'anthropic', 's', 1)] },
      { id: 'e', directory: '/x/p1/lib', messages: [msg(NOW - 5000, 'anthropic', 's', 1)] },
      { id: 'f', directory: '/x/p9/lib', messages: [msg(NOW - 6000, 'anthropic', 's', 1)] },
    ]);
    const rows = deriveLedger(many, NOW).periods.d7.projects;
    expect(rows.find((r) => r.project === 'src')?.parent).toBeNull();
    // more than half of lib sits in p1, so p1 is the parent
    expect(rows.find((r) => r.project === 'lib')?.parent).toBe('p1');
  });

  test('a merged project is counted under its parent, and the parent says how many it holds', () => {
    const store = storeOf(sessions, { collapsed: ['one', 'two'] });
    const p = deriveLedger(store, NOW).periods.d7;
    expect(p.projects.map((x) => [x.project, x.cost, x.merged])).toEqual([['app', 7, 2]]);
    expect(p.totals.cost).toBe(7);
  });

  test('a chain merges all the way up, and a cycle cannot loop', () => {
    const chain = storeOf(sessions, { collapsed: ['one', 'app'] });
    expect(deriveLedger(chain, NOW).periods.d7.projects.map((x) => [x.project, x.cost])).toEqual([['x', 5], ['two', 2]]);
    const loop = storeOf([
      { id: 'a', directory: '/x/p/q', messages: [msg(NOW - 1000, 'anthropic', 's', 1)] },
      { id: 'b', directory: '/x/q/p', messages: [msg(NOW - 2000, 'anthropic', 's', 2)] },
    ], { collapsed: ['p', 'q'] });
    expect(deriveLedger(loop, NOW).periods.d7.totals.cost).toBe(3);
  });

  test('merging is a view: nothing in the store changes', () => {
    const store = storeOf(sessions, { collapsed: ['one'] });
    expect(store.sessions.a?.project).toBe('one');
  });
});

describe('re-attribution', () => {
  const listing = (refs: Array<{ id: string; updated: number; directory?: string | null }>, reads: string[]): OpenCodeReader => ({
    listSessions: async () => refs,
    listMessages: async (id) => { reads.push(id); return [msg(NOW - 1000, 'anthropic', 's', 5)]; },
  });

  test('a changed directory moves the spend to the new key, from the list alone', async () => {
    const store = emptyStore();
    const reads: string[] = [];
    await syncOnce(store, listing([{ id: 's1', updated: 100, directory: '/x/Alpha' }], reads), { now: NOW });
    expect(reads).toEqual(['s1']);
    const before = deriveLedger(store, NOW).periods.all;
    expect(before.projects.map((p) => [p.project, p.cost])).toEqual([['Alpha', 5]]);

    // Same `updated`: nothing to read, yet the folder changed.
    const outcome = await syncOnce(store, listing([{ id: 's1', updated: 100, directory: '/x/Beta' }], reads), { now: NOW });
    expect(outcome.processed).toBe(0);
    expect(reads).toEqual(['s1']);
    const after = deriveLedger(store, NOW).periods.all;
    expect(after.projects.map((p) => [p.project, p.cost])).toEqual([['Beta', 5]]);
    expect(after.totals.cost).toBe(before.totals.cost);
    expect(store.sessions.s1?.project).toBe('Beta');
    expect(store.sessions.s1?.directory).toBe('/x/Beta');
    expect(Object.keys(store.sessions.s1?.buckets ?? {}).every((k) => k.endsWith('|Beta|?'))).toBe(true);
  });

  test('a changed directory and new messages: replaced, not merged', async () => {
    const store = emptyStore();
    const reads: string[] = [];
    await syncOnce(store, listing([{ id: 's1', updated: 100, directory: '/x/Alpha' }], reads), { now: NOW });
    await syncOnce(store, listing([{ id: 's1', updated: 200, directory: '/x/Beta' }], reads), { now: NOW });
    expect(reads).toEqual(['s1', 's1']);
    const p = deriveLedger(store, NOW).periods.all;
    expect(p.projects.map((x) => [x.project, x.cost])).toEqual([['Beta', 5]]);
  });

  test('Unattributed becomes a project once the list names a directory; the reverse never happens', () => {
    const store = emptyStore();
    applySession(store, { id: 's1', updated: 1, directory: null }, [msg(NOW - 1000, 'anthropic', 's', 3)]);
    expect(reattributeSessions(store, [{ id: 's1', updated: 1, directory: '/x/Gamma' }])).toBe(1);
    expect(store.sessions.s1?.project).toBe('Gamma');
    // A listing that carries no directory is not evidence that the folder changed.
    expect(reattributeSessions(store, [{ id: 's1', updated: 1, directory: null }, { id: 's1', updated: 1 }])).toBe(0);
    expect(store.sessions.s1?.project).toBe('Gamma');
    // An unchanged directory moves nothing.
    expect(reattributeSessions(store, [{ id: 's1', updated: 1, directory: '/x/Gamma' }])).toBe(0);
  });
});

describe('the session list', () => {
  test('directory comes from `directory` or OpenCode 2\u2019s `location.directory`', () => {
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, directory: '/a/b' })?.directory).toBe('/a/b');
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, location: { directory: '/c/d' }, projectID: 'p' })?.directory).toBe('/c/d');
    expect(sessionRefOf({ id: 's', time: { updated: NOW } })?.directory).toBeNull();
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, directory: '  ' })?.directory).toBeNull();
  });

  test('the session\u2019s own agent is read from a string or an object, and is null when absent', () => {
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, agent: 'plan' })?.agent).toBe('plan');
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, agent: { id: 'build' } })?.agent).toBe('build');
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, agent: { name: 'explore' } })?.agent).toBe('explore');
    expect(sessionRefOf({ id: 's', time: { updated: NOW } })?.agent).toBeNull();
    expect(sessionRefOf({ id: 's', time: { updated: NOW }, agent: ' ' })?.agent).toBeNull();
  });
});
