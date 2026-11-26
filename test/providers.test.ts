import { describe, expect, test } from 'bun:test';
import { guestStatusViewSchema, quotaProviderSchemasV1 } from '@openchamber/sdk/schemas';
import type { QuotaProviderCredential } from '@openchamber/sdk';

import { deriveLedger, applySession, emptyStore } from '../service/ledger.ts';
import type { FetchFn } from '../service/opencode.ts';
import {
  parseBilling,
  parseDeepSeekBalance,
  parseGoInference,
  parseGoStatus,
  parseOllamaBalance,
  parseOllamaUsage,
  readOpenCodeGo,
  readOpenCodeZen,
  readOllama,
  refreshProviders,
  snapshotOf,
} from '../service/providers.ts';
import { buildQuotaData } from '../service/quota.ts';
import { buildStatusView } from '../service/status.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const api = (key: string): QuotaProviderCredential => ({ type: 'api', key });

const goStatus = {
  product: 'go',
  access: {
    meters: {
      fiveHour: { limitMicroCents: '1200000000', usedMicroCents: '300000000', resetsAt: '2026-11-26T15:00:00Z' },
      week: { limitMicroCents: '3000000000', usedMicroCents: '2100000000', resetsAt: '2026-11-30T00:00:00Z' },
      month: { limitMicroCents: '6000000000', usedMicroCents: '0', resetsAt: '2026-12-01T00:00:00Z' },
    },
  },
};

describe('parseGoStatus', () => {
  test('turns the three meters into windows', () => {
    const parsed = parseGoStatus(goStatus);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.planLabel).toBe('Go');
    expect(parsed.value.windows['5h']?.usedPercent).toBeCloseTo(25, 10);
    expect(parsed.value.windows['5h']?.windowSeconds).toBe(18000);
    expect(parsed.value.windows['5h']?.resetAt).toBe(Date.parse('2026-11-26T15:00:00Z'));
    expect(parsed.value.windows['weekly']?.usedPercent).toBeCloseTo(70, 10);
    expect(parsed.value.windows['monthly']?.usedPercent).toBe(0);
  });

  test('accepts go-plus and go-teams, refuses other products', () => {
    expect(parseGoStatus({ ...goStatus, product: 'go-plus' }).ok).toBe(true);
    const other = parseGoStatus({ ...goStatus, product: 'zen' });
    expect(other.ok).toBe(false);
  });

  test('skips a meter with a zero limit rather than dividing by it', () => {
    const parsed = parseGoStatus({ product: 'go', access: { meters: { fiveHour: { limitMicroCents: '0', usedMicroCents: '0', resetsAt: '2026-11-26T15:00:00Z' }, week: goStatus.access.meters.week } } });
    expect(parsed.ok && Object.keys(parsed.value.windows)).toEqual(['weekly']);
  });

  test('skips a missing meter, a missing limit, an unreadable amount and a meter with no reset; the rest still count', () => {
    const { fiveHour, week, month } = goStatus.access.meters;
    const parsed = parseGoStatus({
      product: 'go',
      access: { meters: { fiveHour: { usedMicroCents: '1', resetsAt: fiveHour.resetsAt }, week: { ...week, usedMicroCents: 'lots' }, month } },
    });
    expect(parsed.ok && Object.keys(parsed.value.windows)).toEqual(['monthly']);
    const noReset = parseGoStatus({ product: 'go', access: { meters: { fiveHour: { limitMicroCents: '10', usedMicroCents: '5' }, week } } });
    expect(noReset.ok && Object.keys(noReset.value.windows)).toEqual(['weekly']);
    // used above limit clamps to 100
    const over = parseGoStatus({ product: 'go', access: { meters: { month: { ...month, usedMicroCents: '9000000000' } } } });
    expect(over.ok && over.value.windows['monthly']?.usedPercent).toBe(100);
  });

  test('a Go product with no access block is an absent subscription', () => {
    const parsed = parseGoStatus({ product: 'go' });
    expect(parsed).toMatchObject({ ok: false });
    expect(!parsed.ok && parsed.error).toContain('No active OpenCode Go subscription');
  });

  test('fails on an empty or malformed body', () => {
    expect(parseGoStatus(null).ok).toBe(false);
    expect(parseGoStatus({ product: 'go' }).ok).toBe(false);
    expect(parseGoStatus({ product: 'go', access: { meters: {} } }).ok).toBe(false);
  });
});

describe('parseBilling and parseGoInference', () => {
  test('1e8 micro-cents is one dollar', () => {
    expect(parseBilling({ availableMicroCents: '250000000' })).toEqual({ usedPercent: null, valueLabel: '$2.50' });
    expect(parseBilling({ nope: 1 })).toBeNull();
    expect(parseBilling('x')).toBeNull();
  });

  test('inference usage fallback', () => {
    const parsed = parseGoInference({ usage: { rolling: { percent: 12.5, resetsAt: '2026-11-26T15:00:00Z' }, weekly: { percent: 40 }, monthly: { percent: 5 } } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.windows['5h']?.usedPercent).toBe(12.5);
    expect(parsed.value.windows['weekly']?.usedPercent).toBe(40);
    expect(parseGoInference({}).ok).toBe(false);
  });
});

describe('parseOllamaBalance', () => {
  test('included allowance becomes a monthly window, purchased a balance', () => {
    const parsed = parseOllamaBalance({
      included: { balance_usd: 15, allowance_usd: 20, period: { until: '2026-12-01T00:00:00Z' } },
      purchased: { balance_usd: 4.5 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const monthly = parsed.value.windows['monthly'];
    expect(monthly?.usedPercent).toBe(25);
    expect(monthly?.valueLabel).toBe('$15.00 left');
    expect(monthly?.resetAt).toBe(Date.parse('2026-12-01T00:00:00Z'));
    expect(monthly?.value).toEqual({ kind: 'spend', spent: 5, limit: 20 });
    expect(parsed.value.windows['credits_balance']?.valueLabel).toBe('$4.50');
  });

  test('purchased is left out at zero', () => {
    const parsed = parseOllamaBalance({ included: { balance_usd: '3', allowance_usd: '10' }, purchased: { balance_usd: 0 } });
    expect(parsed.ok && Object.keys(parsed.value.windows)).toEqual(['monthly']);
  });

  test('legacy session and weekly report what remains', () => {
    const parsed = parseOllamaBalance({ session: { remaining_percent: 80 }, weekly: { remaining_percent: 35.5 } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.windows['5h']?.usedPercent).toBe(20);
    expect(parsed.value.windows['weekly']?.usedPercent).toBe(64.5);
  });

  test('nothing readable is a failure, not an empty success', () => {
    expect(parseOllamaBalance({}).ok).toBe(false);
    expect(parseOllamaBalance({ included: { balance_usd: 1, allowance_usd: 0 } }).ok).toBe(false);
  });
});

describe('parseOllamaUsage', () => {
  test('reads a list under models, sorted by money', () => {
    const usage = parseOllamaUsage({ range: '7d', models: [{ model: 'a', usage_usd: 1, requests: 3, tokens: 100 }, { model: 'b', usage_usd: 4.2, requests: 9, tokens: 900 }] }, NOW);
    expect(usage?.models.map((m) => m.model)).toEqual(['b', 'a']);
    expect(usage?.models[0]).toEqual({ model: 'b', usageUsd: 4.2, requests: 9, tokens: 900 });
  });

  test('reads a map keyed by model; unknown shape is null', () => {
    expect(parseOllamaUsage({ data: { qwen: { usage_usd: 2 } } }, NOW)?.models[0]?.model).toBe('qwen');
    expect(parseOllamaUsage({ hello: 1 }, NOW)).toBeNull();
  });
});

describe('parseDeepSeekBalance', () => {
  test('single currency is credits_balance', () => {
    const parsed = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.3', granted_balance: '0', topped_up_balance: '12.3' }] });
    expect(parsed.ok && parsed.value.windows).toEqual({ credits_balance: { usedPercent: null, valueLabel: '$12.30' } });
  });

  test('USD first when there are several currencies', () => {
    const parsed = parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY', total_balance: '50' }, { currency: 'USD', total_balance: '7' }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.windows['credits_balance']?.valueLabel).toBe('$7.00');
    expect(parsed.value.windows['credits_balance_cny']?.valueLabel).toBe('¥50.00');
  });

  test('missing balance_infos fails', () => {
    expect(parseDeepSeekBalance({}).ok).toBe(false);
  });
});

/** A fetch that answers per URL and records every call. */
const stubFetch = (routes: Record<string, { status: number; body?: unknown } | 'throw'>): { fetchFn: FetchFn; calls: Array<{ url: string; headers: Record<string, string> }> } => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    if (!route) return new Response('{}', { status: 404 });
    if (route === 'throw') throw new Error('socket hang up with sk-secret-123 inside');
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, calls };
};

const GO = 'https://opencode.ai/console/api/go/status';
const BILLING = 'https://opencode.ai/console/api/billing/status';
const INFER = 'https://opencode.ai/inference/go/v1/usage';
const OLLAMA_BAL = 'https://ollama.com/api/balance';
const OLLAMA_USE = 'https://ollama.com/api/usage?range=7d&group_by=model';

describe('provider readers', () => {
  test('Go: status plus billing, key sent as bearer, no org header', async () => {
    const { fetchFn, calls } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 200, body: { availableMicroCents: '500000000' } } });
    const result = await readOpenCodeGo(api('sk-go'), fetchFn);
    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('Go');
    expect(result.windows['credits_balance']?.valueLabel).toBe('$5.00');
    expect(Object.keys(result.windows).sort()).toEqual(['5h', 'credits_balance', 'monthly', 'weekly']);
    expect(calls.every((c) => c.headers['Authorization'] === 'Bearer sk-go' && !('x-org-id' in c.headers))).toBe(true);
  });

  test('Go: a 403 on billing drops that row silently', async () => {
    const { fetchFn } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 403 } });
    const result = await readOpenCodeGo(api('k'), fetchFn);
    expect(result.ok).toBe(true);
    expect(result.windows['credits_balance']).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test('Go: falls back to the inference usage when the Console read fails', async () => {
    const { fetchFn, calls } = stubFetch({
      [GO]: { status: 500 },
      [BILLING]: { status: 500 },
      [INFER]: { status: 200, body: { usage: { rolling: { percent: 9 }, weekly: { percent: 18 }, monthly: { percent: 27 } } } },
    });
    const result = await readOpenCodeGo(api('k'), fetchFn);
    expect(result.ok).toBe(true);
    expect(result.windows['weekly']?.usedPercent).toBe(18);
    expect(calls.find((c) => c.url === INFER)?.headers['x-opencode-session']).toBe('openchamber-provider-ledger');
  });

  test('Go: both reads failing is a failure with no key in it', async () => {
    const { fetchFn } = stubFetch({ [GO]: 'throw', [BILLING]: 'throw', [INFER]: { status: 401 } });
    const result = await readOpenCodeGo(api('sk-secret-123'), fetchFn);
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBeDefined();
  });

  const oauth = (over: Partial<{ access: string; refresh: string; expires: number; orgID: string }> = {}): QuotaProviderCredential => ({
    type: 'oauth', access: 'tok-access-1', refresh: 'ref-1', expires: NOW + 3_600_000, orgID: 'wrk_ABC123', server: 'https://opencode.ai/console', accountId: 'acc', ...over,
  });

  test('Go with a Console sign-in: bearer plus x-org-id on both requests, meters become windows, billing becomes dollars', async () => {
    const { fetchFn, calls } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 200, body: { availableMicroCents: '788000000' } } });
    const result = await readOpenCodeGo(oauth(), fetchFn, NOW);
    expect(result).toMatchObject({ ok: true, configured: true, planLabel: 'Go' });
    expect(Object.keys(result.windows).sort()).toEqual(['5h', 'credits_balance', 'monthly', 'weekly']);
    expect(result.windows['5h']?.usedPercent).toBeCloseTo(25, 10);
    expect(result.windows['credits_balance']?.valueLabel).toBe('$7.88');
    expect(calls.map((c) => c.url).sort()).toEqual([BILLING, GO]);
    expect(calls.every((c) => c.headers['Authorization'] === 'Bearer tok-access-1' && c.headers['x-org-id'] === 'wrk_ABC123')).toBe(true);
  });

  test('Go with a Console sign-in: a failing billing read drops the row, never the card, never $0.00', async () => {
    const { fetchFn } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: 'throw' });
    const result = await readOpenCodeGo(oauth(), fetchFn, NOW);
    expect(result.ok).toBe(true);
    expect(result.windows['credits_balance']).toBeUndefined();
    const garbled = await readOpenCodeGo(oauth(), stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 200, body: { availableMicroCents: 'x' } } }).fetchFn, NOW);
    expect(garbled.windows['credits_balance']).toBeUndefined();
  });

  test('Go with a Console sign-in: a meter with no reset time is skipped, not the card', async () => {
    const body = { product: 'go-plus', access: { meters: { ...goStatus.access.meters, fiveHour: { limitMicroCents: '10', usedMicroCents: '5' } } } };
    const result = await readOpenCodeGo(oauth(), stubFetch({ [GO]: { status: 200, body }, [BILLING]: { status: 403 } }).fetchFn, NOW);
    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('Go Plus');
    expect(Object.keys(result.windows).sort()).toEqual(['monthly', 'weekly']);
  });

  test('an expired Console sign-in is the sign-in message with no request made, never a zero balance', async () => {
    const { fetchFn, calls } = stubFetch({});
    for (const read of [readOpenCodeGo, readOpenCodeZen]) {
      const result = await read(oauth({ expires: NOW - 1 }), fetchFn, NOW);
      expect(result).toMatchObject({ ok: false, configured: true, needsSignIn: true, windows: {} });
      expect(result.error).toBe('Your OpenCode sign-in has expired — sign in again on OpenCode Console in Providers.');
    }
    expect(calls).toHaveLength(0);
  });

  test('a 401 or 403 on a Console sign-in is the same sign-in message', async () => {
    const go = await readOpenCodeGo(oauth(), stubFetch({ [GO]: { status: 401 }, [BILLING]: { status: 401 } }).fetchFn, NOW);
    expect(go).toMatchObject({ ok: false, needsSignIn: true });
    expect(go.error).toContain('sign-in has expired');
    const zen = await readOpenCodeZen(oauth(), stubFetch({ [BILLING]: { status: 403 } }).fetchFn, NOW);
    expect(zen).toMatchObject({ ok: false, needsSignIn: true });
  });

  test('a sign-in with no organization is an error, not a request without the header', async () => {
    const { fetchFn, calls } = stubFetch({});
    const result = await readOpenCodeGo(oauth({ orgID: '' }), fetchFn, NOW);
    expect(result.ok).toBe(false);
    expect(result.needsSignIn).toBeUndefined();
    expect(result.error).toContain('organization');
    expect(calls).toHaveLength(0);
  });

  test('Zen with a Console sign-in reads the balance with the organization header', async () => {
    const { fetchFn, calls } = stubFetch({ [BILLING]: { status: 200, body: { availableMicroCents: '250000000' } } });
    const result = await readOpenCodeZen(oauth(), fetchFn, NOW);
    expect(result).toMatchObject({ ok: true, windows: { credits_balance: { valueLabel: '$2.50' } } });
    expect(calls[0]?.headers['x-org-id']).toBe('wrk_ABC123');
  });

  test('Zen: balance, and the no-API message on 401/403', async () => {
    const ok = await readOpenCodeZen(api('k'), stubFetch({ [BILLING]: { status: 200, body: { availableMicroCents: '100000000' } } }).fetchFn);
    expect(ok.windows['credits_balance']?.valueLabel).toBe('$1.00');
    const denied = await readOpenCodeZen(api('k'), stubFetch({ [BILLING]: { status: 401 } }).fetchFn);
    expect(denied).toMatchObject({ ok: false, configured: true, error: 'OpenCode Zen has no balance API for API keys.' });
  });

  test('Ollama: balance and usage, one request of each', async () => {
    const { fetchFn, calls } = stubFetch({
      [OLLAMA_BAL]: { status: 200, body: { included: { balance_usd: 5, allowance_usd: 20 } } },
      [OLLAMA_USE]: { status: 200, body: { models: [{ model: 'q', usage_usd: 1 }] } },
    });
    const result = await readOllama(api('k'), fetchFn, NOW);
    expect(result.ok).toBe(true);
    expect(result.ollamaUsage?.models[0]?.model).toBe('q');
    expect(calls.map((c) => c.url)).toEqual([OLLAMA_BAL, OLLAMA_USE]);
  });

  test('Ollama: a failing usage read never fails the card; a 429 balance does, with a message', async () => {
    const soft = await readOllama(api('k'), stubFetch({ [OLLAMA_BAL]: { status: 200, body: { included: { balance_usd: 5, allowance_usd: 20 } } }, [OLLAMA_USE]: { status: 500 } }).fetchFn, NOW);
    expect(soft.ok).toBe(true);
    expect(soft.ollamaUsage).toBeNull();
    const limited = await readOllama(api('k'), stubFetch({ [OLLAMA_BAL]: { status: 429 } }).fetchFn, NOW);
    expect(limited.ok).toBe(false);
    expect(limited.error).toContain('rate limit');
  });
});

describe('refreshProviders', () => {
  test('ollama and ollama-cloud on one key cost one read; anthropic needs no request', async () => {
    const { fetchFn, calls } = stubFetch({
      [OLLAMA_BAL]: { status: 200, body: { included: { balance_usd: 5, allowance_usd: 20 } } },
      [OLLAMA_USE]: { status: 200, body: { models: [] } },
    });
    const out = await refreshProviders({ 'ollama-cloud': api('same'), ollama: api('same'), anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }, fetchFn, NOW);
    expect(calls).toHaveLength(2);
    expect(out.find((o) => o.provider === 'ollama')?.duplicateOf).toBe('ollama-cloud');
    expect(out.find((o) => o.provider === 'anthropic')?.result).toMatchObject({ ok: true, configured: true, windows: {}, error: 'Anthropic has no balance API; see the ledger for spend.' });
  });

  test('the OpenCode Console sign-in on `opencode` also reads Go, when there is no credential for opencode-go', async () => {
    const { fetchFn, calls } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 200, body: { availableMicroCents: '100000000' } } });
    const signIn: QuotaProviderCredential = { type: 'oauth', access: 'tok', refresh: 'r', expires: NOW + 1000, orgID: 'wrk_X1', server: 'https://opencode.ai/console' };
    const out = await refreshProviders({ opencode: signIn }, fetchFn, NOW);
    expect(out.map((o) => o.provider).sort()).toEqual(['opencode', 'opencode-go']);
    expect(out.find((o) => o.provider === 'opencode-go')?.result.planLabel).toBe('Go');
    expect(out.find((o) => o.provider === 'opencode')?.result.windows['credits_balance']?.valueLabel).toBe('$1.00');
    expect(calls.some((c) => c.url === GO)).toBe(true);
  });

  test('an API key on `opencode` that Go refuses says nothing about Go', async () => {
    const { fetchFn } = stubFetch({ [GO]: { status: 403 }, [BILLING]: { status: 200, body: { availableMicroCents: '1' } }, [INFER]: { status: 403 } });
    const out = await refreshProviders({ opencode: api('zen-only') }, fetchFn, NOW);
    expect(out.map((o) => o.provider)).toEqual(['opencode']);
  });

  test('console-ollama-cloud on the same key costs no extra read', async () => {
    const { fetchFn, calls } = stubFetch({
      [OLLAMA_BAL]: { status: 200, body: { included: { balance_usd: 5, allowance_usd: 20 } } },
      [OLLAMA_USE]: { status: 200, body: { models: [] } },
    });
    const out = await refreshProviders({ ollama: api('same'), 'console-ollama-cloud': api('same') }, fetchFn, NOW);
    expect(calls).toHaveLength(2);
    expect(out.find((o) => o.provider === 'console-ollama-cloud')?.duplicateOf).toBe('ollama');
  });

  test('an unknown provider id is ignored and a throwing read becomes a failure without the key', async () => {
    const { fetchFn } = stubFetch({ [OLLAMA_BAL]: 'throw' });
    const out = await refreshProviders({ mystery: api('x'), ollama: api('sk-secret-123') }, fetchFn, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.result.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sk-secret-123');
  });
});

describe('quota card and status rows match the host schemas', () => {
  const store = emptyStore();
  applySession(store, { id: 's', updated: NOW }, [
    { info: { role: 'assistant', providerID: 'opencode-go', modelID: 'glm', cost: 1.234, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 5000, completed: NOW - 1000 } } },
  ]);
  store.syncedAt = NOW;

  test('partial failure keeps the card and sets no error', async () => {
    const { fetchFn } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 403 }, 'https://api.deepseek.com/user/balance': { status: 500 } });
    const refreshed = await refreshProviders({ 'opencode-go': api('a'), deepseek: api('b') }, fetchFn, NOW);
    const data = buildQuotaData(deriveLedger(store, NOW), store, refreshed);
    expect(data.ok).toBe(true);
    expect(data.error).toBeUndefined();
    expect(data.usage?.windows['today']).toEqual({ usedPercent: null, windowSeconds: null, valueLabel: '$1.23 spent', value: { kind: 'spend', spent: 1.234, limit: null } });
    expect(Object.keys(data.usage?.windows ?? {})).toContain('OpenCode Go · 5h');
    expect(Object.keys(data.usage?.windows ?? {}).some((k) => k.startsWith('DeepSeek'))).toBe(false);
    expect(quotaProviderSchemasV1.data['usage.read'].safeParse(data).success).toBe(true);
  });

  test('every provider failing sets the error', async () => {
    const { fetchFn } = stubFetch({ [OLLAMA_BAL]: { status: 401 } });
    const refreshed = await refreshProviders({ ollama: api('a') }, fetchFn, NOW);
    const data = buildQuotaData(deriveLedger(store, NOW), store, refreshed);
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Ollama');
    expect(quotaProviderSchemasV1.data['usage.read'].safeParse(data).success).toBe(true);
  });

  test('before the first sync the card carries no invented spend', () => {
    const data = buildQuotaData(deriveLedger(emptyStore(), NOW), emptyStore(), []);
    expect(data.usage?.windows).toEqual({});
    expect(quotaProviderSchemasV1.data['usage.read'].safeParse(data).success).toBe(true);
  });

  test('status rows parse with the host schema, with and without a sync', async () => {
    const { fetchFn } = stubFetch({ [GO]: { status: 200, body: goStatus }, [BILLING]: { status: 403 }, [OLLAMA_BAL]: { status: 200, body: { included: { balance_usd: 5, allowance_usd: 20 } } }, [OLLAMA_USE]: { status: 200, body: {} } });
    const refreshed = await refreshProviders({ 'opencode-go': api('a'), 'ollama-cloud': api('b') }, fetchFn, NOW);
    const withBalances = { ...store, balances: Object.fromEntries(refreshed.map((r) => [r.provider, snapshotOf(r.provider, r.result, NOW)])) };
    const view = buildStatusView(deriveLedger(withBalances, NOW), withBalances, NOW);
    expect(guestStatusViewSchema.safeParse(view).success).toBe(true);
    expect(view.rows.map((r) => r.id)).toEqual(['today', 'week', 'top', 'p-opencode-go', 'p-ollama-cloud']);
    const ollama = view.rows.find((r) => r.id === 'p-ollama-cloud');
    expect(ollama && 'value' in ollama && ollama.value).toBe('$5.00 left');

    const never = buildStatusView(deriveLedger(emptyStore(), NOW), emptyStore(), NOW);
    expect(guestStatusViewSchema.safeParse(never).success).toBe(true);
    expect(never.rows[0]).toMatchObject({ kind: 'note', id: 'not-synced' });
  });
});
