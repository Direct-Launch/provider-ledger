import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAY_MS,
  aggregateMessages,
  applySession,
  addMonths,
  buildBalanceCards,
  capStoreSize,
  deriveLedger,
  periodRange,
  emptyStore,
  mergeSessions,
  normalizeMessage,
  percentile,
  selectSessions,
} from '../service/ledger.ts';
import { UpstreamError, createOpenCodeReader, syncOnce, unwrapList, sessionRefOf } from '../service/opencode.ts';
import type { OpenCodeReader } from '../service/opencode.ts';
import { loadStore, saveStore } from '../service/store.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

/** An OpenCode assistant message as `{ info, parts }`. */
const message = (over: {
  provider?: string;
  model?: string;
  cost?: number;
  created?: number;
  seconds?: number | null;
  input?: number;
  output?: number;
  reasoning?: number;
  read?: number;
  write?: number;
  role?: string;
}): unknown => {
  const created = over.created ?? NOW - 1000;
  return {
    info: {
      id: 'msg_x',
      role: over.role ?? 'assistant',
      providerID: over.provider ?? 'opencode-go',
      modelID: over.model ?? 'glm-5',
      cost: over.cost ?? 0.5,
      tokens: {
        input: over.input ?? 1000,
        output: over.output ?? 100,
        reasoning: over.reasoning ?? 0,
        cache: { read: over.read ?? 0, write: over.write ?? 0 },
      },
      time: over.seconds === null ? { created } : { created, completed: created + (over.seconds ?? 10) * 1000 },
    },
    parts: [{ type: 'text', text: 'ignored' }],
  };
};

describe('normalizeMessage', () => {
  test('reads the { info, parts } shape', () => {
    const m = normalizeMessage(message({ output: 150, reasoning: 50, seconds: 10 }));
    expect(m).not.toBeNull();
    expect(m?.provider).toBe('opencode-go');
    expect(m?.model).toBe('glm-5');
    expect(m?.rate).toBeCloseTo(20, 5);
    expect(m?.date).toBe('2026-11-26');
  });

  test('reads a flat message with a nested model', () => {
    const flat = {
      role: 'assistant',
      model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      time: { created: NOW, completed: NOW + 2000 },
    };
    const m = normalizeMessage(flat);
    expect(m?.provider).toBe('deepseek');
    expect(m?.model).toBe('deepseek-chat');
    expect(m?.tokens.cacheRead).toBe(1);
    expect(m?.tokens.cacheWrite).toBe(2);
  });

  test('reads an OpenCode 2 message: type, nested model, no role', () => {
    const v2 = {
      id: 'msg_v2',
      type: 'assistant',
      model: { id: 'glm-5', providerID: 'opencode-go' },
      cost: 0.25,
      tokens: { input: 2000, output: 400, reasoning: 100, cache: { read: 800, write: 0 } },
      time: { created: NOW - 12000, completed: NOW - 2000 },
    };
    const m = normalizeMessage(v2);
    expect(m?.provider).toBe('opencode-go');
    expect(m?.model).toBe('glm-5');
    expect(m?.cost).toBe(0.25);
    expect(m?.tokens.cacheRead).toBe(800);
    expect(m?.rate).toBeCloseTo(50, 5);
  });

  test('skips a non-assistant OpenCode 2 message that carries tokens', () => {
    const synthetic = {
      id: 'msg_s',
      type: 'synthetic',
      model: { id: 'glm-5', providerID: 'opencode-go' },
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: NOW },
    };
    expect(normalizeMessage(synthetic)).toBeNull();
  });

  test('skips what it cannot classify', () => {
    expect(normalizeMessage(message({ role: 'user' }))).toBeNull();
    expect(normalizeMessage({ info: { role: 'assistant', modelID: 'x', time: { created: NOW } } })).toBeNull(); // no provider
    expect(normalizeMessage({ info: { role: 'assistant', providerID: 'p', time: { created: NOW } } })).toBeNull(); // no model
    expect(normalizeMessage({ info: { role: 'assistant', providerID: 'p', modelID: 'm' } })).toBeNull(); // no time
    expect(normalizeMessage({ info: { providerID: 'p', modelID: 'm', time: { created: NOW } } })).toBeNull(); // no role, no tokens
    expect(normalizeMessage('nope')).toBeNull();
    expect(normalizeMessage(null)).toBeNull();
  });

  test('no rate under one second or with no generated tokens', () => {
    expect(normalizeMessage(message({ seconds: 0.5 }))?.rate).toBeNull();
    expect(normalizeMessage(message({ output: 0, reasoning: 0 }))?.rate).toBeNull();
    expect(normalizeMessage(message({ seconds: null }))?.rate).toBeNull();
  });
});

describe('percentile', () => {
  test('interpolates', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBeCloseTo(46, 5);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('aggregateMessages', () => {
  test('folds messages into date|provider|model|project|agent buckets with p50 and p90', () => {
    const { buckets, skipped } = aggregateMessages([
      message({ output: 100, seconds: 10, cost: 0.1 }), // 10 tok/s
      message({ output: 200, seconds: 10, cost: 0.2 }), // 20 tok/s
      message({ output: 300, seconds: 10, cost: 0.3 }), // 30 tok/s
      message({ output: 50, seconds: 0.2, cost: 0.05 }), // untimed
      message({ provider: 'ollama-cloud', model: 'qwen', cost: 0 }),
      message({ role: 'user' }),
    ]);
    expect(skipped).toBe(1);
    const go = buckets['2026-11-26|opencode-go|glm-5|Unattributed|?'];
    expect(go?.messages).toBe(4);
    expect(go?.cost).toBeCloseTo(0.65, 10);
    expect(go?.tokens.output).toBe(650);
    expect(go?.samples).toEqual([10, 20, 30]);
    expect(go?.p50).toBe(20);
    expect(go?.p90).toBe(28);
    expect(buckets['2026-11-26|ollama-cloud|qwen|Unattributed|?']?.messages).toBe(1);
  });

  test('splits on the UTC date', () => {
    const lateNight = Date.UTC(2026, 10, 25, 23, 59, 59);
    const { buckets } = aggregateMessages([message({ created: lateNight }), message({ created: lateNight + 2000 })]);
    expect(Object.keys(buckets).sort()).toEqual(['2026-11-25|opencode-go|glm-5|Unattributed|?', '2026-11-26|opencode-go|glm-5|Unattributed|?']);
  });
});

describe('selectSessions (backfill)', () => {
  const refs = Array.from({ length: 50 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, updated: NOW - (50 - i) * 1000 }));

  test('takes the 40 oldest first and reports the rest as pending', () => {
    const { selected, pending } = selectSessions(refs, {}, {});
    expect(selected).toHaveLength(40);
    expect(selected[0]?.id).toBe('s00');
    expect(selected[39]?.id).toBe('s39');
    expect(pending).toBe(10);
  });

  test('skips sessions already read at the same updated time and takes changed ones', () => {
    const known = {
      s00: { updated: refs[0]!.updated, buckets: {} },
      s01: { updated: refs[1]!.updated - 5000, buckets: {} }, // changed since
    };
    const { selected } = selectSessions(refs.slice(0, 3), known, {});
    expect(selected.map((r) => r.id)).toEqual(['s01', 's02']);
  });

  test('a session never seen is eligible whatever its age: history backfills', () => {
    const old = [{ id: 'old', updated: NOW - 900 * DAY_MS }, { id: 'new', updated: NOW - DAY_MS }];
    expect(selectSessions(old, {}, {}).selected.map((r) => r.id)).toEqual(['old', 'new']);
    // once read it is known, even when its buckets were pruned away, and is not picked again
    const known = { old: { updated: old[0]!.updated, buckets: {} } };
    expect(selectSessions(old, known, {}).selected.map((r) => r.id)).toEqual(['new']);
  });

  test('a big first sync finishes over a few runs, oldest first, pending reaching 0 only at the end', async () => {
    const store = emptyStore();
    const reader: OpenCodeReader = {
      listSessions: async () => refs,
      listMessages: async () => [message({})],
    };
    const runs: number[] = [];
    const pendings: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const outcome = await syncOnce(store, reader, { now: NOW });
      runs.push(outcome.processed);
      pendings.push(outcome.pending);
      if (outcome.pending === 0) break;
    }
    expect(runs).toEqual([40, 10]);
    expect(pendings).toEqual([10, 0]);
    expect(Object.keys(store.sessions)).toHaveLength(50);
    expect(store.watermark).toBe(refs[49]!.updated);
  });

  test('history far older than any retention window is read and counted, then not read again', async () => {
    const store = emptyStore();
    const longAgo = Date.UTC(2026, 5, 3, 9, 0, 0);
    const reader: OpenCodeReader = {
      listSessions: async () => [{ id: 'ancient', updated: longAgo }, { id: 'recent', updated: NOW - 1000 }],
      listMessages: async (id) => [message({ created: id === 'ancient' ? longAgo : NOW - 1000, cost: id === 'ancient' ? 4 : 1 })],
    };
    const first = await syncOnce(store, reader, { now: NOW });
    expect(first).toMatchObject({ processed: 2, pending: 0 });
    const view = deriveLedger(store, NOW);
    expect(view.firstDate).toBe('2026-06-03');
    expect(view.periods.all.totals.cost).toBe(5);
    const second = await syncOnce(store, reader, { now: NOW });
    expect(second.processed).toBe(0);
  });
});

describe('applySession and deriveLedger', () => {
  test('re-reading a session replaces its contribution instead of doubling it', () => {
    const store = emptyStore();
    applySession(store, { id: 's1', updated: 1 }, [message({ cost: 1 })]);
    applySession(store, { id: 's1', updated: 2 }, [message({ cost: 1 }), message({ cost: 2 })]);
    const merged = mergeSessions(store);
    expect(merged.get('2026-11-26|opencode-go|glm-5|Unattributed|?')?.cost).toBe(3);
  });

  test('ranks providers by spend per period and keeps older spend out of 7 days', () => {
    const store = emptyStore();
    const tenDaysAgo = NOW - 10 * DAY_MS;
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'anthropic', model: 'sonnet', cost: 5, output: 1000, input: 9000, seconds: 10 }),
      message({ provider: 'anthropic', model: 'sonnet', cost: 100, created: tenDaysAgo }),
      message({ provider: 'deepseek', model: 'chat', cost: 1, output: 500, input: 500, seconds: 5 }),
    ]);
    applySession(store, { id: 'b', updated: 2 }, [
      message({ provider: 'opencode-go', model: 'glm-5', cost: 7, output: 2000, input: 8000, seconds: 20 }),
    ]);
    const view = deriveLedger(store, NOW);
    const d7 = view.periods.d7;
    expect(d7.providers.map((p) => p.provider)).toEqual(['opencode-go', 'anthropic', 'deepseek']);
    expect(d7.providers[1]?.cost).toBe(5);
    expect(view.periods.d30.providers.find((p) => p.provider === 'anthropic')?.cost).toBe(105);
    expect(view.totals.d7.cost).toBe(13);
    expect(view.totals.d30.cost).toBe(113);
    expect(view.totals.today.cost).toBe(13);
    expect(d7.providers[0]?.perMillion).toBeCloseTo((7 / 10_000) * 1e6, 5);
    expect(d7.providers[0]?.p50).toBe(100);
    expect(d7.models[0]?.model).toBe('glm-5');
    expect(d7.series).toHaveLength(7);
    expect(d7.granularity).toBe('day');
    expect(view.periods.d30.series).toHaveLength(30);
    expect(d7.series[6]?.byProvider['anthropic']).toBe(5);
    expect(view.hasData).toBe(true);
  });

  test('p50 for a provider has no value when nothing was timed, never zero', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [message({ seconds: null })]);
    const view = deriveLedger(store, NOW);
    expect(view.periods.d7.providers[0]?.p50).toBeNull();
  });
});

describe('period boundaries', () => {
  test('this month, last month and all time on a month boundary', () => {
    expect(periodRange('month', '2026-12-01', '2026-11-12')).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(periodRange('lastMonth', '2026-12-01', '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('lastMonth', '2027-01-15', null)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodRange('all', '2026-12-01', '2026-11-12')).toEqual({ from: '2026-11-12', to: '2026-12-01' });
    expect(periodRange('d7', '2026-12-03', null)).toEqual({ from: '2026-11-27', to: '2026-12-03' });
  });

  test('a leap day: last month is February 29 days in 2028, 28 in 2027', () => {
    expect(periodRange('lastMonth', '2028-03-10', null)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('lastMonth', '2027-03-10', null)).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(periodRange('d30', '2028-03-01', null).from).toBe('2028-02-01'); // 29 February days + 1 March = 30
    expect(periodRange('d7', '2028-03-03', null).from).toBe('2028-02-26'); // crosses the leap day
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });

  test('spend lands on the right side of a month boundary and a leap day', () => {
    const store = emptyStore();
    const at = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m - 1, d, h);
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'anthropic', cost: 1, created: at(2028, 1, 31, 23) }),
      message({ provider: 'anthropic', cost: 2, created: at(2028, 2, 29, 23) }),
      message({ provider: 'anthropic', cost: 4, created: at(2028, 3, 1, 0) }),
      message({ provider: 'anthropic', cost: 8, created: at(2028, 3, 10, 6) }),
    ]);
    const now = at(2028, 3, 10);
    const view = deriveLedger(store, now);
    expect(view.periods.lastMonth.totals.cost).toBe(2);
    expect(view.periods.lastMonth.series).toHaveLength(29);
    expect(view.periods.lastMonth.series[28]?.key).toBe('2028-02-29');
    expect(view.periods.month.totals.cost).toBe(12);
    expect(view.periods.month.series).toHaveLength(10);
    expect(view.periods.all.totals.cost).toBe(15);
    expect(view.firstDate).toBe('2028-01-31');
    expect(view.periods.today.totals.cost).toBe(8);
    expect(view.periods.d7.totals.cost).toBe(8); // 4 to 10 March: the 1 March reply is outside
  });

  test('all time and long ranges chart by month, zero-filled, with the months named', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'anthropic', cost: 3, created: Date.UTC(2026, 8, 20) }),
      message({ provider: 'anthropic', cost: 5, created: Date.UTC(2026, 10, 2) }),
    ]);
    const all = deriveLedger(store, NOW).periods.all;
    expect(all.granularity).toBe('month');
    expect(all.series.map((p) => p.key)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(all.series.map((p) => p.cost)).toEqual([3, 0, 5]);
    expect(all.from).toBe('2026-09-20');
  });

  test('the Months block: six months, newest first, top provider by spend', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'anthropic', cost: 3, created: Date.UTC(2026, 9, 5) }),
      message({ provider: 'ollama', cost: 4, created: Date.UTC(2026, 9, 6) }),
      message({ provider: 'anthropic', cost: 1, created: NOW - 1000 }),
    ]);
    const { months } = deriveLedger(store, NOW);
    expect(months).toHaveLength(6);
    expect(months.map((m) => m.month)).toEqual(['2026-11', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
    expect(months[1]).toMatchObject({ cost: 7, messages: 2, top: { provider: 'ollama', by: 'spend' } });
    expect(months[2]).toMatchObject({ cost: 0, messages: 0, top: null });
  });
});

describe('honest money', () => {
  const planWindow = { usedPercent: 40, windowSeconds: 18000, resetAt: NOW + 3_600_000 };
  const snap = (provider: string, windows: Record<string, unknown>) => ({ provider, fetchedAt: NOW, ok: true, configured: true, windows: windows as never });

  test('all-zero cost with plan windows is a subscription: no $/1M, flagged; any other zero stays', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'opencode-go', cost: 0 }),
      message({ provider: 'openrouter', cost: 0 }),
      message({ provider: 'anthropic', cost: 0.5 }),
    ]);
    store.balances['opencode-go'] = snap('opencode-go', { '5h': planWindow });
    const rows = Object.fromEntries(deriveLedger(store, NOW).periods.d7.providers.map((p) => [p.provider, p]));
    expect(rows['opencode-go']).toMatchObject({ subscription: true, perMillion: null });
    expect(rows['openrouter']?.subscription).toBe(false); // zero cost but no plan windows
    expect(rows['openrouter']?.perMillion).toBe(0);
    expect(rows['anthropic']?.subscription).toBe(false);
  });

  test('a plan once seen stays seen through a failed or expired read', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [message({ provider: 'opencode-go', cost: 0 })]);
    store.balances['opencode-go'] = { provider: 'opencode-go', fetchedAt: NOW, ok: false, configured: true, needsSignIn: true, hadPlan: true, error: 'x', windows: {} };
    expect(deriveLedger(store, NOW).periods.d7.providers[0]?.subscription).toBe(true);
    store.balances['opencode-go'] = { provider: 'opencode-go', fetchedAt: NOW, ok: false, configured: true, error: 'x', windows: {} };
    expect(deriveLedger(store, NOW).periods.d7.providers[0]?.subscription).toBe(false);
  });

  test('a provider with a nonzero cost anywhere in history is never a subscription', () => {
    const store = emptyStore();
    applySession(store, { id: 'a', updated: 1 }, [
      message({ provider: 'opencode-go', cost: 0 }),
      message({ provider: 'opencode-go', cost: 0.1, created: NOW - 20 * DAY_MS }),
    ]);
    store.balances['opencode-go'] = snap('opencode-go', { '5h': planWindow });
    expect(deriveLedger(store, NOW).periods.d7.providers[0]?.subscription).toBe(false);
  });
});

describe('balance cards', () => {
  const win = (usedPercent: number | null, extra: Record<string, unknown> = {}) => ({ usedPercent, windowSeconds: null, ...extra });
  const snap = (provider: string, over: Record<string, unknown>) => ({ provider, fetchedAt: NOW, ok: true, configured: true, windows: {}, ...over }) as never;

  test('money first, then windows, then the rest alphabetically; failures are words, never $0.00', () => {
    const balances = {
      ollama: snap('ollama', { windows: { monthly: win(100, { valueLabel: '$0.00 left', value: { kind: 'spend', spent: 300, limit: 300 }, resetAt: NOW + 3 * 86_400_000 }), credits_balance: win(null, { valueLabel: '$7.88' }) } }),
      'opencode-go': snap('opencode-go', { planLabel: 'Go', windows: { '5h': win(42, { resetAt: NOW + 7_800_000 }), weekly: win(10), monthly: win(5) } }),
      anthropic: snap('anthropic', { error: 'Anthropic has no balance API; see the ledger for spend.' }),
      opencode: snap('opencode', { ok: false, needsSignIn: true, error: 'Your OpenCode sign-in has expired — sign in again on OpenCode Console in Providers.' }),
    };
    const cards = buildBalanceCards(balances, ['anthropic', 'opencode-go', 'ollama', 'console-ollama-cloud', 'zeta', 'opencode']);
    expect(cards.map((c) => `${c.name}:${c.state}`)).toEqual([
      'Ollama Cloud:money', 'OpenCode Go:windows', 'Anthropic:none', 'OpenCode Zen:signin', 'Zeta:unread',
    ]);
    const ollama = cards[0]!;
    expect(ollama.headline).toBe('$7.88');
    expect(ollama.windows[0]).toMatchObject({ title: 'Monthly', used: 100, detail: '100% used · $0.00 left' });
    const go = cards[1]!;
    expect(go.windows.map((w) => w.title)).toEqual(['5h', 'Weekly', 'Monthly']);
    expect(go.windows[0]?.detail).toBe('42% used');
    expect(cards[2]?.note).toBe('No balance API — spend is in the ledger');
    expect(cards[3]?.note).toBe('Sign in again');
    expect(cards[4]?.note).toBe('Not read yet');
    expect(JSON.stringify(cards.slice(2))).not.toContain('$0.00');
  });

  test('a money-less spend window supplies the headline once, not twice', () => {
    const cards = buildBalanceCards({ ollama: snap('ollama', { windows: { monthly: win(100, { valueLabel: '$0.00 left', value: { kind: 'spend', spent: 3, limit: 3 } }) } }) }, ['ollama']);
    expect(cards[0]).toMatchObject({ state: 'money', headline: '$0.00 left' });
    expect(cards[0]?.windows[0]?.detail).toBe('100% used');
  });

  test('two ids for one account make one card; a failed alias never hides a good read', () => {
    const balances = {
      ollama: snap('ollama', { windows: { credits_balance: win(null, { valueLabel: '$7.88' }) } }),
      'console-ollama-cloud': snap('console-ollama-cloud', { ok: false, error: 'Ollama needs an API key' }),
    };
    const cards = buildBalanceCards(balances, ['ollama', 'console-ollama-cloud']);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.headline).toBe('$7.88');
  });

  test('Zen repeating the Go credit balance, with no replies of its own, gets no card', () => {
    const credits = { credits_balance: win(null, { valueLabel: '$12.40' }) };
    const balances = {
      'opencode-go': snap('opencode-go', { windows: { '5h': win(10, { resetAt: NOW + 1000 }), ...credits } }),
      opencode: snap('opencode', { windows: credits }),
    };
    expect(buildBalanceCards(balances, ['opencode-go']).map((c) => c.account)).toEqual(['opencode-go']);
    expect(buildBalanceCards(balances, ['opencode-go', 'opencode']).map((c) => c.account).sort()).toEqual(['opencode', 'opencode-go']);
  });

  test('an account that only failed and has no ledger replies gets no card', () => {
    expect(buildBalanceCards({ opencode: snap('opencode', { ok: false, error: 'x' }) }, ['anthropic']).map((c) => c.account)).toEqual(['anthropic']);
  });
});

describe('syncOnce failure handling', () => {
  test('a transient failure ends the run and leaves the rest pending', async () => {
    const store = emptyStore();
    // Older than 30 days, so they are read oldest first; the newest-first order of recent sessions is in tools.test.ts.
    const old = NOW - 90 * DAY_MS;
    const refs = [{ id: 'a', updated: old - 3000 }, { id: 'b', updated: old - 2000 }, { id: 'c', updated: old - 1000 }];
    const reader: OpenCodeReader = {
      listSessions: async () => refs,
      listMessages: async (id) => {
        if (id === 'b') throw new UpstreamError('boom', 503, true);
        return [message({})];
      },
    };
    const outcome = await syncOnce(store, reader, { now: NOW });
    expect(outcome.processed).toBe(1);
    expect(outcome.pending).toBe(2);
    expect(outcome.error).toBe('boom');
    expect(Object.keys(store.sessions)).toEqual(['a']);
  });

  test('a refusal for good skips that session until it changes', async () => {
    const store = emptyStore();
    const reader: OpenCodeReader = {
      listSessions: async () => [{ id: 'a', updated: NOW - 1000 }],
      listMessages: async () => { throw new UpstreamError('gone', 404, false); },
    };
    const first = await syncOnce(store, reader, { now: NOW });
    expect(first.error).toBeNull();
    expect(store.sessions['a']?.skipped).toBe('gone');
    const second = await syncOnce(store, reader, { now: NOW });
    expect(second.processed).toBe(0);
    expect(second.pending).toBe(0);
  });

  test('a failing session list leaves syncedAt untouched', async () => {
    const store = emptyStore();
    const reader: OpenCodeReader = { listSessions: async () => { throw new UpstreamError('down', null, true); }, listMessages: async () => [] };
    const outcome = await syncOnce(store, reader, { now: NOW });
    expect(outcome.listed).toBe(false);
    expect(store.syncedAt).toBeNull();
    expect(store.lastError).toBe('down');
  });
});

describe('OpenCode response shapes', () => {
  test('unwraps arrays and wrapped lists with a cursor', () => {
    expect(unwrapList([1, 2])).toEqual({ items: [1, 2], cursor: null });
    expect(unwrapList({ items: [1], cursor: 'abc' })).toEqual({ items: [1], cursor: 'abc' });
    expect(unwrapList({ nope: 1 })).toEqual({ items: [], cursor: null });
  });

  test('reads OpenCode 2: { data, cursor: { previous, next } }', () => {
    expect(unwrapList({ data: [1, 2], cursor: { previous: null, next: 'c2' } })).toEqual({ items: [1, 2], cursor: 'c2' });
    expect(unwrapList({ data: [1], cursor: { previous: 'p', next: null } })).toEqual({ items: [1], cursor: null });
  });

  test('the reader follows cursor.next through every page of sessions and of messages', async () => {
    const pages: Record<string, unknown> = {
      '/api/session': { data: [{ id: 'a', time: { updated: 1e12 } }], cursor: { previous: null, next: 'p2' } },
      '/api/session?cursor=p2': { data: [{ id: 'b', time: { updated: 1e12 + 1 } }], cursor: { previous: 'p1', next: 'p3' } },
      '/api/session?cursor=p3': { data: [{ id: 'c', time: { updated: 1e12 + 2 } }], cursor: { previous: 'p2', next: null } },
      '/api/session/a/message': { data: [{ n: 1 }], cursor: { next: 'm2' } },
      '/api/session/a/message?cursor=m2': { data: [{ n: 2 }], cursor: { next: null } },
    };
    const requested: string[] = [];
    const reader = createOpenCodeReader('http://oc.test', 'tok', async (url) => {
      const path = url.replace('http://oc.test', '');
      requested.push(path);
      const body = pages[path];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{}', { status: 404 });
    });
    expect((await reader.listSessions()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(await reader.listMessages('a')).toEqual([{ n: 1 }, { n: 2 }]);
    expect(requested).toHaveLength(5);
  });

  test('reads a session ref from time.updated, seconds or ISO', () => {
    expect(sessionRefOf({ id: 's', time: { updated: NOW } })).toEqual({ id: 's', updated: NOW, directory: null, agent: null, parent: null });
    expect(sessionRefOf({ id: 's', time: { updated: NOW / 1000 } })?.updated).toBe(Math.round(NOW));
    expect(sessionRefOf({ id: 's', time: { updated: '2026-11-26T12:00:00Z' } })?.updated).toBe(NOW);
    expect(sessionRefOf({ time: { updated: NOW } })).toBeNull();
    expect(sessionRefOf({ id: 's' })).toBeNull();
  });
});

describe('store file', () => {
  test('round-trips, writes 0600, keeps three years, sets a corrupt file aside', async () => {
    const dir = await mkdtempSafe();
    const path = join(dir, 'sub', 'store.json');
    const store = emptyStore();
    applySession(store, { id: 'a', updated: NOW }, [
      message({ cost: 2 }),
      message({ cost: 9, created: NOW - 70 * DAY_MS }), // no longer pruned at 60 days
      message({ cost: 1, created: NOW - 400 * DAY_MS }),
      message({ cost: 7, created: NOW - 1200 * DAY_MS }), // past three years
    ]);
    await saveStore(path, store, NOW);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const loaded = await loadStore(path, NOW);
    const keys = Object.keys(loaded.sessions['a']?.buckets ?? {}).sort();
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.startsWith(new Date(NOW - 1200 * DAY_MS).toISOString().slice(0, 10)))).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(4);
    expect((await readdir(join(dir, 'sub'))).some((f) => f.includes('.tmp-'))).toBe(false);

    await writeFile(path, '{not json');
    const fresh = await loadStore(path, NOW);
    expect(fresh.sessions).toEqual({});
    expect((await readdir(join(dir, 'sub'))).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  test('the size cap drops the oldest days first and keeps the session entries', () => {
    const store = emptyStore();
    const messages = Array.from({ length: 30 }, (_, i) => message({ created: NOW - i * DAY_MS, cost: 1 }));
    applySession(store, { id: 'a', updated: NOW }, messages);
    const full = JSON.stringify(store).length;
    const dropped = capStoreSize(store, Math.floor(full * 0.6));
    expect(dropped).toBeGreaterThan(0);
    const days = Object.keys(store.sessions['a']?.buckets ?? {}).map((k) => k.slice(0, 10)).sort();
    expect(days.length).toBe(30 - dropped);
    expect(days[days.length - 1]).toBe('2026-11-26'); // the newest day survives
    expect(JSON.stringify(store).length).toBeLessThanOrEqual(Math.floor(full * 0.6));
    expect(store.sessions['a']?.updated).toBe(NOW);
    expect(capStoreSize(store, 10 ** 9)).toBe(0);
  });
});

async function mkdtempSafe(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'provider-ledger-test-'));
}

describe('speed (N-1)', () => {
  test('3 000 sessions derive and answer /status well inside a second, cold', () => {
    const store = emptyStore();
    for (let i = 0; i < 3000; i += 1) {
      const messages = Array.from({ length: 6 }, (_, j) => message({ created: NOW - ((i % 60) * 86_400_000) - j * 1000, provider: i % 2 ? 'anthropic' : 'ollama', model: `m${i % 7}`, output: 100 + j, seconds: 3 + j }));
      applySession(store, { id: `s${i}`, updated: i, directory: `/work/customers/C${i % 12}` }, messages);
    }
    const started = performance.now();
    deriveLedger(store, NOW);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
