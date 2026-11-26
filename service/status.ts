// The Work Status section the app draws itself: a few rows, at most 16.
import type { GuestStatusRow, GuestStatusTone, GuestStatusView } from '@openchamber/sdk';
import type { QuotaProviderWindow } from '@openchamber/sdk';

import { DASH, ago, canonicalProvider, compact, money, percent, providerName, windowLabel } from '../shared/format.ts';
import type { BalanceSnapshot, Store } from '../shared/types.ts';
import { buildBudgetRows } from './budgets.ts';
import type { LedgerView } from './ledger.ts';

const ROWS_MAX = 16;
const WINDOW_ORDER = ['5h', 'weekly', 'monthly', 'credits_balance'];

const toneFor = (usedPercent: number): GuestStatusTone => (usedPercent >= 85 ? 'error' : usedPercent >= 60 ? 'warning' : 'success');

const slug = (value: string): string => `p-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 40);

const pickWindow = (windows: Record<string, QuotaProviderWindow>): [string, QuotaProviderWindow] | null => {
  for (const name of WINDOW_ORDER) {
    const window = windows[name];
    if (window) return [name, window];
  }
  const first = Object.entries(windows)[0];
  return first ?? null;
};

const balanceRow = (snapshot: BalanceSnapshot, now: number): GuestStatusRow | null => {
  if (!snapshot.ok) return null;
  const picked = pickWindow(snapshot.windows);
  if (!picked) return null;
  const [name, window] = picked;
  const label = providerName(snapshot.provider);
  const tooltip = `${label} ${windowLabel(name)}, read ${ago(snapshot.fetchedAt, now)}.`;
  if (window.usedPercent !== null) {
    const value = window.valueLabel ? window.valueLabel : `${windowLabel(name)} ${percent(window.usedPercent)}`;
    return {
      kind: 'line',
      id: slug(snapshot.provider),
      label,
      content: { kind: 'bar', value: Math.min(100, Math.max(0, window.usedPercent)), tone: toneFor(window.usedPercent) },
      value: value.slice(0, 80),
      tooltip,
    };
  }
  if (window.valueLabel) {
    return { kind: 'line', id: slug(snapshot.provider), label, value: window.valueLabel.slice(0, 80), tooltip };
  }
  return null;
};

/** A provider at 80 % of its cap or more: a warning, or an error from 100 %. Uncapped providers add nothing. */
const budgetRows = (view: LedgerView, store: Store): GuestStatusRow[] => (
  buildBudgetRows(view, store.budgets).flatMap((b): GuestStatusRow[] => {
    if (b.capUsd === null || b.share === null || (b.state !== 'warning' && b.state !== 'error')) return [];
    const tone: GuestStatusTone = b.state;
    const partial = store.rebuilding === true ? ' History is still being re-read, so the real figure may be higher.' : '';
    return [{
      kind: 'line',
      id: `cap-${slug(b.provider)}`,
      label: `${b.name} cap`,
      dot: tone,
      content: { kind: 'bar', value: Math.min(100, b.share), tone },
      value: `${money(b.spentUsd)} of ${money(b.capUsd)} · ${percent(b.share)}`.slice(0, 80),
      valueTone: tone,
      tooltip: `${b.name} has used ${percent(b.share)} of its ${money(b.capUsd)} monthly cap (${money(b.spentUsd)} this UTC month, ${money(b.remainingUsd)} left).${partial}`.slice(0, 300),
    }];
  })
);

export const buildStatusView = (view: LedgerView, store: Store, now: number): GuestStatusView => {
  const rows: GuestStatusRow[] = [...budgetRows(view, store)];

  if (store.syncedAt === null) {
    rows.push({
      kind: 'note',
      id: 'not-synced',
      tone: store.lastError ? 'warning' : 'info',
      text: store.lastError
        ? `Ledger has not synced yet: ${store.lastError}`.slice(0, 300)
        : 'Ledger has not synced yet. The first sync reads up to 40 sessions a run, so it takes a few runs.',
    });
  } else {
    const today = view.totals.today;
    rows.push({
      kind: 'line',
      id: 'today',
      label: 'Today',
      value: money(today.cost),
      tooltip: `${compact(today.tokens)} tokens in ${today.messages} replies (UTC day).`,
    });
    const week = view.totals.d7;
    rows.push({
      kind: 'line',
      id: 'week',
      label: '7 days',
      value: money(week.cost),
      content: { kind: 'chart', values: view.daily7.map((d) => d.cost), tone: 'accent' },
      tooltip: `${compact(week.tokens)} tokens in ${week.messages} replies. 30 days: ${money(view.totals.d30.cost)}.`,
    });
    const top = view.periods.d7.providers[0];
    if (top && top.cost > 0 && week.cost > 0) {
      const share = (top.cost / week.cost) * 100;
      rows.push({
        kind: 'line',
        id: 'top',
        label: 'Top provider',
        content: { kind: 'bar', value: Math.min(100, share), tone: 'accent' },
        value: `${top.name} · ${percent(share)}`.slice(0, 80),
        tooltip: `${top.name} spent ${money(top.cost)} of ${money(week.cost)} over 7 days.`,
      });
    }
  }

  // One line per account, in ledger rank order; the ledger's own provider id names it when there is one.
  const ranked = view.periods.all.providers;
  const rank = new Map(ranked.map((p, i) => [canonicalProvider(p.provider), i]));
  const ledgerId = new Map(ranked.map((p) => [canonicalProvider(p.provider), p.provider]));
  const snapshots = Object.values(store.balances).sort((a, b) => (
    (rank.get(canonicalProvider(a.provider)) ?? 999) - (rank.get(canonicalProvider(b.provider)) ?? 999) || (a.provider < b.provider ? -1 : 1)
  ));
  const seen = new Set(rows.map((r) => r.id));
  const accounts = new Set<string>();
  for (const snapshot of snapshots) {
    const account = canonicalProvider(snapshot.provider);
    if (accounts.has(account)) continue;
    const row = balanceRow({ ...snapshot, provider: ledgerId.get(account) ?? snapshot.provider }, now);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      accounts.add(account);
      rows.push(row);
    }
  }

  if (store.syncedAt !== null && store.rebuilding) {
    rows.push({ kind: 'note', id: 'backfill', tone: 'info', text: `Re-reading history for client attribution${store.pending > 0 ? `: ${store.pending} sessions still to go` : ''}. Figures are partial until it finishes.`.slice(0, 300) });
  } else if (store.syncedAt !== null && store.pending > 0) {
    rows.push({ kind: 'note', id: 'backfill', tone: 'info', text: `Reading history: ${store.pending} older sessions still to go.` });
  } else if (store.syncedAt !== null && store.lastError) {
    rows.push({ kind: 'note', id: 'sync-error', tone: 'warning', text: `Last sync: ${store.lastError}`.slice(0, 300) });
  }
  if (rows.length === 0) rows.push({ kind: 'note', id: 'empty', text: DASH });
  return { rows: rows.slice(0, ROWS_MAX) };
};
