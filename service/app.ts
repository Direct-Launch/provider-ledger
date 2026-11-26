// The service's HTTP surface and its state. `main.ts` reads the environment and
// listens; everything else lives here so tests can drive it.
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

import { readQuotaProviderRequest } from '@openchamber/sdk';

import type { BalanceSnapshot, BudgetResult, ExportResult, PanelPayload, SettingsResult, Store, SyncResult } from '../shared/types.ts';
import { buildBalanceCards, collapsedProjects, dateKey, deriveLedger, planWindowsOf, rekeySessions } from './ledger.ts';
import type { LedgerView } from './ledger.ts';
import { badgeCount, buildBudgetRows, setBudget } from './budgets.ts';
import { exportCsv } from './export.ts';
import { createOpenCodeReader, syncOnce } from './opencode.ts';
import type { FetchFn, OpenCodeReader, SyncOutcome } from './opencode.ts';
import { refreshProviders, snapshotOf } from './providers.ts';
import { buildQuotaData } from './quota.ts';
import { defaultSettings, mergeSettings, resetRules } from './spend.ts';
import { buildStatusView } from './status.ts';
import { loadStore, saveStore } from './store.ts';

const STALE_AFTER_MS = 10 * 60_000;
const SYNC_EVERY_MS = 2 * 60_000;
const ATTEMPT_GAP_MS = 15_000;
const CHAIN_GAP_MS = 1_000;
const CHAIN_MAX = 10;
const BODY_MAX = 1_000_000;

export type ServiceOptions = {
  token: string;
  storePath: string;
  /** `OPENCHAMBER_OPENCODE_URL`; without it sync reports that OpenCode access is missing. */
  opencodeUrl?: string;
  reader?: OpenCodeReader;
  fetchFn?: FetchFn;
  now?: () => number;
  /** Where `Downloads` is looked for; the user's home by default. Tests point it at a scratch folder. */
  homeDir?: string;
  /** Start background syncs from reads. Tests turn it off. */
  autoSync?: boolean;
};

const MISSING_OPENCODE = 'OpenCode access is not available: the opencode role has not been approved for this extension.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createService = async (options: ServiceOptions) => {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetchFn ?? fetch;
  const autoSync = options.autoSync ?? true;
  const reader = options.reader ?? (options.opencodeUrl ? createOpenCodeReader(options.opencodeUrl, options.token, fetchFn) : null);

  const store: Store = await loadStore(options.storePath, now());
  let version = 1;
  let view: { key: string; value: LedgerView } | null = null;
  let syncing = false;
  let chaining = false;
  let lastAttemptAt = 0;
  let persisting: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    persisting = persisting.then(() => saveStore(options.storePath, store, now()).catch((error: unknown) => {
      console.error(`provider-ledger: could not write the store: ${error instanceof Error ? error.message : 'unknown error'}`);
    }));
    return persisting;
  };

  const ledgerView = (): LedgerView => {
    const at = now();
    const key = `${version}|${dateKey(at)}`;
    if (!view || view.key !== key) view = { key, value: deriveLedger(store, at) };
    return view.value;
  };

  const runBatch = async (): Promise<SyncOutcome | null> => {
    if (syncing) return null;
    lastAttemptAt = now();
    if (!reader) {
      store.lastError = MISSING_OPENCODE;
      return { processed: 0, pending: store.pending, toolsPending: store.toolsPending, error: MISSING_OPENCODE, listed: false };
    }
    syncing = true;
    try {
      return await syncOnce(store, reader, { now: now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sync failed';
      store.lastError = message;
      return { processed: 0, pending: store.pending, toolsPending: store.toolsPending, error: message, listed: false };
    } finally {
      syncing = false;
      version += 1;
      await persist();
    }
  };

  /** Keep reading batches in the background until nothing is pending, bounded per trigger. */
  const startChain = (): void => {
    if (chaining) return;
    chaining = true;
    void (async () => {
      try {
        for (let i = 0; i < CHAIN_MAX; i += 1) {
          const outcome = await runBatch();
          if (!outcome || !outcome.listed || outcome.error || (outcome.pending === 0 && outcome.toolsPending === 0)) break;
          await sleep(CHAIN_GAP_MS);
        }
      } finally {
        chaining = false;
      }
    })();
  };

  const maybeSync = (): void => {
    if (!autoSync || syncing || chaining) return;
    const at = now();
    if (at - lastAttemptAt < ATTEMPT_GAP_MS) return;
    if (store.syncedAt === null || at - store.syncedAt > SYNC_EVERY_MS || store.pending > 0 || store.toolsPending > 0) startChain();
  };

  const panelPayload = (): PanelPayload => {
    const at = now();
    const ledger = ledgerView();
    const balances = buildBalanceCards(store.balances, ledger.providerIds);
    const budgets = buildBudgetRows(ledger, store.budgets, balances);
    const fetched = balances.map((c) => c.fetchedAt).filter((t): t is number => t !== null);
    return {
      now: at,
      syncedAt: store.syncedAt,
      stale: store.syncedAt === null || at - store.syncedAt > STALE_AFTER_MS,
      syncing: syncing || chaining,
      pending: store.pending,
      lastError: store.lastError,
      sessionsTracked: Object.keys(store.sessions).length,
      hasData: ledger.hasData,
      firstDate: ledger.firstDate,
      periods: ledger.periods,
      months: ledger.months,
      balances,
      balancesFetchedAt: fetched.length > 0 ? Math.max(...fetched) : null,
      ollamaUsage: store.ollamaUsage,
      budgets,
      overCap: badgeCount(budgets) ?? 0,
      rebuilding: store.rebuilding === true,
      toolsRead: Object.keys(store.tools).length,
      toolsPending: store.toolsPending,
      settings: store.settings,
      defaults: defaultSettings(),
      collapsedProjects: collapsedProjects(store),
    };
  };

  /** `{ reset: true }` restores the shipped rules; otherwise each list that is present replaces the stored one. */
  const handleSettings = async (body: string): Promise<SettingsResult> => {
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return { ok: false, error: 'The request was not valid JSON.' };
    }
    const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const base = record.reset === true ? resetRules(store.settings) : store.settings;
    const next = record.reset === true && record.settings === undefined ? { ok: true as const, settings: base } : mergeSettings(base, record.settings, true);
    if (!next.ok) return next;
    const rootsChanged = next.settings.roots.join('\n') !== store.settings.roots.join('\n');
    store.settings = next.settings;
    if (rootsChanged) rekeySessions(store);
    version += 1;
    await persist();
    return { ok: true, settings: store.settings };
  };

  const handleBudget = async (body: string): Promise<BudgetResult> => {
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return { ok: false, error: 'The request was not valid JSON.' };
    }
    const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const result = setBudget(store, record.provider, record.capUsd === undefined ? NaN : record.capUsd);
    if (result.ok) {
      version += 1;
      await persist();
    }
    return result;
  };

  const handleExport = async (): Promise<ExportResult> => exportCsv(store, now(), options.homeDir);

  const handleQuota = async (body: string): Promise<{ status: number; body: unknown }> => {
    const request = readQuotaProviderRequest(body);
    if (!request) return { status: 400, body: { error: 'bad-request' } };
    try {
      const at = now();
      const refreshed = await refreshProviders(request.input.credentials, fetchFn, at);
      const byProvider = new Map<string, BalanceSnapshot>();
      for (const item of refreshed) {
        const own = snapshotOf(item.provider, item.result, at);
        // Once a plan was seen it stays seen, through an expired sign-in or a failed read.
        if (planWindowsOf(own) || store.balances[item.provider]?.hadPlan) own.hadPlan = true;
        byProvider.set(item.provider, own);
        if (item.result.ollamaUsage) store.ollamaUsage = item.result.ollamaUsage;
      }
      for (const [provider, snapshot] of byProvider) store.balances[provider] = snapshot;
      version += 1;
      void persist();
      maybeSync();
      return { status: 200, body: { ok: true, data: buildQuotaData(ledgerView(), store, refreshed) } };
    } catch (error) {
      return { status: 200, body: { ok: false, error: { message: (error instanceof Error ? error.message : 'Provider Ledger failed').slice(0, 500) } } };
    }
  };

  const handleSync = async (): Promise<SyncResult> => {
    if (syncing) return { syncedAt: store.syncedAt, sessions: 0, pending: store.pending, running: true };
    const outcome = await runBatch();
    if (outcome && outcome.listed && !outcome.error && (outcome.pending > 0 || outcome.toolsPending > 0)) startChain();
    return {
      syncedAt: store.syncedAt,
      sessions: outcome?.processed ?? 0,
      pending: store.pending,
      ...(outcome?.error ? { error: outcome.error } : {}),
    };
  };

  const authorised = (header: string | undefined): boolean => {
    const expected = Buffer.from(`Bearer ${options.token}`);
    const given = Buffer.from(header ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const readBody = (req: http.IncomingMessage): Promise<string | null> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!authorised(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const route = url.pathname;
    const only = (expected: string): boolean => {
      if (method === expected) return true;
      send(res, 405, { error: 'method-not-allowed' });
      return false;
    };

    try {
      switch (route) {
        case '/health':
          if (only('GET')) send(res, 200, {});
          return;
        case '/status':
          if (!only('GET')) return;
          maybeSync();
          send(res, 200, buildStatusView(ledgerView(), store, now()));
          return;
        case '/panel':
          if (!only('GET')) return;
          maybeSync();
          send(res, 200, panelPayload());
          return;
        case '/quota': {
          if (!only('POST')) return;
          const body = await readBody(req);
          if (body === null) return send(res, 413, { error: 'body-too-large' });
          const result = await handleQuota(body);
          return send(res, result.status, result.body);
        }
        case '/budgets': {
          if (!only('POST')) return;
          const body = await readBody(req);
          if (body === null) return send(res, 413, { error: 'body-too-large' });
          return send(res, 200, await handleBudget(body));
        }
        case '/settings': {
          if (!only('POST')) return;
          const body = await readBody(req);
          if (body === null) return send(res, 413, { error: 'body-too-large' });
          return send(res, 200, await handleSettings(body));
        }
        case '/export':
          if (!only('POST')) return;
          await readBody(req);
          return send(res, 200, await handleExport());
        case '/sync':
          if (!only('POST')) return;
          await readBody(req);
          return send(res, 200, await handleSync());
        default:
          return send(res, 404, { error: 'not-found' });
      }
    } catch (error) {
      // A route bug must not look like a provider failure, but still never a 500 on /quota.
      if (route === '/quota') return send(res, 200, { ok: false, error: { message: 'Provider Ledger failed to answer.' } });
      send(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : 'internal' });
    }
  };

  return { handle, store, panelPayload, handleSync, handleQuota, handleBudget, handleSettings, handleExport, runBatch, persist };
};
