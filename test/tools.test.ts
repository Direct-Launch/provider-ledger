import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// @ts-ignore TS7016
import plugin from '../plugin/index.js';
import { createService } from '../service/app.ts';
import { DAY_MS, aggregateMessages, aggregateTools, applySession, capStoreSize, deriveLedger, emptyStore, pruneStore, RETENTION_DAYS } from '../service/ledger.ts';
import type { SessionRef } from '../service/ledger.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { sessionRefOf, syncOnce } from '../service/opencode.ts';
import { loadStore, saveStore } from '../service/store.ts';
import { classifyTool, parseToolKey, toolCallsOf, toolKey } from '../service/tools.ts';
import { scratch } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const TODAY = '2026-11-26';

type Part = Record<string, unknown>;

/** A completed tool part whose result is `chars` characters of text. */
const done = (name: string, input: Record<string, unknown>, chars = 0, id = `${name}-${Math.random()}`): Part => ({
  type: 'tool', id, name, executed: true,
  state: { status: 'completed', input, content: chars > 0 ? [{ type: 'text', text: 'x'.repeat(chars) }] : [] },
});

/** An OpenCode 2 assistant message: `content` carries the text and the tool parts. */
const reply = (created: number, content: Part[], over: { output?: number; reasoning?: number; cost?: number; provider?: string; model?: string } = {}): unknown => ({
  type: 'assistant',
  model: { providerID: over.provider ?? 'acme-cloud', id: over.model ?? 'acme-large' },
  cost: over.cost ?? 0.5,
  tokens: { input: 1000, output: over.output ?? 100, reasoning: over.reasoning ?? 0, cache: { read: 0, write: 0 } },
  time: { created, completed: created + 10_000 },
  content: [{ type: 'text', text: 'ok' }, ...content],
});

const rowOf = (rows: Record<string, { calls: number; generated: number; contextChars: number }>, cls: string, name: string) => {
  const hit = Object.entries(rows).find(([key]) => {
    const parsed = parseToolKey(key);
    return parsed?.cls === cls && parsed.name === name;
  });
  return hit?.[1];
};

describe('tool classes', () => {
  test('a skill is skill:<name> from the input; this build sends id, OpenCode 2 documents name', () => {
    expect(classifyTool('skill', { name: 'humanizer' })).toEqual({ cls: 'skill', name: 'humanizer' });
    expect(classifyTool('skill', { id: 'seo' })).toEqual({ cls: 'skill', name: 'seo' });
    expect(classifyTool('skill', {})).toEqual({ cls: 'tool', name: 'skill' });
    expect(classifyTool('skill', null)).toEqual({ cls: 'tool', name: 'skill' });
  });

  test('mcp_<server>_<tool> is mcp:<server>; the server is the first segment after mcp_', () => {
    expect(classifyTool('mcp_github_search_issues', {})).toEqual({ cls: 'mcp', name: 'github' });
    expect(classifyTool('mcp_my-server_a_b_c', {})).toEqual({ cls: 'mcp', name: 'my-server' });
  });

  test('a name that does not follow the convention is a plain tool, never a guessed server', () => {
    expect(classifyTool('weird_tool', {})).toEqual({ cls: 'tool', name: 'weird_tool' });
    expect(classifyTool('github_search_issues', {})).toEqual({ cls: 'tool', name: 'github_search_issues' });
    expect(classifyTool('mcp_github', {})).toEqual({ cls: 'tool', name: 'mcp_github' });
    expect(classifyTool('mcp__x', {})).toEqual({ cls: 'tool', name: 'mcp__x' });
    expect(classifyTool('execute', { code: 'tools.github.x()' })).toEqual({ cls: 'tool', name: 'execute' });
  });

  test('a subagent dispatch is agent:<type> from subagent_type, or agent; without either it is tool:task', () => {
    expect(classifyTool('task', { subagent_type: 'explore' })).toEqual({ cls: 'agent', name: 'explore' });
    expect(classifyTool('subagent', { agent: 'coder' })).toEqual({ cls: 'agent', name: 'coder' });
    expect(classifyTool('task', { description: 'x' })).toEqual({ cls: 'tool', name: 'task' });
    expect(classifyTool('subagent', {})).toEqual({ cls: 'tool', name: 'subagent' });
  });

  test('a name never carries a bar, so a key always parses back', () => {
    const { cls, name } = classifyTool('skill', { name: 'a|b\nc' });
    const key = toolKey('2026-11-26', 'p', 'model|with|bars', cls, name);
    expect(parseToolKey(key)).toEqual({ date: '2026-11-26', provider: 'p', model: 'model|with|bars', cls: 'skill', name: 'a b c' });
    expect(parseToolKey('2026-11-26|p|m|nonsense|x')).toBeNull();
    expect(parseToolKey('2026-11-26|p|m|skill|')).toBeNull();
  });
});

describe('tool parts of a message', () => {
  test('reads tool parts from content, skips text, and counts a call with no result', () => {
    const message = reply(NOW, [
      done('skill', { name: 'humanizer' }, 4000, 'a'),
      { type: 'tool', id: 'b', name: 'mcp_github_search', state: { status: 'running', input: {}, content: [{ type: 'text', text: 'partial' }] } },
      { type: 'tool', id: 'c', name: 'read', state: { status: 'streaming' } },
      { type: 'tool', id: 'd', name: 'read', state: { status: 'error', input: {}, content: [{ type: 'text', text: 'boom' }] } },
      { type: 'tool', id: 'e' },
    ]);
    expect(toolCallsOf(message)).toEqual([
      { cls: 'skill', name: 'humanizer', contextChars: 4000 },
      { cls: 'mcp', name: 'github', contextChars: 0 },
      { cls: 'tool', name: 'read', contextChars: 0 },
      { cls: 'tool', name: 'read', contextChars: 0 },
    ]);
  });

  test('result text counts only text entries; a file entry adds nothing', () => {
    const part: Part = { type: 'tool', id: 'a', name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'abc' }, { type: 'file', uri: 'file:///x', mime: 'image/png' }, { type: 'text', text: 'de' }] } };
    expect(toolCallsOf(reply(NOW, [part]))[0]?.contextChars).toBe(5);
  });

  test('the same call id twice in one message is one call; a flat message and { info, parts } both read', () => {
    const one = done('read', {}, 10, 'same');
    expect(toolCallsOf(reply(NOW, [one, one]))).toHaveLength(1);
    const legacy = { info: { role: 'assistant' }, parts: [{ type: 'tool', callID: 'x', tool: 'bash', state: { status: 'completed', input: {}, output: 'hello' } }] };
    expect(toolCallsOf(legacy)).toEqual([{ cls: 'tool', name: 'bash', contextChars: 5 }]);
    expect(toolCallsOf('nope')).toEqual([]);
    expect(toolCallsOf({ type: 'assistant' })).toEqual([]);
  });
});

describe('tool rows of a session', () => {
  test('acceptance: skill humanizer, 900 output tokens, 4 000 characters back', () => {
    const rows = aggregateTools([reply(NOW - 1000, [done('skill', { name: 'humanizer' }, 4000)], { output: 900 })]);
    expect(Object.keys(rows)).toEqual([`${TODAY}|acme-cloud|acme-large|skill|humanizer`]);
    expect(rowOf(rows, 'skill', 'humanizer')).toEqual({ calls: 1, generated: 900, contextChars: 4000 });
  });

  test('generated is output plus reasoning of the reply, counted once per class and name in it', () => {
    const rows = aggregateTools([reply(NOW - 1000, [
      done('read', {}, 100), done('read', {}, 50), done('mcp_github_search', {}, 10), done('mcp_github_get', {}, 20),
    ], { output: 300, reasoning: 200 })]);
    expect(rowOf(rows, 'tool', 'read')).toEqual({ calls: 2, generated: 500, contextChars: 150 });
    // Two tools of one server in one reply: the server's calls add up, its tokens are counted once.
    expect(rowOf(rows, 'mcp', 'github')).toEqual({ calls: 2, generated: 500, contextChars: 30 });
  });

  test('a running call counts with no context; a reply with no tool calls adds nothing; a non-reply is ignored', () => {
    const running: Part = { type: 'tool', id: 'r', name: 'mcp_github_search_issues', state: { status: 'running', input: {}, content: [{ type: 'text', text: 'abc' }] } };
    const rows = aggregateTools([
      reply(NOW - 1000, [running], { output: 40 }),
      reply(NOW - 900, []),
      { type: 'user', content: [done('read', {}, 5)] },
    ]);
    expect(Object.keys(rows)).toHaveLength(1);
    expect(rowOf(rows, 'mcp', 'github')).toEqual({ calls: 1, generated: 40, contextChars: 0 });
  });

  test('rows are split by day, provider and model', () => {
    const rows = aggregateTools([
      reply(NOW - 1000, [done('read', {}, 1)]),
      reply(NOW - 2 * DAY_MS, [done('read', {}, 1)]),
      reply(NOW - 1000, [done('read', {}, 1)], { provider: 'local-llama', model: 'llama-8b' }),
    ]);
    expect(Object.keys(rows).sort()).toEqual([
      '2026-11-24|acme-cloud|acme-large|tool|read',
      '2026-11-26|acme-cloud|acme-large|tool|read',
      '2026-11-26|local-llama|llama-8b|tool|read',
    ]);
  });

  test('reading tools does not change the buckets of the same messages', () => {
    const messages = [reply(NOW - 1000, [done('skill', { name: 'x' }, 10)], { output: 7 }), reply(NOW - 500, [])];
    const before = aggregateMessages(messages).buckets;
    aggregateTools(messages);
    expect(aggregateMessages(messages).buckets).toEqual(before);
    expect(Object.values(before).reduce((n, b) => n + b.messages, 0)).toBe(2);
  });
});

const ref = (id: string, updated: number, extra: Partial<SessionRef> = {}): SessionRef => ({ id, updated, directory: '/work/Acme', agent: 'build', ...extra });

describe('subagent sessions', () => {
  test('the listing names the parent as parentID, parentId, parent_id or parent', () => {
    const base = { id: 's', time: { updated: NOW } };
    expect(sessionRefOf({ ...base, parentID: 'p1' })?.parent).toBe('p1');
    expect(sessionRefOf({ ...base, parentId: 'p2' })?.parent).toBe('p2');
    expect(sessionRefOf({ ...base, parent_id: 'p3' })?.parent).toBe('p3');
    expect(sessionRefOf({ ...base, parent: 'p4' })?.parent).toBe('p4');
    expect(sessionRefOf({ ...base, parent: { id: 'p5' } })?.parent).toBe('p5');
    expect(sessionRefOf({ ...base, parentID: null })?.parent).toBeNull();
    expect(sessionRefOf(base)?.parent).toBeNull();
  });

  test('a subagent session stays in the ledger and in the total, and is reported as a share of it', () => {
    const store = emptyStore();
    applySession(store, ref('main', 100), [reply(NOW - 1000, [done('subagent', { agent: 'coder' }, 500)], { cost: 3 })]);
    applySession(store, ref('child', 101, { parent: 'main' }), [reply(NOW - 900, [], { cost: 1 })]);
    expect(store.sessions.child?.parent).toBe('main');
    expect(store.sessions.main?.parent).toBeUndefined();
    const view = deriveLedger(store, NOW).periods.today;
    expect(view.totals.cost).toBeCloseTo(4, 10);
    expect(view.totals.messages).toBe(2);
    const sub = view.surfaces.subagents;
    expect(sub.sessions).toBe(1);
    expect(sub.cost).toBeCloseTo(1, 10);
    expect(sub.share).toBeCloseTo(25, 10);
    expect(sub.replyShare).toBeCloseTo(50, 10);
    expect(sub.dispatches).toBe(1);
    expect(sub.types).toEqual([{ name: 'coder', calls: 1, generated: 100, contextChars: 500 }]);
    // The provider and project rows still add up to the total: the child is not counted twice.
    expect(view.providers.reduce((n, p) => n + p.cost, 0)).toBeCloseTo(view.totals.cost, 10);
    expect(view.projects.reduce((n, p) => n + p.cost, 0)).toBeCloseTo(view.totals.cost, 10);
  });

  test('a period with no spend has no share, only the reply share', () => {
    const store = emptyStore();
    applySession(store, ref('main', 100), [reply(NOW - 1000, [], { cost: 0 })]);
    applySession(store, ref('child', 101, { parent: 'main' }), [reply(NOW - 900, [], { cost: 0 })]);
    const sub = deriveLedger(store, NOW).periods.today.surfaces.subagents;
    expect(sub.share).toBeNull();
    expect(sub.replyShare).toBeCloseTo(50, 10);
  });

  test('a session the listing does not mark is not guessed to be a subagent', () => {
    const store = emptyStore();
    applySession(store, ref('only', 100), [reply(NOW - 1000, [], { cost: 2 })]);
    const sub = deriveLedger(store, NOW).periods.today.surfaces.subagents;
    expect(sub.sessions).toBe(0);
    expect(sub.share).toBe(0);
  });
});

describe('surfaces of a period', () => {
  const store = (): ReturnType<typeof emptyStore> => {
    const s = emptyStore();
    applySession(s, ref('a', 100), [
      reply(NOW - 1000, [done('skill', { name: 'humanizer' }, 4000), done('mcp_github_search', {}, 300), done('weird_tool', {}, 20)], { output: 900 }),
      reply(NOW - 900, [done('skill', { name: 'seo' }, 9000), done('subagent', { agent: 'coder' }, 50), done('subagent', { agent: 'explore' }, 10)], { output: 100 }),
      reply(NOW - 20 * DAY_MS, [done('skill', { name: 'humanizer' }, 1000)], { output: 50 }),
    ]);
    return s;
  };

  test('ranks by context added within each class, and keeps the classes apart', () => {
    const v = deriveLedger(store(), NOW).periods;
    const today = v.today.surfaces;
    expect(today.skills.map((r) => r.name)).toEqual(['seo', 'humanizer']);
    expect(today.skills[1]).toEqual({ name: 'humanizer', calls: 1, generated: 900, contextChars: 4000 });
    expect(today.mcp).toEqual([{ name: 'github', calls: 1, generated: 900, contextChars: 300 }]);
    expect(today.other).toEqual([{ name: 'weird_tool', calls: 1, generated: 900, contextChars: 20 }]);
    expect(today.calls).toBe(6);
    expect(today.contextChars).toBe(4000 + 300 + 20 + 9000 + 50 + 10);
    expect(today.subagents.types.map((r) => r.name).sort()).toEqual(['coder', 'explore']);
    // The older call lands in the longer periods only.
    expect(v.d7.surfaces.skills.find((r) => r.name === 'humanizer')?.calls).toBe(1);
    expect(v.d30.surfaces.skills.find((r) => r.name === 'humanizer')?.calls).toBe(2);
    expect(v.all.surfaces.skills.find((r) => r.name === 'humanizer')?.contextChars).toBe(5000);
  });

  test('only the top ten of each class are listed', () => {
    const s = emptyStore();
    const calls = Array.from({ length: 14 }, (_, i) => done('skill', { name: `skill-${String(i).padStart(2, '0')}` }, (i + 1) * 100));
    applySession(s, ref('a', 100), [reply(NOW - 1000, calls)]);
    const skills = deriveLedger(s, NOW).periods.today.surfaces.skills;
    expect(skills).toHaveLength(10);
    expect(skills[0]?.name).toBe('skill-13');
  });

  test('no tool calls in the period: empty lists and a zero call count, which the panel words instead of drawing', () => {
    const s = emptyStore();
    applySession(s, ref('a', 100), [reply(NOW - 1000, [])]);
    const surfaces = deriveLedger(s, NOW).periods.d7.surfaces;
    expect(surfaces.calls).toBe(0);
    expect(surfaces.skills).toEqual([]);
    expect(surfaces.mcp).toEqual([]);
    expect(surfaces.other).toEqual([]);
    expect(surfaces.subagents.dispatches).toBe(0);
    expect(deriveLedger(emptyStore(), NOW).periods.today.surfaces.calls).toBe(0);
  });
});

/** A reader over a fixed set of sessions that records every message read. */
const readerOf = (sessions: Array<{ ref: SessionRef; messages: unknown[] }>, reads: string[] = []): OpenCodeReader => ({
  listSessions: async () => sessions.map((s) => s.ref),
  listMessages: async (id) => {
    reads.push(id);
    return sessions.find((s) => s.ref.id === id)?.messages ?? [];
  },
});

describe('tools backfill', () => {
  /** A version 4 store: sessions read for their buckets, with no tool calls read for any. */
  const v4Store = (ids: string[]) => {
    const s = emptyStore();
    for (const id of ids) applySession(s, ref(id, 1000), []);
    s.tools = {};
    return s;
  };

  test('recent sessions are read newest first before older history, and the buckets stay as they were', async () => {
    const day = (n: number): number => NOW - n * DAY_MS;
    const sessions = [
      { ref: ref('old-1', day(200)), messages: [reply(day(200), [done('read', {}, 1)])] },
      { ref: ref('old-2', day(100)), messages: [reply(day(100), [done('read', {}, 1)])] },
      { ref: ref('mid', day(10)), messages: [reply(day(10), [done('skill', { name: 'seo' }, 10)])] },
      { ref: ref('new', day(1)), messages: [reply(day(1), [done('skill', { name: 'seo' }, 10)])] },
    ];
    const store = v4Store(sessions.map((s) => s.ref.id).map((id) => id));
    for (const s of sessions) store.sessions[s.ref.id] = { ...store.sessions[s.ref.id]!, updated: s.ref.updated };
    const bucketsBefore = JSON.stringify(Object.fromEntries(Object.entries(store.sessions).map(([id, e]) => [id, e.buckets])));
    const reads: string[] = [];
    const reader = readerOf(sessions, reads);

    const first = await syncOnce(store, reader, { now: NOW, maxSessions: 2 });
    expect(reads).toEqual(['new', 'mid']);
    expect(first.processed).toBe(2);
    expect(first.toolsPending).toBe(2);
    expect(Object.keys(store.tools).sort()).toEqual(['mid', 'new']);
    expect(store.tools.new?.toolsSynced).toBe(day(1));

    const second = await syncOnce(store, reader, { now: NOW, maxSessions: 2 });
    expect(reads.slice(2)).toEqual(['old-2', 'old-1']);
    expect(second.toolsPending).toBe(0);
    expect(JSON.stringify(Object.fromEntries(Object.entries(store.sessions).map(([id, e]) => [id, e.buckets])))).toBe(bucketsBefore);
    // Nothing left: a third run reads nothing, and an unchanged session is never read again.
    const third = await syncOnce(store, reader, { now: NOW, maxSessions: 2 });
    expect(third.processed).toBe(0);
    expect(reads).toHaveLength(4);
  });

  test('a recent session that was never read is read once, for its buckets and its tool calls together', async () => {
    const store = emptyStore();
    const reads: string[] = [];
    const sessions = [{ ref: ref('fresh', NOW - 1000), messages: [reply(NOW - 1000, [done('skill', { name: 'seo' }, 10)], { cost: 2 })] }];
    await syncOnce(store, readerOf(sessions, reads), { now: NOW });
    expect(reads).toEqual(['fresh']);
    expect(store.sessions.fresh?.updated).toBe(NOW - 1000);
    expect(rowOf(store.tools.fresh?.rows ?? {}, 'skill', 'seo')?.calls).toBe(1);
    await syncOnce(store, readerOf(sessions, reads), { now: NOW });
    expect(reads).toEqual(['fresh']);
  });

  test('a session that changed is read again and replaces its tool rows, not adds to them', async () => {
    const store = emptyStore();
    const reads: string[] = [];
    await syncOnce(store, readerOf([{ ref: ref('s', 1000), messages: [reply(NOW - 1000, [done('read', {}, 5)])] }], reads), { now: NOW });
    await syncOnce(store, readerOf([{ ref: ref('s', 2000), messages: [reply(NOW - 1000, [done('read', {}, 5), done('read', {}, 5)])] }], reads), { now: NOW });
    expect(reads).toEqual(['s', 's']);
    expect(Object.values(store.tools.s?.rows ?? {})[0]?.calls).toBe(2);
    expect(store.tools.s?.toolsSynced).toBe(2000);
  });

  test('a refusal for good settles a session\'s tool calls as none without wiping its buckets', async () => {
    const store = v4Store(['a']);
    store.sessions.a!.buckets = { '2026-11-26|p|m|Acme|build': { messages: 1, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1, samples: [], p50: null, p90: null } };
    const reader: OpenCodeReader = { listSessions: async () => [ref('a', 1000)], listMessages: async () => { throw new (await import('../service/opencode.ts')).UpstreamError('gone', 404, false); } };
    const outcome = await syncOnce(store, reader, { now: NOW });
    expect(outcome.toolsPending).toBe(0);
    expect(store.tools.a).toEqual({ toolsSynced: 1000, rows: {} });
    expect(Object.keys(store.sessions.a!.buckets)).toHaveLength(1);
    expect(store.sessions.a!.skipped).toBeUndefined();
  });

  test('the listing alone marks a session already read as a subagent session', async () => {
    const store = emptyStore();
    applySession(store, ref('child', 1000), []);
    const reads: string[] = [];
    await syncOnce(store, readerOf([{ ref: ref('child', 1000, { parent: 'main' }), messages: [] }], reads), { now: NOW });
    expect(store.sessions.child?.parent).toBe('main');
    // Nothing is cleared by a listing that names no parent.
    await syncOnce(store, readerOf([{ ref: ref('child', 1000), messages: [] }], reads), { now: NOW });
    expect(store.sessions.child?.parent).toBe('main');
  });

  test('the service keeps chaining while tool calls are pending, and reports it to the panel', async () => {
    const dir = await scratch();
    const old = NOW - 100 * DAY_MS;
    const sessions = Array.from({ length: 45 }, (_, i) => ({ ref: ref(`s${i}`, old + i), messages: [reply(old, [done('read', {}, 1)])] }));
    const service = await createService({ token: 't', storePath: join(dir, 'store.json'), reader: readerOf(sessions), autoSync: false, now: () => NOW });
    await service.runBatch();
    let payload = service.panelPayload();
    expect(payload.toolsRead).toBe(40);
    expect(payload.toolsPending).toBe(5);
    await service.runBatch();
    payload = service.panelPayload();
    expect(payload.toolsRead).toBe(45);
    expect(payload.toolsPending).toBe(0);
  });
});

describe('the store', () => {
  test('stays version 4; an older file without tools loads with none and is not re-read', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    const old = emptyStore();
    applySession(old, ref('a', 1000), []);
    const { tools: _tools, toolsPending: _pending, ...v4 } = old;
    await Bun.write(path, JSON.stringify(v4));
    const loaded = await loadStore(path, NOW);
    expect(loaded.version).toBe(4);
    expect(Object.keys(loaded.sessions)).toEqual(['a']);
    expect(loaded.tools).toEqual({});
    expect(loaded.toolsPending).toBe(0);
    expect(loaded.rebuilding).toBeUndefined();
  });

  test('tool rows round-trip, the file is 0600, and malformed rows are dropped on load', async () => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    const store = emptyStore();
    applySession(store, ref('a', 1000), [reply(NOW - 1000, [done('skill', { name: 'seo' }, 10)], { output: 9 })]);
    await saveStore(path, store, NOW);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text = JSON.parse(await readFile(path, 'utf8'));
    expect(text.version).toBe(4);
    text.tools.a.rows['2026-11-26|p|m|skill|bad'] = { calls: 'x' };
    text.tools.broken = { rows: {} };
    await Bun.write(path, JSON.stringify(text));
    const loaded = await loadStore(path, NOW);
    expect(Object.keys(loaded.tools)).toEqual(['a']);
    expect(Object.keys(loaded.tools.a!.rows)).toEqual(['2026-11-26|acme-cloud|acme-large|skill|seo']);
  });

  test('tool rows past the retention are dropped but the session keeps its marker', () => {
    const store = emptyStore();
    const longAgo = NOW - (RETENTION_DAYS + 5) * DAY_MS;
    applySession(store, ref('a', 1000), [reply(longAgo, [done('read', {}, 1)]), reply(NOW - 1000, [done('read', {}, 1)])]);
    pruneStore(store, NOW);
    expect(Object.keys(store.tools.a!.rows)).toEqual([`${TODAY}|acme-cloud|acme-large|tool|read`]);
    expect(store.tools.a!.toolsSynced).toBe(1000);
  });

  test('the size cap drops the oldest days of tool rows with the buckets', () => {
    const store = emptyStore();
    const messages = Array.from({ length: 60 }, (_, i) => reply(NOW - i * DAY_MS, [done('read', {}, 1)]));
    applySession(store, ref('a', 1000), messages);
    const before = JSON.stringify(store).length;
    const dropped = capStoreSize(store, Math.floor(before * 0.5));
    expect(dropped).toBeGreaterThan(0);
    expect(JSON.stringify(store).length).toBeLessThanOrEqual(Math.floor(before * 0.5));
    const days = Object.keys(store.tools.a!.rows).map((k) => parseToolKey(k)!.date).sort();
    expect(days.at(-1)).toBe(TODAY);
    expect(days[0]! > '2026-09-27').toBe(true);
  });
});

describe('the agent tool', () => {
  const run = async (store: ReturnType<typeof emptyStore>, period = 'd30'): Promise<string> => {
    const dir = await scratch();
    const path = join(dir, 'store.json');
    await saveStore(path, store, Date.now());
    const saved = process.env.PROVIDER_LEDGER_STORE;
    process.env.PROVIDER_LEDGER_STORE = path;
    try {
      let tool: { execute: (i: unknown) => Promise<{ content: string }> } | null = null;
      await plugin.setup({ tool: { transform: async (cb: (t: { add: (x: typeof tool) => void }) => void) => { cb({ add: (x) => { tool = x; } }); } } });
      return (await tool!.execute({ period })).content;
    } finally {
      if (saved === undefined) delete process.env.PROVIDER_LEDGER_STORE;
      else process.env.PROVIDER_LEDGER_STORE = saved;
    }
  };

  test('names the top skills, the top MCP servers and the subagent share, from the same rows as the panel', async () => {
    const now = Date.now();
    const store = emptyStore();
    applySession(store, ref('main', 100), [reply(now - 1000, [done('skill', { name: 'humanizer' }, 4000), done('mcp_github_search', {}, 300), done('subagent', { agent: 'coder' }, 5)], { cost: 3, output: 900 })]);
    applySession(store, ref('child', 101, { parent: 'main' }), [reply(now - 900, [], { cost: 1 })]);
    const text = await run(store);
    expect(text).toContain('Surfaces, top skills: humanizer 1 call, 4.0k chars.');
    expect(text).toContain('Top MCP servers: github 1 call, 300 chars.');
    expect(text).toContain('Subagents: 1 dispatch, 1 session with 25% of spend ($1.00)');
    const surfaces = deriveLedger(store, now).periods.d30.surfaces;
    expect(surfaces.skills[0]?.name).toBe('humanizer');
    expect(Math.round(surfaces.subagents.share ?? -1)).toBe(25);
  });

  test('says tool calls have not been read yet rather than printing zeros, and when the period has none', async () => {
    const now = Date.now();
    const store = emptyStore();
    applySession(store, ref('a', 100), [reply(now - 1000, [])]);
    store.tools = {};
    expect(await run(store)).toContain('Surfaces: tool calls have not been read yet');
    applySession(store, ref('a', 100), [reply(now - 1000, [])]);
    expect(await run(store)).toContain('Surfaces: no tool calls in this period.');
  });
});
