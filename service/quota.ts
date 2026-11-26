// The `quota` role: one card for Provider Ledger on the Usage page.
import type { QuotaProviderUsageData, QuotaProviderWindow } from '@openchamber/sdk';

import { money, providerName, windowLabel } from '../shared/format.ts';
import type { Store } from '../shared/types.ts';
import type { LedgerView } from './ledger.ts';
import type { RefreshedProvider } from './providers.ts';

const WINDOWS_MAX = 32;
const ERROR_MAX = 2000;

const spendWindow = (spent: number): QuotaProviderWindow => ({
  usedPercent: null,
  windowSeconds: null,
  valueLabel: `${money(spent)} spent`,
  value: { kind: 'spend', spent, limit: null },
});

/**
 * Spend from the ledger (no credential needed) plus every provider window that
 * read cleanly. A provider that fails adds nothing; `error` appears only when
 * every provider that was read failed.
 */
export const buildQuotaData = (view: LedgerView, store: Store, refreshed: RefreshedProvider[]): QuotaProviderUsageData => {
  const windows: Record<string, QuotaProviderWindow> = {};
  if (store.syncedAt !== null) {
    windows.today = spendWindow(view.totals.today.cost);
    windows.weekly = spendWindow(view.totals.d7.cost);
    windows.monthly = spendWindow(view.totals.d30.cost);
  }

  for (const { provider, result, duplicateOf } of refreshed) {
    if (!result.ok || duplicateOf) continue;
    for (const [name, window] of Object.entries(result.windows)) {
      if (Object.keys(windows).length >= WINDOWS_MAX) break;
      windows[`${providerName(provider)} · ${windowLabel(name)}`.slice(0, 128)] = window;
    }
  }

  const failed = refreshed.filter((r) => !r.result.ok && !r.duplicateOf);
  const attempted = refreshed.filter((r) => !r.duplicateOf);
  const everyFailed = attempted.length > 0 && failed.length === attempted.length;
  const error = everyFailed
    ? failed.map((r) => `${providerName(r.provider)}: ${r.result.error ?? 'read failed'}`).join(' ').slice(0, ERROR_MAX)
    : undefined;

  return {
    ok: !everyFailed,
    configured: true,
    ...(error ? { error } : {}),
    usage: { windows },
  };
};
