// Provider readers: real balances and plan windows from each provider's API,
// using the credential OpenCode holds (handed through the `quota` role).
//
// Parsers are pure and tested against fixtures. Readers are thin: one fetch,
// then a parser. Every request has an 8 s timeout and refuses redirects. An
// API key never appears in an error string, a log line or the store.
import type { QuotaProviderCredential, QuotaProviderWindow } from '@openchamber/sdk';

import { providerName } from '../shared/format.ts';
import type { BalanceSnapshot, OllamaUsage, OllamaUsageModel } from '../shared/types.ts';
import { toEpochMs } from './ledger.ts';
import type { FetchFn } from './opencode.ts';

export const FETCH_TIMEOUT_MS = 8_000;

const GO_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const BILLING_URL = 'https://opencode.ai/console/api/billing/status';
const GO_INFERENCE_USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';
const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance';
const OLLAMA_USAGE_URL = 'https://ollama.com/api/usage?range=7d&group_by=model';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const MICRO_CENTS_PER_DOLLAR = 1e8;
const GO_PRODUCTS: Record<string, string> = { go: 'Go', 'go-plus': 'Go Plus', 'go-teams': 'Go Teams' };

export type Windows = Record<string, QuotaProviderWindow>;

export type ReaderResult = {
  ok: boolean;
  configured: boolean;
  error?: string;
  /** The OpenCode Console sign-in is expired or refused: the fix is to sign in again. */
  needsSignIn?: boolean;
  planLabel?: string | null;
  windows: Windows;
  ollamaUsage?: OllamaUsage | null;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const usd = (value: number): string => `$${value.toFixed(2)}`;
const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Decimal micro-cent string or number to micro-cents. */
export const parseMicroCents = (value: unknown): number | null => {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
};

// ---- OpenCode Go --------------------------------------------------------

const GO_METERS: Array<{ source: string; name: string; windowSeconds: number | null }> = [
  { source: 'fiveHour', name: '5h', windowSeconds: 5 * 3600 },
  { source: 'week', name: 'weekly', windowSeconds: 7 * 86400 },
  { source: 'month', name: 'monthly', windowSeconds: null },
];

const resetOf = (meter: Record<string, unknown>): number | null => (
  toEpochMs(meter.resetsAt ?? meter.resetAt ?? meter.resetsAtMs ?? meter.resetAtMs ?? null)
);

/** `GET /console/api/go/status`: plan and the three meters as percentages. */
export const parseGoStatus = (json: unknown): Parsed<{ planLabel: string; windows: Windows }> => {
  if (!isObject(json)) return { ok: false, error: 'OpenCode Go status was not an object.' };
  const product = typeof json.product === 'string' ? json.product : '';
  const planLabel = GO_PRODUCTS[product];
  if (!planLabel) return { ok: false, error: product ? `This account is on "${product}", not an OpenCode Go plan.` : 'OpenCode Go status named no product.' };
  const access = isObject(json.access) ? json.access : null;
  const meters = access && isObject(access.meters) ? access.meters : null;
  if (!access) return { ok: false, error: 'No active OpenCode Go subscription on the selected Console account.' };
  if (!meters) return { ok: false, error: 'OpenCode Go status had no meters.' };
  const windows: Windows = {};
  for (const { source, name, windowSeconds } of GO_METERS) {
    const meter = meters[source];
    if (!isObject(meter)) continue;
    const limit = parseMicroCents(meter.limitMicroCents);
    const used = parseMicroCents(meter.usedMicroCents);
    // A meter with no limit, an unreadable amount or no reset time is skipped on its own;
    // the other meters still make a card.
    const resetAt = resetOf(meter);
    if (limit === null || used === null || limit <= 0 || resetAt === null) continue;
    windows[name] = { usedPercent: clampPercent((used / limit) * 100), windowSeconds, resetAt };
  }
  if (Object.keys(windows).length === 0) return { ok: false, error: 'OpenCode Go status had no usable meters.' };
  return { ok: true, value: { planLabel, windows } };
};

/** `GET /console/api/billing/status`: available balance as a money window. */
export const parseBilling = (json: unknown): QuotaProviderWindow | null => {
  const source = isObject(json) && isObject(json.data) && json.availableMicroCents === undefined ? json.data : json;
  if (!isObject(source)) return null;
  const micro = parseMicroCents(source.availableMicroCents);
  if (micro === null) return null;
  return { usedPercent: null, valueLabel: usd(micro / MICRO_CENTS_PER_DOLLAR) };
};

/** `GET /inference/go/v1/usage`: the fallback when the Console read fails. */
export const parseGoInference = (json: unknown): Parsed<{ windows: Windows }> => {
  const usage = isObject(json) && isObject(json.usage) ? json.usage : null;
  if (!usage) return { ok: false, error: 'OpenCode Go usage had no usage block.' };
  const map: Array<[string, string, number | null]> = [['rolling', '5h', 5 * 3600], ['weekly', 'weekly', 7 * 86400], ['monthly', 'monthly', null]];
  const windows: Windows = {};
  for (const [source, name, windowSeconds] of map) {
    const entry = usage[source];
    if (!isObject(entry)) continue;
    const percent = num(entry.percent);
    if (percent === null) continue;
    const window: QuotaProviderWindow = { usedPercent: clampPercent(percent), windowSeconds };
    const resetAt = toEpochMs(entry.resetsAt ?? entry.resetAt ?? null);
    if (resetAt !== null) window.resetAt = resetAt;
    windows[name] = window;
  }
  if (Object.keys(windows).length === 0) return { ok: false, error: 'OpenCode Go usage had no usable windows.' };
  return { ok: true, value: { windows } };
};

// ---- Ollama -------------------------------------------------------------

/** `GET https://ollama.com/api/balance`: the `included` shape and the legacy session/weekly shape. */
export const parseOllamaBalance = (json: unknown): Parsed<{ windows: Windows }> => {
  if (!isObject(json)) return { ok: false, error: 'Ollama balance was not an object.' };
  const windows: Windows = {};

  const included = isObject(json.included) ? json.included : null;
  if (included) {
    const balance = num(included.balance_usd);
    const allowance = num(included.allowance_usd);
    if (balance !== null && allowance !== null && allowance > 0) {
      const spent = Math.max(0, allowance - balance);
      const window: QuotaProviderWindow = {
        usedPercent: clampPercent((spent / allowance) * 100),
        windowSeconds: null,
        valueLabel: `${usd(Math.max(0, balance))} left`,
        value: { kind: 'spend', spent, limit: allowance },
      };
      const period = isObject(included.period) ? included.period : null;
      const until = period ? toEpochMs(period.until) : null;
      if (until !== null) window.resetAt = until;
      windows.monthly = window;
    }
  }

  const purchased = isObject(json.purchased) ? json.purchased : null;
  const purchasedBalance = purchased ? num(purchased.balance_usd) : null;
  if (purchasedBalance !== null && purchasedBalance > 0) {
    windows.credits_balance = { usedPercent: null, valueLabel: usd(purchasedBalance) };
  }

  // Legacy plans: rolling session and weekly windows that report what remains.
  for (const [source, name, seconds] of [['session', '5h', 5 * 3600], ['weekly', 'weekly', 7 * 86400]] as const) {
    const entry = json[source];
    if (!isObject(entry)) continue;
    const remaining = num(entry.remaining_percent);
    if (remaining === null) continue;
    const window: QuotaProviderWindow = { usedPercent: clampPercent(100 - remaining), windowSeconds: seconds };
    const resetAt = toEpochMs(entry.resets_at ?? entry.reset_at ?? entry.until ?? null);
    if (resetAt !== null) window.resetAt = resetAt;
    windows[name] = window;
  }

  if (Object.keys(windows).length === 0) return { ok: false, error: 'Ollama balance had no readable window.' };
  return { ok: true, value: { windows } };
};

/** `GET https://ollama.com/api/usage?range=7d&group_by=model`, for the panel only. */
export const parseOllamaUsage = (json: unknown, fetchedAt: number): OllamaUsage | null => {
  let list: unknown[] | null = null;
  let range = '7d';
  if (Array.isArray(json)) list = json;
  else if (isObject(json)) {
    if (typeof json.range === 'string') range = json.range;
    for (const key of ['models', 'usage', 'data', 'items', 'results', 'groups']) {
      const candidate = json[key];
      if (Array.isArray(candidate)) {
        list = candidate;
        break;
      }
      if (isObject(candidate)) {
        list = Object.entries(candidate).map(([model, value]) => (isObject(value) ? { model, ...value } : { model }));
        break;
      }
    }
  }
  if (!list) return null;
  const models: OllamaUsageModel[] = [];
  for (const item of list) {
    if (!isObject(item)) continue;
    const model = [item.model, item.name, item.group, item.key].find((v): v is string => typeof v === 'string' && v !== '');
    if (!model) continue;
    models.push({
      model,
      usageUsd: num(item.usage_usd ?? item.cost_usd ?? item.usd),
      requests: num(item.requests ?? item.request_count),
      tokens: num(item.tokens ?? item.total_tokens),
    });
  }
  models.sort((a, b) => (b.usageUsd ?? -1) - (a.usageUsd ?? -1));
  return { fetchedAt, range, models: models.slice(0, 20) };
};

// ---- DeepSeek -----------------------------------------------------------

const currencyLabel = (amount: number, currency: string): string => {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  if (currency === 'CNY') return `¥${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
};

/** `GET /user/balance`: one money window per currency, USD first. */
export const parseDeepSeekBalance = (json: unknown): Parsed<{ windows: Windows }> => {
  const infos = isObject(json) && Array.isArray(json.balance_infos) ? json.balance_infos : null;
  if (!infos) return { ok: false, error: 'DeepSeek balance had no balance_infos.' };
  const rows = infos.flatMap((info) => {
    if (!isObject(info)) return [];
    const currency = typeof info.currency === 'string' && info.currency !== '' ? info.currency.toUpperCase() : null;
    const total = num(info.total_balance);
    return currency && total !== null ? [{ currency, total }] : [];
  });
  if (rows.length === 0) return { ok: false, error: 'DeepSeek balance had no readable amount.' };
  rows.sort((a, b) => (a.currency === 'USD' ? -1 : 0) - (b.currency === 'USD' ? -1 : 0));
  const windows: Windows = {};
  rows.forEach((row, index) => {
    const name = index === 0 ? 'credits_balance' : `credits_balance_${row.currency.toLowerCase()}`;
    windows[name] = { usedPercent: null, valueLabel: currencyLabel(row.total, row.currency) };
  });
  return { ok: true, value: { windows } };
};

// ---- HTTP ---------------------------------------------------------------

type HttpResult = { status: number; json: unknown } | { status: null; error: string };

const getJson = async (fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<HttpResult> => {
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const raw = name === 'TimeoutError' || name === 'AbortError' ? 'timed out after 8 s' : error instanceof Error ? error.message : 'network error';
    // A network error must never carry the key into a message, a log or the store.
    const secret = (headers.Authorization ?? '').replace(/^Bearer\s+/i, '');
    return { status: null, error: secret ? raw.split(secret).join('[key]') : raw };
  }
};

const httpFailure = (label: string, result: HttpResult): string => (
  result.status === null ? `${label}: ${result.error}.` : `${label}: HTTP ${result.status}.`
);

const apiKeyOf = (credential: QuotaProviderCredential, label: string): { key: string } | { error: string } => {
  if (credential.type !== 'api') return { error: `${label} needs an API key; its OpenCode login is a browser (OAuth) login, which Provider Ledger cannot use.` };
  const key = credential.key;
  return typeof key === 'string' && key.trim() !== '' ? { key: key.trim() } : { error: `${label} has an empty API key.` };
};

const failure = (error: string, needsSignIn = false): ReaderResult => ({
  ok: false,
  configured: true,
  error,
  ...(needsSignIn ? { needsSignIn: true } : {}),
  windows: {},
});

export const SIGN_IN_EXPIRED = 'Your OpenCode sign-in has expired — sign in again on OpenCode Console in Providers.';
const ORGANIZATION_ID = /^(?:org|wrk)_[A-Za-z0-9]+$/;

type OpenCodeAuth =
  | { kind: 'oauth' | 'api'; headers: Record<string, string> }
  | { kind: 'error'; error: string; needsSignIn: boolean };

/**
 * The headers an OpenCode credential reads the Console with. A Console browser
 * sign-in (`oauth`) sends its access token and its organisation; an API key is
 * sent alone, without `x-org-id`. An expired sign-in is an error before any request.
 */
const openCodeAuth = (credential: QuotaProviderCredential, label: string, now: number): OpenCodeAuth => {
  if (credential.type === 'api') {
    const key = typeof credential.key === 'string' ? credential.key.trim() : '';
    return key ? { kind: 'api', headers: { Authorization: `Bearer ${key}` } } : { kind: 'error', error: `${label} has an empty API key.`, needsSignIn: false };
  }
  if (typeof credential.expires === 'number' && credential.expires > 0 && credential.expires <= now) {
    return { kind: 'error', error: SIGN_IN_EXPIRED, needsSignIn: true };
  }
  const access = typeof credential.access === 'string' ? credential.access.trim() : '';
  const orgID = typeof credential.orgID === 'string' ? credential.orgID.trim() : '';
  if (!access) return { kind: 'error', error: SIGN_IN_EXPIRED, needsSignIn: true };
  if (!ORGANIZATION_ID.test(orgID)) {
    return { kind: 'error', error: `${label}: the OpenCode sign-in has no organization selected. Choose one on OpenCode Console in Providers.`, needsSignIn: false };
  }
  return { kind: 'oauth', headers: { Authorization: `Bearer ${access}`, 'x-org-id': orgID } };
};

const isOk = (result: HttpResult): result is { status: number; json: unknown } => (
  result.status !== null && result.status >= 200 && result.status < 300
);
const isRefused = (result: HttpResult): boolean => result.status === 401 || result.status === 403;

// ---- Readers ------------------------------------------------------------

export const readOpenCodeGo = async (credential: QuotaProviderCredential, fetchFn: FetchFn, now: number = Date.now()): Promise<ReaderResult> => {
  const auth = openCodeAuth(credential, 'OpenCode Go', now);
  if (auth.kind === 'error') return failure(auth.error, auth.needsSignIn);
  const headers = auth.headers;

  const [status, billing] = await Promise.all([
    getJson(fetchFn, GO_STATUS_URL, headers),
    getJson(fetchFn, BILLING_URL, headers),
  ]);

  // Best effort: a billing read that fails drops its row, never the card and never a $0.00.
  const billingWindow = isOk(billing) ? parseBilling(billing.json) : null;

  if (auth.kind === 'oauth') {
    // A Console sign-in's token is not interchangeable with an API key: no fallback endpoint.
    if (isRefused(status)) return failure(SIGN_IN_EXPIRED, true);
    if (!isOk(status)) return failure(httpFailure('OpenCode Go status', status));
    const parsed = parseGoStatus(status.json);
    if (!parsed.ok) return failure(parsed.error);
    const windows = { ...parsed.value.windows };
    if (billingWindow) windows.credits_balance = billingWindow;
    return { ok: true, configured: true, planLabel: parsed.value.planLabel, windows };
  }

  if (isOk(status)) {
    const parsed = parseGoStatus(status.json);
    if (!parsed.ok) return failure(parsed.error);
    const windows = { ...parsed.value.windows };
    if (billingWindow) windows.credits_balance = billingWindow;
    return { ok: true, configured: true, planLabel: parsed.value.planLabel, windows };
  }

  // The Console read failed: fall back to the inference usage endpoint.
  const fallback = await getJson(fetchFn, GO_INFERENCE_USAGE_URL, { ...headers, 'x-opencode-session': 'openchamber-provider-ledger' });
  if (isOk(fallback)) {
    const parsed = parseGoInference(fallback.json);
    if (parsed.ok) {
      const windows = { ...parsed.value.windows };
      if (billingWindow) windows.credits_balance = billingWindow;
      return { ok: true, configured: true, planLabel: null, windows };
    }
  }
  return failure(`${httpFailure('OpenCode Go status', status)} ${httpFailure('Fallback usage', fallback)}`.trim());
};

export const readOpenCodeZen = async (credential: QuotaProviderCredential, fetchFn: FetchFn, now: number = Date.now()): Promise<ReaderResult> => {
  const auth = openCodeAuth(credential, 'OpenCode Zen', now);
  if (auth.kind === 'error') return failure(auth.error, auth.needsSignIn);
  const result = await getJson(fetchFn, BILLING_URL, auth.headers);
  if (isRefused(result)) {
    return auth.kind === 'oauth' ? failure(SIGN_IN_EXPIRED, true) : failure('OpenCode Zen has no balance API for API keys.');
  }
  if (isOk(result)) {
    const window = parseBilling(result.json);
    if (window) return { ok: true, configured: true, planLabel: null, windows: { credits_balance: window } };
    return failure('OpenCode Zen billing answered without a balance.');
  }
  return failure(httpFailure('OpenCode Zen billing', result));
};

export const readOllama = async (credential: QuotaProviderCredential, fetchFn: FetchFn, now: number): Promise<ReaderResult> => {
  const auth = apiKeyOf(credential, 'Ollama');
  if ('error' in auth) return failure(auth.error);
  const headers = { Authorization: `Bearer ${auth.key}` };
  const balance = await getJson(fetchFn, OLLAMA_BALANCE_URL, headers);
  if (balance.status === 429) return failure('Ollama rate limit reached (10 requests a minute); it will retry on the next refresh.');
  if (balance.status === null || balance.status < 200 || balance.status >= 300) return failure(httpFailure('Ollama balance', balance));
  const parsed = parseOllamaBalance(balance.json);
  if (!parsed.ok) return failure(parsed.error);

  // One usage read per refresh, for the panel only. Its failure never fails the card.
  const usage = await getJson(fetchFn, OLLAMA_USAGE_URL, headers);
  const ollamaUsage = usage.status !== null && usage.status >= 200 && usage.status < 300 ? parseOllamaUsage(usage.json, now) : null;
  return { ok: true, configured: true, planLabel: null, windows: parsed.value.windows, ollamaUsage };
};

export const readDeepSeek = async (credential: QuotaProviderCredential, fetchFn: FetchFn): Promise<ReaderResult> => {
  const auth = apiKeyOf(credential, 'DeepSeek');
  if ('error' in auth) return failure(auth.error);
  const result = await getJson(fetchFn, DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${auth.key}` });
  if (result.status === null || result.status < 200 || result.status >= 300) return failure(httpFailure('DeepSeek balance', result));
  const parsed = parseDeepSeekBalance(result.json);
  if (!parsed.ok) return failure(parsed.error);
  return { ok: true, configured: true, planLabel: null, windows: parsed.value.windows };
};

export const readAnthropic = (): ReaderResult => ({
  ok: true,
  configured: true,
  error: 'Anthropic has no balance API; see the ledger for spend.',
  planLabel: null,
  windows: {},
});

type Reader = {
  /** Providers on the same account share one read. */
  family: string;
  read: (credential: QuotaProviderCredential, fetchFn: FetchFn, now: number) => Promise<ReaderResult>;
};

export const READERS: Record<string, Reader> = {
  'opencode-go': { family: 'opencode-go', read: (c, f, n) => readOpenCodeGo(c, f, n) },
  opencode: { family: 'opencode-zen', read: (c, f, n) => readOpenCodeZen(c, f, n) },
  'ollama-cloud': { family: 'ollama', read: (c, f, n) => readOllama(c, f, n) },
  'console-ollama-cloud': { family: 'ollama', read: (c, f, n) => readOllama(c, f, n) },
  ollama: { family: 'ollama', read: (c, f, n) => readOllama(c, f, n) },
  deepseek: { family: 'deepseek', read: (c, f) => readDeepSeek(c, f) },
  anthropic: { family: 'anthropic', read: () => Promise.resolve(readAnthropic()) },
};

export type RefreshedProvider = {
  provider: string;
  result: ReaderResult;
  /** Another provider id with the same account already stands for this one on the card. */
  duplicateOf: string | null;
};

/**
 * Read every provider the host handed a credential for. One failing provider
 * never throws: it comes back as an `ok: false` result. Two ids on the same
 * key (`ollama` and `ollama-cloud`) cost one read.
 */
export const refreshProviders = async (
  credentials: Record<string, QuotaProviderCredential>,
  fetchFn: FetchFn,
  now: number,
): Promise<RefreshedProvider[]> => {
  type Job = { provider: string; credential: QuotaProviderCredential; derived: boolean };
  const list: Job[] = Object.entries(credentials).map(([provider, credential]) => ({ provider, credential, derived: false }));
  // The OpenCode login lives on the shared `opencode` integration. With no credential of
  // its own for Go, the same login (a Console sign-in, or an API key) serves OpenCode Go.
  const shared0 = credentials.opencode;
  if (shared0 && !credentials['opencode-go']) list.push({ provider: 'opencode-go', credential: shared0, derived: true });

  const shared = new Map<string, { first: string; promise: Promise<ReaderResult> }>();
  const jobs = list.flatMap(({ provider, credential, derived }) => {
    const reader = READERS[provider];
    if (!reader) return [];
    const identity = credential.type === 'api' ? `${reader.family}:${credential.key}` : `${reader.family}:oauth:${provider}`;
    let entry = shared.get(identity);
    let duplicateOf: string | null = null;
    if (entry) duplicateOf = entry.first;
    else {
      entry = {
        first: provider,
        promise: reader.read(credential, fetchFn, now).catch((error: unknown): ReaderResult => {
          const secret = credential.type === 'api' ? credential.key : '';
          const raw = error instanceof Error ? error.message : 'unknown error';
          return failure(`${providerName(provider)} read failed: ${secret ? raw.split(secret).join('[key]') : raw}`);
        }),
      };
      shared.set(identity, entry);
    }
    // An API key on `opencode` that Go does not accept is just a Zen-only key: say nothing about Go.
    const quiet = derived && credential.type === 'api';
    return [entry.promise.then((result): RefreshedProvider | null => (
      quiet && !result.ok ? null : { provider, result, duplicateOf }
    ))];
  });
  return (await Promise.all(jobs)).filter((item): item is RefreshedProvider => item !== null);
};

export const snapshotOf = (provider: string, result: ReaderResult, fetchedAt: number): BalanceSnapshot => ({
  provider,
  fetchedAt,
  ok: result.ok,
  configured: result.configured,
  ...(result.error ? { error: result.error } : {}),
  ...(result.needsSignIn ? { needsSignIn: true } : {}),
  planLabel: result.planLabel ?? null,
  windows: result.windows,
});
