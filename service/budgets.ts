// Monthly caps per provider: the state of each, and the one place a cap is validated and stored.
import { canonicalProvider, providerName } from '../shared/format.ts';
import type { BalanceCard, BudgetResult, BudgetRow, BudgetState, Store } from '../shared/types.ts';
import type { LedgerView } from './ledger.ts';

/** A provider at this share of its cap shows as a warning. */
export const WARN_PERCENT = 80;
/** At this share it is over: an error row and the rail badge. */
export const OVER_PERCENT = 100;
/** A cap above this is a typo, not a budget. */
export const CAP_MAX_USD = 1_000_000;
const PROVIDER_ID_MAX = 100;

const toCents = (usd: number): number => Math.round(usd * 100);

/**
 * `< 80 %` ok, `≥ 80 %` warning, `≥ 100 %` error. Compared in whole cents, so $8.00 of $10.00
 * is exactly 80 % and a float such as 0.07 × 100 can never tip a boundary.
 */
export const budgetState = (spentUsd: number, capUsd: number | null | undefined): BudgetState => {
  if (capUsd === null || capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0) return 'none';
  const spent = toCents(Math.max(0, spentUsd)) * 100;
  const cap = toCents(capUsd);
  if (spent >= cap * OVER_PERCENT) return 'error';
  if (spent >= cap * WARN_PERCENT) return 'warning';
  return 'ok';
};

export const budgetShare = (spentUsd: number, capUsd: number | null | undefined): number | null => (
  capUsd === null || capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0 ? null : (Math.max(0, spentUsd) / capUsd) * 100
);

/**
 * One row per provider that has a cap, plus every provider the ledger holds that is billed per
 * reply (so a cap can be set from the panel). Spend is the "This month" period's, so the two
 * never disagree. Capped rows lead, most used first; the rest follow by month spend.
 */
export const buildBudgetRows = (view: LedgerView, caps: Record<string, number>, balances: BalanceCard[] = []): BudgetRow[] => {
  const monthSpend = new Map(view.periods.month.providers.map((p) => [p.provider, p.cost]));
  const included = new Set(view.periods.all.providers.filter((p) => p.subscription).map((p) => p.provider));
  const ids = new Set<string>(Object.keys(caps));
  for (const id of view.providerIds) if (!included.has(id)) ids.add(id);

  const balanceOf = (provider: string): string | null => {
    const card = balances.find((c) => c.account === canonicalProvider(provider));
    if (!card) return null;
    if (card.state === 'money') return card.headline;
    // A plan, not money: the busiest window says how much of it is gone.
    const busiest = card.state === 'windows' ? [...card.windows].sort((x, y) => y.used - x.used)[0] : undefined;
    return busiest ? `${Math.round(busiest.used)}% ${busiest.title.toLowerCase()}` : null;
  };

  const rows = [...ids].map((provider): BudgetRow => {
    const cap = caps[provider] ?? null;
    const spentUsd = monthSpend.get(provider) ?? 0;
    return {
      provider,
      name: providerName(provider),
      capUsd: cap,
      spentUsd,
      remainingUsd: cap === null ? null : Math.max(0, cap - spentUsd),
      share: budgetShare(spentUsd, cap),
      state: budgetState(spentUsd, cap),
      balance: balanceOf(provider),
    };
  });
  return rows.sort((a, b) => (
    Number(b.capUsd !== null) - Number(a.capUsd !== null)
    || (b.share ?? 0) - (a.share ?? 0)
    || b.spentUsd - a.spentUsd
    || (a.provider < b.provider ? -1 : 1)
  ));
};

/** Providers at or over 100 % of their cap: the rail badge, or null when there are none. */
export const badgeCount = (rows: BudgetRow[]): number | null => {
  const n = rows.filter((r) => r.state === 'error').length;
  return n > 0 ? n : null;
};

/**
 * Set or clear a provider's cap. `capUsd` must be a finite number above zero (a cap is in
 * dollars; the ledger holds USD only) or `null` to clear. A refusal leaves the store alone.
 */
export const setBudget = (store: Store, provider: unknown, capUsd: unknown): BudgetResult => {
  if (typeof provider !== 'string' || provider.trim() === '' || provider.length > PROVIDER_ID_MAX || provider.includes('|')) {
    return { ok: false, error: 'Name the provider the cap is for.' };
  }
  const id = provider.trim();
  if (capUsd === null) {
    delete store.budgets[id];
    return { ok: true, capUsd: null };
  }
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd)) {
    return { ok: false, error: 'A cap is a number of dollars, such as 25 or 12.50.' };
  }
  if (capUsd <= 0) return { ok: false, error: 'A cap must be more than $0. Clear the field to remove the cap.' };
  const rounded = toCents(capUsd) / 100;
  if (rounded <= 0) return { ok: false, error: 'A cap must be at least $0.01.' };
  if (rounded > CAP_MAX_USD) return { ok: false, error: `A cap above $${CAP_MAX_USD.toLocaleString('en-US')} looks like a typo.` };
  store.budgets[id] = rounded;
  return { ok: true, capUsd: rounded };
};
