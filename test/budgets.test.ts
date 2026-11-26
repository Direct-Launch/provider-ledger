import { describe, expect, test } from 'bun:test';
import { guestStatusViewSchema } from '@openchamber/sdk/schemas';

import { badgeCount, budgetShare, budgetState, buildBudgetRows, setBudget } from '../service/budgets.ts';
import { deriveLedger, emptyStore } from '../service/ledger.ts';
import { buildStatusView } from '../service/status.ts';
import { parseCap, shareText } from '../shared/format.ts';
import { msg, storeOf } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

describe('budgetState thresholds', () => {
  // A $1000 cap makes 79.9, 80, 99.9 and 100 % whole dollars.
  test.each([
    [799, 'ok'],
    [800, 'warning'],
    [999, 'warning'],
    [1000, 'error'],
    [1000.01, 'error'],
    [0, 'ok'],
  ] as const)('$%d of $1000 is %s', (spent, state) => {
    expect(budgetState(spent, 1000)).toBe(state);
  });

  test('79.9 / 80 / 99.9 / 100 % by share', () => {
    expect(budgetShare(7.99, 10)).toBeCloseTo(79.9, 9);
    expect(budgetState(7.99, 10)).toBe('ok');
    expect(budgetState(8, 10)).toBe('warning');
    expect(budgetState(9.99, 10)).toBe('warning');
    expect(budgetState(10, 10)).toBe('error');
  });

  test('a float that tips a boundary does not (0.07 × 100 is not 7)', () => {
    expect(budgetState(0.56, 0.7)).toBe('warning'); // exactly 80 %
    expect(budgetState(0.55, 0.7)).toBe('ok');
    expect(budgetState(2.4, 3)).toBe('warning');
  });

  test('no cap, or a nonsense cap, is none', () => {
    expect(budgetState(5, null)).toBe('none');
    expect(budgetState(5, undefined)).toBe('none');
    expect(budgetState(5, 0)).toBe('none');
    expect(budgetState(5, -1)).toBe('none');
    expect(budgetState(5, Number.NaN)).toBe('none');
    expect(budgetShare(5, null)).toBeNull();
  });
});

describe('setBudget', () => {
  test('stores a positive number in cents and clears with null', () => {
    const store = emptyStore();
    expect(setBudget(store, 'anthropic', 25)).toEqual({ ok: true, capUsd: 25 });
    expect(setBudget(store, 'ollama', 12.345)).toEqual({ ok: true, capUsd: 12.35 });
    expect(store.budgets).toEqual({ anthropic: 25, ollama: 12.35 });
    expect(setBudget(store, 'anthropic', null)).toEqual({ ok: true, capUsd: null });
    expect(store.budgets).toEqual({ ollama: 12.35 });
  });

  test.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.004, '10', undefined, {}, [[3]], true].map((v) => (Array.isArray(v) ? [v[0]] : [v])))('refuses %p and leaves the stored cap alone', (bad) => {
    const store = emptyStore();
    store.budgets.anthropic = 25;
    const result = setBudget(store, 'anthropic', bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
    expect(store.budgets).toEqual({ anthropic: 25 });
  });

  test('refuses a typo-sized cap and an unnamed provider', () => {
    const store = emptyStore();
    expect(setBudget(store, 'anthropic', 5_000_000).ok).toBe(false);
    expect(setBudget(store, '', 10).ok).toBe(false);
    expect(setBudget(store, 7, 10).ok).toBe(false);
    expect(setBudget(store, 'a|b', 10).ok).toBe(false);
    expect(store.budgets).toEqual({});
  });
});

describe('parseCap (the panel field)', () => {
  test('dollars, with or without the sign and thousands commas; empty clears', () => {
    expect(parseCap('25')).toEqual({ ok: true, value: 25 });
    expect(parseCap(' $12.50 ')).toEqual({ ok: true, value: 12.5 });
    expect(parseCap('1,250')).toEqual({ ok: true, value: 1250 });
    expect(parseCap('.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseCap('')).toEqual({ ok: true, value: null });
    expect(parseCap('   ')).toEqual({ ok: true, value: null });
  });
  test.each(['0', '$0', '-5', 'abc', '1e3', 'Infinity', '12.3.4', 'NaN', '£20', '€20', '20 EUR', 'gbp 20'])('refuses %s with a reason', (text) => {
    const result = parseCap(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toBe('');
  });
});

describe('month-to-date and the rows', () => {
  const store = storeOf([
    { id: 'a', directory: '/x/X', messages: [
      msg(Date.UTC(2026, 10, 26, 1), 'anthropic', 's', 8.9),
      msg(Date.UTC(2026, 10, 3, 1), 'anthropic', 's', 0.5),
      msg(Date.UTC(2026, 9, 31, 23, 59), 'anthropic', 's', 100), // last month: not counted
      msg(Date.UTC(2026, 10, 26, 2), 'ollama', 'q', 3),
      msg(Date.UTC(2026, 10, 26, 3), 'opencode-go', 'glm', 0),
    ] },
  ]);
  const view = deriveLedger(store, NOW);

  test('month spend is the "This month" period, UTC, and no cap means no state', () => {
    const rows = buildBudgetRows(view, {});
    const anthropic = rows.find((r) => r.provider === 'anthropic');
    expect(anthropic?.spentUsd).toBeCloseTo(9.4, 9);
    expect(anthropic?.spentUsd).toBe(view.periods.month.providers.find((p) => p.provider === 'anthropic')?.cost);
    expect(anthropic?.state).toBe('none');
    expect(anthropic?.capUsd).toBeNull();
    expect(anthropic?.remainingUsd).toBeNull();
  });

  test('a cap gives share, remaining, and sorts capped providers first', () => {
    const rows = buildBudgetRows(view, { anthropic: 10, ollama: 100 });
    expect(rows.map((r) => r.provider)).toEqual(['anthropic', 'ollama', 'opencode-go']);
    expect(rows[0]).toMatchObject({ capUsd: 10, state: 'warning' });
    expect(rows[0]?.share).toBeCloseTo(94, 9);
    expect(rows[0]?.remainingUsd).toBeCloseTo(0.6, 9);
    expect(rows[1]?.state).toBe('ok');
  });

  test('plan-included providers get no row unless capped', () => {
    expect(buildBudgetRows(view, {}).some((r) => r.provider === 'opencode-go')).toBe(true); // no plan windows known: billed per reply
    const planned = storeOf([{ id: 'a', directory: null, messages: [msg(NOW - 1000, 'opencode-go', 'glm', 0), msg(NOW - 1000, 'anthropic', 's', 1)] }]);
    planned.balances['opencode-go'] = { provider: 'opencode-go', fetchedAt: NOW, ok: true, configured: true, windows: { weekly: { usedPercent: 20, windowSeconds: null } } };
    const planView = deriveLedger(planned, NOW);
    expect(buildBudgetRows(planView, {}).map((r) => r.provider)).toEqual(['anthropic']);
    expect(buildBudgetRows(planView, { 'opencode-go': 5 }).map((r) => r.provider).sort()).toEqual(['anthropic', 'opencode-go']);
  });

  test('a cap on a provider with no spend still shows', () => {
    const rows = buildBudgetRows(view, { deepseek: 5 });
    const deepseek = rows.find((r) => r.provider === 'deepseek');
    expect(deepseek).toMatchObject({ spentUsd: 0, remainingUsd: 5, state: 'ok' });
  });

  test('a balance that was not read reads null (the panel draws a dash)', () => {
    expect(buildBudgetRows(view, { anthropic: 10 }, [])[0]?.balance).toBeNull();
    const rows = buildBudgetRows(view, { anthropic: 10 }, [{
      account: 'anthropic', name: 'Anthropic', state: 'failed', planLabel: null, headline: null, headlineNote: null, windows: [], note: 'x', fetchedAt: 1,
    }]);
    expect(rows[0]?.balance).toBeNull();
    expect(rows[0]).toMatchObject({ spentUsd: expect.any(Number), capUsd: 10 });
  });

  test('the rail badge counts providers at or over 100 %, null when none', () => {
    expect(badgeCount(buildBudgetRows(view, { anthropic: 10, ollama: 100 }))).toBeNull(); // 94 % and 3 %
    expect(badgeCount(buildBudgetRows(view, { anthropic: 9.4, ollama: 3 }))).toBe(2);
    expect(badgeCount(buildBudgetRows(view, { anthropic: 9.4, ollama: 100 }))).toBe(1);
    expect(badgeCount([])).toBeNull();
  });
});

describe('Work Status rows', () => {
  const store = storeOf([{ id: 'a', directory: '/x/X', messages: [msg(NOW - 1000, 'anthropic', 's', 8.9), msg(NOW - 2000, 'ollama', 'q', 10.02)] }]);

  test('89 % of a cap is a warning row naming the cap and the share; 10.02 of 10 is an error row', () => {
    store.budgets = { anthropic: 10, ollama: 10 };
    const status = buildStatusView(deriveLedger(store, NOW), store, NOW);
    expect(guestStatusViewSchema.safeParse(status).success).toBe(true);
    const warn = status.rows.find((r) => r.id === 'cap-p-anthropic');
    const over = status.rows.find((r) => r.id === 'cap-p-ollama');
    expect(warn).toMatchObject({ kind: 'line', dot: 'warning', valueTone: 'warning', content: { kind: 'bar', tone: 'warning' } });
    expect(warn && 'value' in warn ? warn.value : '').toBe('$8.90 of $10.00 · 89%');
    expect(over).toMatchObject({ kind: 'line', dot: 'error', valueTone: 'error', content: { kind: 'bar', value: 100, tone: 'error' } });
    expect(over && 'value' in over ? over.value : '').toBe('$10.02 of $10.00 · 100%');
    // The alerts lead the section.
    expect(status.rows[0]?.id.startsWith('cap-')).toBe(true);
  });

  test('a provider under 80 %, or with no cap, adds no row', () => {
    store.budgets = { anthropic: 11.1, ollama: 100 }; // 80.18 % -> warning, 10 %
    let status = buildStatusView(deriveLedger(store, NOW), store, NOW);
    expect(status.rows.filter((r) => r.id.startsWith('cap-')).map((r) => r.id)).toEqual(['cap-p-anthropic']);
    store.budgets = { anthropic: 12 }; // 74 %
    status = buildStatusView(deriveLedger(store, NOW), store, NOW);
    expect(status.rows.some((r) => r.id.startsWith('cap-'))).toBe(false);
    store.budgets = {};
    status = buildStatusView(deriveLedger(store, NOW), store, NOW);
    expect(status.rows.some((r) => r.id.startsWith('cap-'))).toBe(false);
  });

  test('while history is re-read the tooltip says the figure may be higher', () => {
    store.budgets = { anthropic: 10 };
    store.rebuilding = true;
    store.syncedAt = NOW;
    store.pending = 12;
    const status = buildStatusView(deriveLedger(store, NOW), store, NOW);
    const row = status.rows.find((r) => r.id === 'cap-p-anthropic');
    expect(row && 'tooltip' in row ? row.tooltip : '').toContain('re-read');
    expect(status.rows.find((r) => r.id === 'backfill')).toMatchObject({ kind: 'note' });
    expect(guestStatusViewSchema.safeParse(status).success).toBe(true);
  });
});

describe('balance text on a budget row and share text', () => {
  test('a plan reads as its busiest window; money as its headline', () => {
    const store = storeOf([{ id: 'a', directory: null, messages: [msg(NOW - 1000, 'ollama', 'q', 2), msg(NOW - 1000, 'deepseek', 'chat', 1)] }]);
    const view = deriveLedger(store, NOW);
    const card = (over: object) => ({ account: 'x', name: 'X', state: 'none', planLabel: null, headline: null, headlineNote: null, windows: [], note: null, fetchedAt: 1, ...over }) as any;
    const rows = buildBudgetRows(view, {}, [
      card({ account: 'ollama-cloud', state: 'windows', windows: [{ name: '5h', title: '5h', used: 12, detail: '', resetAt: null }, { name: 'weekly', title: 'Weekly', used: 62.6, detail: '', resetAt: null }] }),
      card({ account: 'deepseek', state: 'money', headline: '$7.88' }),
    ]);
    expect(rows.find((r) => r.provider === 'ollama')?.balance).toBe('63% weekly');
    expect(rows.find((r) => r.provider === 'deepseek')?.balance).toBe('$7.88');
  });

  test('a sliver of share is <1%, never 0%', () => {
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.2)).toBe('<1%');
    expect(shareText(0.5)).toBe('1%');
    expect(shareText(37.4)).toBe('37%');
    expect(shareText(null)).toBe('—');
  });
});
