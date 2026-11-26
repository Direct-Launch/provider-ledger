// The ledger: OpenCode message data folded into per-day, per-provider, per-model
// buckets. Pure functions here; the store and the sync loop live beside them.
import { canonicalProvider, providerName } from '../shared/format.ts';
import { PERIOD_IDS, PERIOD_LABELS, SPEND_CATEGORIES, STORE_VERSION } from '../shared/types.ts';
import { UNATTRIBUTED, cleanKey, placementOf, projectKeyOf } from './attribution.ts';
import { UNKNOWN_AGENT, categoryOf, defaultSettings, scopeOf } from './spend.ts';
import { parseToolKey, toolCallsOf, toolKey } from './tools.ts';
import type { ParsedToolKey } from './tools.ts';
import type {
  BalanceCard,
  BalanceSnapshot,
  Bucket,
  MonthRow,
  LedgerSettings,
  PanelPayload,
  PeriodId,
  PeriodModel,
  PeriodProject,
  PeriodProvider,
  PeriodSurfaces,
  PeriodTypes,
  PeriodView,
  RangeTotals,
  SeriesPoint,
  SessionEntry,
  SpendCategory,
  SpendScope,
  Store,
  SurfaceRow,
  Tokens,
  ToolRow,
  TypeCategoryRow,
  TypeTotals,
} from '../shared/types.ts';

/** Daily buckets are kept for three years, so "All time" is real. */
export const RETENTION_DAYS = 3 * 366;
/** The store file never grows past this; the oldest days go first. */
export const MAX_STORE_BYTES = 16 * 1024 * 1024;
export const MAX_SESSIONS_PER_RUN = 40;
/** Sessions touched in this many days have their tool calls read before any older history. */
export const RECENT_TOOLS_DAYS = 30;
/** Per session-bucket sample cap; beyond it samples are thinned evenly. */
export const SAMPLE_CAP = 300;
export const DAY_MS = 86_400_000;

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const str = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null
);

/** Epoch milliseconds from a number (seconds or ms) or an ISO string. */
export const toEpochMs = (value: unknown): number | null => {
  const n = num(value);
  if (n !== null) return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const dateKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The last `n` UTC dates ending at `now`, oldest first. */
export const lastDates = (now: number, n: number): string[] => {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(dateKey(now - i * DAY_MS));
  return out;
};

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

export const totalTokens = (t: Tokens): number => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;

/** Linear-interpolated percentile of an ascending array; null when empty. */
export const percentile = (sortedAscending: ArrayLike<number>, p: number): number | null => {
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (n === 1) return sortedAscending[0] ?? null;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sortedAscending[lo] ?? 0;
  const b = sortedAscending[hi] ?? a;
  return a + (b - a) * (rank - lo);
};

const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/** Thin an array to at most `cap` entries, evenly, keeping order. */
export const thin = (values: number[], cap: number): number[] => {
  if (values.length <= cap) return values;
  const out: number[] = [];
  for (let i = 0; i < cap; i += 1) out.push(values[Math.floor((i * values.length) / cap)] ?? 0);
  return out;
};

/** A numeric ascending copy. A typed array sorts numerically without a comparator, several times faster. */
const sortedCopy = (values: number[]): Float64Array => Float64Array.from(values).sort();

const finishPercentiles = (bucket: Bucket): void => {
  const sorted = sortedCopy(bucket.samples);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  bucket.p50 = p50 === null ? null : round(p50, 2);
  bucket.p90 = p90 === null ? null : round(p90, 2);
};

export type NormalizedMessage = {
  date: string;
  provider: string;
  model: string;
  cost: number;
  tokens: Tokens;
  /** (output + reasoning) tokens per second, or null when it cannot be measured. */
  rate: number | null;
  /** The agent the reply itself names, when it does. */
  agent: string | null;
};

/**
 * One OpenCode message to what the ledger needs. Accepts `{ info, parts }` and
 * a flat message. Anything that is not an assistant message with a provider, a
 * model and a timestamp is null: the ledger never guesses a provider.
 */
export const normalizeMessage = (raw: unknown): NormalizedMessage | null => {
  if (!isObject(raw)) return null;
  const info = isObject(raw.info) ? raw.info : raw;
  const role = str(info.role);
  if (role !== null && role !== 'assistant') return null;
  // OpenCode 2 names the kind in `type` (`assistant`, `user`, `model-switched`…)
  // and carries no `role`, so both are read and either one can rule a row out.
  const type = str(info.type);
  if (type !== null && type !== 'assistant') return null;

  const model = isObject(info.model) ? info.model : null;
  const provider = str(info.providerID) ?? (model ? str(model.providerID) : null);
  const modelId = str(info.modelID) ?? (model ? (str(model.modelID) ?? str(model.id)) : null);
  if (!provider || !modelId) return null;

  const tokensRaw = isObject(info.tokens) ? info.tokens : null;
  // No role field and no token block: nothing says this is a model reply.
  if (role === null && tokensRaw === null) return null;

  const time = isObject(info.time) ? info.time : {};
  const created = toEpochMs(time.created);
  const completed = toEpochMs(time.completed);
  const at = created ?? completed;
  if (at === null) return null;

  const cache = tokensRaw && isObject(tokensRaw.cache) ? tokensRaw.cache : {};
  const tokens: Tokens = {
    input: Math.max(0, num(tokensRaw?.input) ?? 0),
    output: Math.max(0, num(tokensRaw?.output) ?? 0),
    reasoning: Math.max(0, num(tokensRaw?.reasoning) ?? 0),
    cacheRead: Math.max(0, num(cache.read) ?? 0),
    cacheWrite: Math.max(0, num(cache.write) ?? 0),
  };

  let rate: number | null = null;
  if (created !== null && completed !== null) {
    const seconds = (completed - created) / 1000;
    const generated = tokens.output + tokens.reasoning;
    if (seconds >= 1 && generated > 0) rate = generated / seconds;
  }

  return {
    date: dateKey(at),
    provider,
    model: modelId,
    cost: Math.max(0, num(info.cost) ?? 0),
    tokens,
    rate,
    agent: ownAgentOf(info),
  };
};

/** The agent a message names for itself (`agent`, or the older `mode`). */
const ownAgentOf = (info: Record<string, unknown>): string | null => str(info.agent) ?? str(info.mode);

/** The agent id inside a value that is either the id or `{ id | name }`. */
const agentId = (value: unknown): string | null => (
  typeof value === 'string' ? str(value) : isObject(value) ? (str(value.id) ?? str(value.name)) : null
);

/** The agent as it is kept in a bucket key: no bar, never empty. */
const agentKey = (agent: string | null | undefined): string => {
  const cleaned = cleanKey(agent ?? '');
  return cleaned === '' ? UNKNOWN_AGENT : cleaned;
};

export const bucketKey = (date: string, provider: string, model: string, project: string, agent: string | null = null): string => (
  `${date}|${provider}|${model}|${project}|${agentKey(agent)}`
);

export type ParsedKey = { date: string; provider: string; model: string; project: string; agent: string };

/**
 * `date|provider|model|project|agent`. Neither the project nor the agent carries a `|` (see
 * `cleanKey`), so they are what follows the last two bars; a model id may carry bars. A key with
 * fewer than four bars is not a version 4 key and reads as null, which is how it gets dropped.
 */
export const parseBucketKey = (key: string): ParsedKey | null => {
  const first = key.indexOf('|');
  const second = first < 0 ? -1 : key.indexOf('|', first + 1);
  const last = key.lastIndexOf('|');
  const before = last < 0 ? -1 : key.lastIndexOf('|', last - 1);
  if (first < 0 || second < 0 || before <= second || last <= before) return null;
  return {
    date: key.slice(0, first),
    provider: key.slice(first + 1, second),
    model: key.slice(second + 1, before),
    project: key.slice(before + 1, last) || UNATTRIBUTED,
    agent: key.slice(last + 1) || UNKNOWN_AGENT,
  };
};

/** Move every bucket of a session to another project key. Pure; buckets are replaced, never merged. */
export const rekeyBuckets = (buckets: Record<string, Bucket>, project: string): Record<string, Bucket> => {
  const out: Record<string, Bucket> = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    const parsed = parseBucketKey(key);
    if (parsed) out[bucketKey(parsed.date, parsed.provider, parsed.model, project, parsed.agent)] = bucket;
  }
  return out;
};

const newBucket = (): Bucket => ({ messages: 0, tokens: emptyTokens(), cost: 0, samples: [], p50: null, p90: null });

type Ordered = { raw: unknown; index: number; at: number | null; switched: { agent: string | null } | null };

/** An `agent-switched` entry of the message stream and the agent it switches to; null for anything else. */
const switchOf = (raw: unknown): { agent: string | null } | null => {
  if (!isObject(raw)) return null;
  const info = isObject(raw.info) ? raw.info : raw;
  const type = str(info.type)?.toLowerCase().replace(/_/g, '-');
  return type === 'agent-switched' ? { agent: agentId(info.agent) } : null;
};

/** When an entry happened: `time.created`, a bare `time`, `created` or `timestamp`; null when it says nothing. */
const timeOf = (raw: unknown): number | null => {
  if (!isObject(raw)) return null;
  const info = isObject(raw.info) ? raw.info : raw;
  const time = isObject(info.time) ? (info.time.created ?? info.time.completed) : info.time;
  return toEpochMs(time ?? info.created ?? info.timestamp);
};

/**
 * Switches and replies in time order. The stream is already chronological, so this only matters
 * when it is not: entries are sorted by time when every one of them carries one, and left in
 * stream order (the order they arrived in) when any does not, because a partial sort would
 * reorder on guesswork.
 */
const inOrder = (messages: unknown[]): Ordered[] => {
  const items: Ordered[] = [];
  messages.forEach((raw, index) => {
    const switched = switchOf(raw);
    if (switched || normalizeMessage(raw)) items.push({ raw, index, at: timeOf(raw), switched });
  });
  if (items.length > 1 && items.every((item) => item.at !== null)) {
    items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.index - b.index);
  }
  return items;
};

/**
 * Messages of one session to its buckets. p50 and p90 are computed here, once.
 *
 * The agent in force for a reply is, in order: the agent the reply names itself; the last
 * `agent-switched` entry before it; the session's own agent when the stream has no switch at
 * all. A reply that precedes the first switch of a stream that has one has no known agent
 * (the session's own agent is where it ended up, not where it began), so it is `?`.
 */
export const aggregateMessages = (
  messages: unknown[],
  project: string = UNATTRIBUTED,
  sessionAgent: string | null = null,
): { buckets: Record<string, Bucket>; skipped: number } => {
  const buckets: Record<string, Bucket> = {};
  const ordered = inOrder(messages);
  const hasSwitch = ordered.some((item) => item.switched !== null);
  let skipped = messages.length - ordered.length;
  let current: string | null = null;
  for (const item of ordered) {
    if (item.switched) {
      current = item.switched.agent;
      continue;
    }
    const m = normalizeMessage(item.raw);
    if (!m) {
      skipped += 1;
      continue;
    }
    const agent = m.agent ?? current ?? (hasSwitch ? null : sessionAgent);
    const key = bucketKey(m.date, m.provider, m.model, project, agent);
    const bucket = (buckets[key] ??= newBucket());
    bucket.messages += 1;
    bucket.cost += m.cost;
    bucket.tokens.input += m.tokens.input;
    bucket.tokens.output += m.tokens.output;
    bucket.tokens.reasoning += m.tokens.reasoning;
    bucket.tokens.cacheRead += m.tokens.cacheRead;
    bucket.tokens.cacheWrite += m.tokens.cacheWrite;
    if (m.rate !== null) bucket.samples.push(round(m.rate, 2));
  }
  for (const bucket of Object.values(buckets)) {
    bucket.samples = thin(bucket.samples, SAMPLE_CAP);
    finishPercentiles(bucket);
  }
  return { buckets, skipped };
};

const newToolRow = (): ToolRow => ({ calls: 0, generated: 0, contextChars: 0 });

/**
 * Tool calls of one session's messages, per `date|provider|model|class|name`. A call counts once
 * however far it got (a call still streaming or running has no result, so no context). The reply's
 * generated tokens (output and reasoning) are added once per reply for each class and name it
 * called, so a reply that called one tool three times does not count its tokens three times; a
 * reply that called two different tools counts them under each, and the Surfaces tab says so.
 */
export const aggregateTools = (messages: unknown[]): Record<string, ToolRow> => {
  const rows: Record<string, ToolRow> = {};
  for (const raw of messages) {
    const calls = toolCallsOf(raw);
    if (calls.length === 0) continue;
    const m = normalizeMessage(raw);
    if (!m) continue;
    const generated = m.tokens.output + m.tokens.reasoning;
    const counted = new Set<string>();
    for (const call of calls) {
      const key = toolKey(m.date, m.provider, m.model, call.cls, call.name);
      const row = (rows[key] ??= newToolRow());
      row.calls += 1;
      row.contextChars += call.contextChars;
      if (!counted.has(key)) {
        counted.add(key);
        row.generated += generated;
      }
    }
  }
  return rows;
};

export type SessionRef = {
  id: string;
  updated: number;
  directory?: string | null;
  /** The session's own agent, when the listing carries one. */
  agent?: string | null;
  /** The session this one was spawned from, when the listing says so: it is a subagent session. */
  parent?: string | null;
};

/**
 * Which sessions need reading: any session the store has never seen (whatever
 * its `time.updated`, so history backfills) and any whose `updated` moved since
 * it was read. Oldest `updated` first, at most `max` a run; `pending` is how
 * many were left over, so it reaches 0 only when the whole history is in.
 */
export const selectSessions = (
  refs: SessionRef[],
  known: Record<string, SessionEntry>,
  options: { max?: number },
): { selected: SessionRef[]; pending: number } => {
  const due = refs
    .filter((ref) => {
      const seen = known[ref.id];
      return seen === undefined || seen.updated < ref.updated;
    })
    .sort((a, b) => a.updated - b.updated || (a.id < b.id ? -1 : 1));
  const max = options.max ?? MAX_SESSIONS_PER_RUN;
  return { selected: due.slice(0, max), pending: Math.max(0, due.length - max) };
};

/** A session's buckets are older than the session itself, or it has none. */
const mainDue = (store: Store, ref: SessionRef): boolean => {
  const seen = store.sessions[ref.id];
  return seen === undefined || seen.updated < ref.updated;
};

/** Its tool calls have not been read since it last changed. */
const toolsDue = (store: Store, ref: SessionRef): boolean => {
  const seen = store.tools[ref.id];
  return seen === undefined || seen.toolsSynced < ref.updated;
};

const byNewest = (a: SessionRef, b: SessionRef): number => b.updated - a.updated || (a.id < b.id ? -1 : 1);

/**
 * The sessions to read first: any session changed in the last `RECENT_TOOLS_DAYS` days whose
 * buckets or tool calls are not current, newest first. Reading one fills both, so a recent session
 * that was never read is read once. Older history waits behind them.
 */
export const selectRecentSessions = (refs: SessionRef[], store: Store, options: { now: number; max: number }): SessionRef[] => {
  const since = options.now - RECENT_TOOLS_DAYS * DAY_MS;
  return refs
    .filter((ref) => ref.updated >= since && (mainDue(store, ref) || toolsDue(store, ref)))
    .sort(byNewest)
    .slice(0, Math.max(0, options.max));
};

/** Sessions whose buckets are current but whose tool calls are not, newest first. */
export const selectToolSessions = (refs: SessionRef[], store: Store, options: { max: number }): SessionRef[] => (
  refs.filter((ref) => toolsDue(store, ref)).sort(byNewest).slice(0, Math.max(0, options.max))
);

/** How many sessions in the listing still have no current tool calls. */
export const countToolsPending = (refs: SessionRef[], store: Store): number => refs.filter((ref) => toolsDue(store, ref)).length;

export const emptyStore = (): Store => ({
  version: STORE_VERSION,
  watermark: 0,
  syncedAt: null,
  lastError: null,
  pending: 0,
  sessions: {},
  tools: {},
  toolsPending: 0,
  balances: {},
  ollamaUsage: null,
  budgets: {},
  settings: defaultSettings(),
});

/**
 * Drop buckets older than the retention window. A session entry stays even when
 * it is empty: it is how the sync knows the session was read, and dropping it
 * would make an old session look unseen and be read again on every run.
 */
export const pruneStore = (store: Store, now: number): void => {
  const cutoffDate = dateKey(now - RETENTION_DAYS * DAY_MS);
  for (const entry of Object.values(store.sessions)) {
    for (const key of Object.keys(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (!parsed || parsed.date < cutoffDate) delete entry.buckets[key];
    }
  }
  // Tool rows keep the same retention; the marker stays so the session is not read again.
  for (const entry of Object.values(store.tools)) {
    for (const key of Object.keys(entry.rows)) {
      const parsed = parseToolKey(key);
      if (!parsed || parsed.date < cutoffDate) delete entry.rows[key];
    }
  }
};

/**
 * Keep the serialised store under `maxBytes` by dropping the oldest days first.
 * Returns how many distinct days were dropped. Session entries stay.
 */
export const capStoreSize = (store: Store, maxBytes: number = MAX_STORE_BYTES): number => {
  let size = JSON.stringify(store).length;
  if (size <= maxBytes) return 0;
  const dates = new Set<string>();
  for (const entry of Object.values(store.sessions)) {
    for (const key of Object.keys(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (parsed) dates.add(parsed.date);
    }
  }
  for (const entry of Object.values(store.tools)) {
    for (const key of Object.keys(entry.rows)) {
      const parsed = parseToolKey(key);
      if (parsed) dates.add(parsed.date);
    }
  }
  const ordered = [...dates].sort();
  let dropped = 0;
  while (size > maxBytes && dropped < ordered.length) {
    // Drop in proportion to the overshoot, at least one day, then measure again.
    const share = Math.ceil(((size - maxBytes) / size) * ordered.length);
    const upTo = Math.min(ordered.length, dropped + Math.max(1, share));
    const cut = new Set(ordered.slice(dropped, upTo));
    for (const entry of Object.values(store.sessions)) {
      for (const key of Object.keys(entry.buckets)) {
        const parsed = parseBucketKey(key);
        if (parsed && cut.has(parsed.date)) delete entry.buckets[key];
      }
    }
    for (const entry of Object.values(store.tools)) {
      for (const key of Object.keys(entry.rows)) {
        const parsed = parseToolKey(key);
        if (parsed && cut.has(parsed.date)) delete entry.rows[key];
      }
    }
    dropped = upTo;
    size = JSON.stringify(store).length;
  }
  return dropped;
};

/** Apply one session's messages to the store, replacing what that session contributed before. */
export const applySession = (store: Store, ref: SessionRef, messages: unknown[]): void => {
  const project = projectKeyOf(ref.directory, store.settings.roots);
  const { buckets } = aggregateMessages(messages, project, ref.agent ?? null);
  store.sessions[ref.id] = { updated: ref.updated, project, ...directoryField(ref.directory), ...parentField(ref.parent), buckets };
  // The same read fills in the tool calls, so a session read for its buckets is not read again for them.
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: aggregateTools(messages) };
  if (ref.updated > store.watermark) store.watermark = ref.updated;
};

/** The tool calls of a session whose buckets are already current: nothing else in the store changes. */
export const applyToolsOnly = (store: Store, ref: SessionRef, messages: unknown[]): void => {
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: aggregateTools(messages) };
};

/** OpenCode refused this session's messages for good: its tool calls are settled as none, until it changes. */
export const applySkippedTools = (store: Store, ref: SessionRef): void => {
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: {} };
};

const parentField = (parent: string | null | undefined): { parent?: string } => (
  typeof parent === 'string' && parent.trim() !== '' ? { parent: parent.trim().slice(0, 200) } : {}
);

/**
 * Mark sessions as subagent sessions from the listing alone, with no message read. Only a parent the
 * listing names is recorded; a missing field is not evidence that a session has no parent, so an
 * existing mark is never cleared. Returns how many sessions were newly marked.
 */
export const markParents = (store: Store, refs: SessionRef[]): number => {
  let marked = 0;
  for (const ref of refs) {
    const entry = store.sessions[ref.id];
    const parent = parentField(ref.parent).parent;
    if (!entry || parent === undefined || entry.parent === parent) continue;
    entry.parent = parent;
    marked += 1;
  }
  return marked;
};

const directoryField = (directory: string | null | undefined): { directory?: string } => (
  typeof directory === 'string' && directory.trim() !== '' ? { directory: directory.trim().slice(0, 500) } : {}
);

export const applySkippedSession = (store: Store, ref: SessionRef, reason: string): void => {
  store.sessions[ref.id] = {
    updated: ref.updated, project: projectKeyOf(ref.directory, store.settings.roots), ...directoryField(ref.directory), ...parentField(ref.parent), buckets: {}, skipped: reason,
  };
  applySkippedTools(store, ref);
  if (ref.updated > store.watermark) store.watermark = ref.updated;
};

/**
 * Re-attribute sessions whose directory now names another project: their buckets move to the
 * new key, replacing the old ones, with no message read. A session whose listing carries no
 * directory keeps its attribution (a missing field is not evidence that the folder changed).
 * Returns how many sessions moved.
 */
export const reattributeSessions = (store: Store, refs: SessionRef[]): number => {
  let moved = 0;
  for (const ref of refs) {
    const entry = store.sessions[ref.id];
    if (!entry || typeof ref.directory !== 'string' || ref.directory.trim() === '') continue;
    const project = projectKeyOf(ref.directory, store.settings.roots);
    if ((entry.project ?? UNATTRIBUTED) === project) {
      if (entry.directory === undefined) entry.directory = directoryField(ref.directory).directory;
      continue;
    }
    entry.buckets = rekeyBuckets(entry.buckets, project);
    entry.project = project;
    entry.directory = directoryField(ref.directory).directory;
    moved += 1;
  }
  return moved;
};

/** After the workspace roots change: every session that kept its directory is keyed again. No message is read. */
export const rekeySessions = (store: Store): number => {
  let moved = 0;
  for (const entry of Object.values(store.sessions)) {
    if (entry.directory === undefined) continue;
    const project = projectKeyOf(entry.directory, store.settings.roots);
    if ((entry.project ?? UNATTRIBUTED) === project) continue;
    entry.buckets = rekeyBuckets(entry.buckets, project);
    entry.project = project;
    moved += 1;
  }
  return moved;
};

/** Sum every session's contribution into one bucket per key. Samples are concatenated. */
export const mergeSessions = (store: Store): Map<string, Bucket> => {
  const merged = new Map<string, Bucket>();
  for (const entry of Object.values(store.sessions)) {
    for (const [key, bucket] of Object.entries(entry.buckets)) {
      let target = merged.get(key);
      if (!target) {
        target = newBucket();
        merged.set(key, target);
      }
      target.messages += bucket.messages;
      target.cost += bucket.cost;
      target.tokens.input += bucket.tokens.input;
      target.tokens.output += bucket.tokens.output;
      target.tokens.reasoning += bucket.tokens.reasoning;
      target.tokens.cacheRead += bucket.tokens.cacheRead;
      target.tokens.cacheWrite += bucket.tokens.cacheWrite;
      target.samples.push(...bucket.samples);
    }
  }
  for (const bucket of merged.values()) finishPercentiles(bucket);
  return merged;
};

// ---- Periods ------------------------------------------------------------

type Accumulator = { cost: number; tokens: number; messages: number; samples: number[] };
const newAcc = (): Accumulator => ({ cost: 0, tokens: 0, messages: 0, samples: [] });
/** Spend, tokens and replies only: for a total or a client, which never show a speed. */
const addTotals = (acc: Accumulator, bucket: Bucket): void => {
  acc.cost += bucket.cost;
  acc.tokens += totalTokens(bucket.tokens);
  acc.messages += bucket.messages;
};
/** As `addTotals`, and the timed samples too, for the providers and models that show p50 and p90. */
const addTo = (acc: Accumulator, bucket: Bucket): void => {
  addTotals(acc, bucket);
  acc.samples.push(...bucket.samples);
};
const sortedPercentiles = (samples: number[]): { p50: number | null; p90: number | null } => {
  const sorted = sortedCopy(samples);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  return { p50: p50 === null ? null : round(p50, 1), p90: p90 === null ? null : round(p90, 1) };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (year: number, month0: number, day: number): string => dateKey(Date.UTC(year, month0, day));
const parseDate = (date: string): number => Date.parse(`${date}T00:00:00Z`);
export const addDays = (date: string, days: number): string => dateKey(parseDate(date) + days * DAY_MS);
export const monthOf = (date: string): string => date.slice(0, 7);
/** `YYYY-MM` shifted by `delta` calendar months. */
export const addMonths = (month: string, delta: number): string => {
  const year = Number(month.slice(0, 4));
  const m0 = Number(month.slice(5, 7)) - 1 + delta;
  return `${year + Math.floor(m0 / 12)}-${pad2(((m0 % 12) + 12) % 12 + 1)}`;
};

/** The UTC date range for a period; `firstDate` anchors "all time". */
export const periodRange = (id: PeriodId, today: string, firstDate: string | null): { from: string; to: string } => {
  const year = Number(today.slice(0, 4));
  const month0 = Number(today.slice(5, 7)) - 1;
  switch (id) {
    case 'today': return { from: today, to: today };
    case 'd7': return { from: addDays(today, -6), to: today };
    case 'd30': return { from: addDays(today, -29), to: today };
    case 'month': return { from: ymd(year, month0, 1), to: today };
    case 'lastMonth': return { from: ymd(year, month0 - 1, 1), to: ymd(year, month0, 0) };
    case 'all': return { from: firstDate ?? today, to: today };
  }
};

const daysBetween = (from: string, to: string): number => Math.round((parseDate(to) - parseDate(from)) / DAY_MS) + 1;

/** Plan windows are percentage windows (5h, weekly, monthly); a money balance alone is not a plan. */
export const planWindowsOf = (snapshot: BalanceSnapshot | null): boolean => (
  snapshot !== null && snapshot.ok
  && Object.entries(snapshot.windows).some(([name, w]) => w.usedPercent !== null && !name.startsWith('credits_balance'))
);

const hasPlanWindows = (snapshot: BalanceSnapshot | null): boolean => (
  snapshot !== null && (planWindowsOf(snapshot) || snapshot.hadPlan === true)
);

type Entry = {
  date: string;
  provider: string;
  model: string;
  project: string;
  category: SpendCategory;
  scope: SpendScope;
  bucket: Bucket;
};

/** Clients shown before the rest are folded into one row. */
export const PROJECTS_SHOWN = 30;
export const OTHERS = 'Others';

/**
 * Rank projects by spend (then replies, then name) with each one's share of the period's spend.
 * `Unattributed` is returned apart and is never folded; the tail past `PROJECTS_SHOWN` is one
 * `Others (n)` row so a long list of folders cannot bury the clients.
 */
export const rankProjects = (
  accs: Map<string, Accumulator>,
  totalCost: number,
  tree: { parents?: Map<string, string>; merged?: Map<string, number> } = {},
): { projects: PeriodProject[]; unattributed: PeriodProject } => {
  const share = (cost: number): number | null => (totalCost > 0 ? (cost / totalCost) * 100 : null);
  const row = (project: string, acc: Accumulator): PeriodProject => ({
    project,
    cost: acc.cost,
    tokens: acc.tokens,
    messages: acc.messages,
    share: share(acc.cost),
    parent: tree.parents?.get(project) ?? null,
    merged: tree.merged?.get(project) ?? 0,
  });
  const ranked = [...accs.entries()]
    .map(([project, acc]) => row(project, acc))
    .sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.project < b.project ? -1 : 1));
  const unattributed = ranked.find((p) => p.project === UNATTRIBUTED) ?? { project: UNATTRIBUTED, cost: 0, tokens: 0, messages: 0, share: share(0), parent: null, merged: 0 };
  if (ranked.length <= PROJECTS_SHOWN) return { projects: ranked, unattributed };
  const head = ranked.slice(0, PROJECTS_SHOWN - 1);
  const tail = ranked.slice(PROJECTS_SHOWN - 1);
  // Keep Unattributed visible in the list even when it falls in the tail.
  const unattributedInTail = tail.find((p) => p.project === UNATTRIBUTED);
  if (unattributedInTail) head.push(unattributedInTail);
  const rest = tail.filter((p) => p.project !== UNATTRIBUTED);
  if (rest.length > 0) {
    const sum = rest.reduce((a, p) => ({ cost: a.cost + p.cost, tokens: a.tokens + p.tokens, messages: a.messages + p.messages }), { cost: 0, tokens: 0, messages: 0 });
    head.push({ project: `${OTHERS} (${rest.length})`, ...sum, share: share(sum.cost), parent: null, merged: 0 });
  }
  return { projects: head, unattributed };
};

/**
 * For each project, the folder it sits in. A project key can come from several directories (two
 * `src` folders): the parent is the one that holds more than half of its sessions, and a project
 * whose sessions sit in many different folders has none, because "merge into parent" would then
 * name a folder that is only one of several.
 */
export const parentMap = (store: Store): Map<string, string> => {
  const counts = new Map<string, Map<string, number>>();
  for (const entry of Object.values(store.sessions)) {
    if (entry.directory === undefined) continue;
    const { project, parent } = placementOf(entry.directory, store.settings.roots);
    if (parent === null || project === UNATTRIBUTED) continue;
    const by = counts.get(project) ?? new Map<string, number>();
    counts.set(project, by);
    by.set(parent, (by.get(parent) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [project, by] of counts) {
    const total = [...by.values()].reduce((a, c) => a + c, 0);
    const best = [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (best && best[1] * 2 > total) out.set(project, best[0]);
  }
  return out;
};

/** A collapsed project's own key follows its parent chain until a project that is not collapsed. */
const resolveProject = (project: string, collapsed: Set<string>, parents: Map<string, string>): string => {
  let at = project;
  const seen = new Set<string>();
  while (collapsed.has(at) && !seen.has(at)) {
    seen.add(at);
    const up = parents.get(at);
    if (!up) break;
    at = up;
  }
  return at;
};

const newTypeTotals = (): TypeTotals => ({ cost: 0, tokens: 0, messages: 0 });
const addType = (t: TypeTotals, bucket: Bucket): void => {
  t.cost += bucket.cost;
  t.tokens += totalTokens(bucket.tokens);
  t.messages += bucket.messages;
};

/** Spend by category and by scope for one period's entries. */
export const buildTypes = (
  entries: Array<Pick<Entry, 'provider' | 'category' | 'scope' | 'bucket'>>,
  totalCost: number,
  totalMessages: number,
): PeriodTypes => {
  const byCategory = new Map<SpendCategory, { totals: TypeTotals; providers: Map<string, TypeTotals & { provider: string; scope: SpendScope }> }>();
  const cloud = newTypeTotals();
  const local = { tokens: 0, messages: 0 };
  for (const { provider, category, scope, bucket } of entries) {
    const slot = byCategory.get(category) ?? { totals: newTypeTotals(), providers: new Map() };
    byCategory.set(category, slot);
    addType(slot.totals, bucket);
    const key = `${provider}|${scope}`;
    const row = slot.providers.get(key) ?? { ...newTypeTotals(), provider, scope };
    slot.providers.set(key, row);
    addType(row, bucket);
    if (scope === 'cloud') addType(cloud, bucket);
    else {
      local.tokens += totalTokens(bucket.tokens);
      local.messages += bucket.messages;
    }
  }
  const categories: TypeCategoryRow[] = SPEND_CATEGORIES.flatMap((category): TypeCategoryRow[] => {
    const slot = byCategory.get(category);
    if (!slot || slot.totals.messages === 0) return [];
    const providers = [...slot.providers.values()]
      .map((r) => ({ ...r, name: providerName(r.provider) }))
      .sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.scope < b.scope ? -1 : 1));
    return [{
      category,
      ...slot.totals,
      share: totalCost > 0 ? (slot.totals.cost / totalCost) * 100 : null,
      replyShare: totalMessages > 0 ? (slot.totals.messages / totalMessages) * 100 : null,
      providers,
    }];
  }).sort((a, b) => b.cost - a.cost || b.messages - a.messages || SPEND_CATEGORIES.indexOf(a.category) - SPEND_CATEGORIES.indexOf(b.category));
  const un = byCategory.get('uncategorised');
  return {
    categories,
    cloud,
    local,
    uncategorised: {
      messages: un?.totals.messages ?? 0,
      cost: un?.totals.cost ?? 0,
      replyShare: totalMessages > 0 ? ((un?.totals.messages ?? 0) / totalMessages) * 100 : null,
    },
  };
};

/** The folders merged into a parent, with their replies over all time, so each can be restored. */
export const collapsedProjects = (store: Store): PanelPayload['collapsedProjects'] => {
  const parents = parentMap(store);
  const replies = new Map<string, number>();
  for (const entry of Object.values(store.sessions)) {
    for (const bucket of Object.values(entry.buckets)) replies.set(entry.project ?? UNATTRIBUTED, (replies.get(entry.project ?? UNATTRIBUTED) ?? 0) + bucket.messages);
  }
  return store.settings.collapsed.map((project) => ({ project, parent: parents.get(project) ?? null, messages: replies.get(project) ?? 0 }));
};

// ---- Surfaces -----------------------------------------------------------

/** Rows shown for skills, MCP servers and other tools; subagent types show fewer. */
export const SURFACE_TOP = 10;
export const SUBAGENT_TYPES_TOP = 5;

type ToolEntry = ParsedToolKey & { row: ToolRow };

/** Every stored tool row, parsed once; a row whose key cannot be read is not part of any figure. */
const toolEntries = (store: Store, today: string): ToolEntry[] => {
  const out: ToolEntry[] = [];
  for (const entry of Object.values(store.tools)) {
    for (const [key, row] of Object.entries(entry.rows)) {
      const parsed = parseToolKey(key);
      if (parsed && parsed.date <= today) out.push({ ...parsed, row });
    }
  }
  return out;
};

/** Most context first, then tokens written, then calls, then name: what a tool put into the conversation is what costs later. */
const bySurface = (a: SurfaceRow, b: SurfaceRow): number => (
  b.contextChars - a.contextChars || b.generated - a.generated || b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
);

/** Spend, tokens, replies and sessions of the subagent sessions inside a date range. Their buckets are the same ones the totals sum. */
const subagentTotals = (store: Store, from: string, to: string): { cost: number; tokens: number; messages: number; sessions: number } => {
  const out = { cost: 0, tokens: 0, messages: 0, sessions: 0 };
  for (const entry of Object.values(store.sessions)) {
    if (entry.parent === undefined) continue;
    let touched = false;
    for (const [key, bucket] of Object.entries(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (!parsed || parsed.date < from || parsed.date > to) continue;
      out.cost += bucket.cost;
      out.tokens += totalTokens(bucket.tokens);
      out.messages += bucket.messages;
      touched = true;
    }
    if (touched) out.sessions += 1;
  }
  return out;
};

/** The Surfaces figures for one period. Pure: the same rows and range always give the same answer. */
export const buildSurfaces = (
  entries: ToolEntry[],
  subagent: { cost: number; tokens: number; messages: number; sessions: number },
  range: { from: string; to: string },
  totals: { cost: number; messages: number },
): PeriodSurfaces => {
  const groups = { skill: new Map<string, SurfaceRow>(), mcp: new Map<string, SurfaceRow>(), agent: new Map<string, SurfaceRow>(), tool: new Map<string, SurfaceRow>() };
  let calls = 0;
  let contextChars = 0;
  for (const { date, cls, name, row } of entries) {
    if (date < range.from || date > range.to) continue;
    calls += row.calls;
    contextChars += row.contextChars;
    const map = groups[cls];
    const into = map.get(name) ?? { name, calls: 0, generated: 0, contextChars: 0 };
    map.set(name, into);
    into.calls += row.calls;
    into.generated += row.generated;
    into.contextChars += row.contextChars;
  }
  const ranked = (map: Map<string, SurfaceRow>, top: number): SurfaceRow[] => [...map.values()].sort(bySurface).slice(0, top);
  const dispatches = [...groups.agent.values()].reduce((sum, r) => sum + r.calls, 0);
  return {
    calls,
    contextChars,
    skills: ranked(groups.skill, SURFACE_TOP),
    mcp: ranked(groups.mcp, SURFACE_TOP),
    other: ranked(groups.tool, SURFACE_TOP),
    subagents: {
      dispatches,
      types: [...groups.agent.values()].sort((a, b) => b.calls - a.calls || bySurface(a, b)).slice(0, SUBAGENT_TYPES_TOP),
      ...subagent,
      share: totals.cost > 0 ? (subagent.cost / totals.cost) * 100 : null,
      replyShare: totals.messages > 0 ? (subagent.messages / totals.messages) * 100 : null,
    },
  };
};

export type LedgerView = Pick<PanelPayload, 'firstDate' | 'periods' | 'months' | 'hasData'> & {
  /** Spend for today, 7 and 30 days, for the status rows and the quota card. */
  totals: { today: RangeTotals; d7: RangeTotals; d30: RangeTotals };
  /** Every provider id the ledger holds, any period. */
  providerIds: string[];
  daily7: SeriesPoint[];
};

const toTotals = (acc: Accumulator): RangeTotals => ({ cost: acc.cost, tokens: acc.tokens, messages: acc.messages });

/**
 * Everything the panel and the status rows draw from the ledger. Pure; the
 * service caches the answer until the store or the UTC date changes.
 */
export const deriveLedger = (store: Store, now: number): LedgerView => {
  const merged = mergeSessions(store);
  const today = dateKey(now);
  const tools = toolEntries(store, today);
  const settings: LedgerSettings = store.settings;
  const parents = parentMap(store);
  const collapsed = new Set(settings.collapsed);
  const entries: Entry[] = [];
  const classes = new Map<string, { category: SpendCategory; scope: SpendScope }>();
  const classify = (provider: string, model: string, agent: string): { category: SpendCategory; scope: SpendScope } => {
    const key = `${provider}|${model}|${agent}`;
    let found = classes.get(key);
    if (!found) {
      found = { category: categoryOf(provider, model, agent, settings), scope: scopeOf(provider, model, settings) };
      classes.set(key, found);
    }
    return found;
  };
  const allTime = new Map<string, { cost: number; messages: number }>();
  let firstDate: string | null = null;
  for (const [key, bucket] of merged) {
    const parsed = parseBucketKey(key);
    if (!parsed || parsed.date > today) continue;
    entries.push({ date: parsed.date, provider: parsed.provider, model: parsed.model, project: parsed.project, ...classify(parsed.provider, parsed.model, parsed.agent), bucket });
    if (firstDate === null || parsed.date < firstDate) firstDate = parsed.date;
    const t = allTime.get(parsed.provider) ?? { cost: 0, messages: 0 };
    t.cost += bucket.cost;
    t.messages += bucket.messages;
    allTime.set(parsed.provider, t);
  }

  const subscription = (provider: string): boolean => {
    const t = allTime.get(provider);
    return t !== undefined && t.messages > 0 && t.cost === 0 && hasPlanWindows(balanceFor(store.balances, provider));
  };

  const periods = {} as Record<PeriodId, PeriodView>;
  for (const id of PERIOD_IDS) {
    const { from, to } = periodRange(id, today, firstDate);
    const days = daysBetween(from, to);
    const granularity: 'day' | 'month' = id === 'all' || days > 31 ? 'month' : 'day';
    const total = newAcc();
    const providers = new Map<string, Accumulator>();
    const models = new Map<string, { provider: string; model: string; acc: Accumulator }>();
    const projects = new Map<string, Accumulator>();
    const mergedInto = new Map<string, Set<string>>();
    const inPeriod: Entry[] = [];
    const series = new Map<string, SeriesPoint>();
    if (granularity === 'day') {
      for (let i = 0; i < days; i += 1) {
        const key = addDays(from, i);
        series.set(key, { key, cost: 0, tokens: 0, messages: 0, byProvider: {} });
      }
    } else if (firstDate !== null || id !== 'all') {
      const last = monthOf(to);
      for (let m = monthOf(from); m <= last; m = addMonths(m, 1)) {
        series.set(m, { key: m, cost: 0, tokens: 0, messages: 0, byProvider: {} });
      }
    }
    for (const entry of entries) {
      const { date, provider, model, project, bucket } = entry;
      if (date < from || date > to) continue;
      inPeriod.push(entry);
      addTotals(total, bucket);
      const shown = resolveProject(project, collapsed, parents);
      if (shown !== project) {
        const set = mergedInto.get(shown) ?? new Set<string>();
        mergedInto.set(shown, set);
        set.add(project);
      }
      const proj = projects.get(shown) ?? newAcc();
      projects.set(shown, proj);
      addTotals(proj, bucket);
      const p = providers.get(provider) ?? newAcc();
      providers.set(provider, p);
      addTo(p, bucket);
      const mKey = `${provider}|${model}`;
      const m = models.get(mKey) ?? { provider, model, acc: newAcc() };
      models.set(mKey, m);
      addTo(m.acc, bucket);
      const point = series.get(granularity === 'day' ? date : monthOf(date));
      if (point) {
        point.cost += bucket.cost;
        point.tokens += totalTokens(bucket.tokens);
        point.messages += bucket.messages;
        point.byProvider[provider] = (point.byProvider[provider] ?? 0) + bucket.cost;
      }
    }

    const providerRows: PeriodProvider[] = [...providers.entries()].map(([provider, acc]) => {
      const sub = subscription(provider);
      const { p50, p90 } = sortedPercentiles(acc.samples);
      return {
        provider,
        name: providerName(provider),
        cost: acc.cost,
        tokens: acc.tokens,
        messages: acc.messages,
        perMillion: sub || acc.tokens <= 0 ? null : (acc.cost / acc.tokens) * 1e6,
        p50,
        p90,
        samples: acc.samples.length,
        subscription: sub,
      };
    });
    providerRows.sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.provider < b.provider ? -1 : 1));

    // Only the ten models the panel shows get a speed: sorting every model's samples is the costly part.
    const modelRows = [...models.values()].map(({ provider, model, acc }) => {
      const sub = subscription(provider);
      return {
        acc,
        row: {
          provider,
          providerName: providerName(provider),
          model,
          cost: acc.cost,
          tokens: acc.tokens,
          messages: acc.messages,
          perMillion: sub || acc.tokens <= 0 ? null : (acc.cost / acc.tokens) * 1e6,
          p50: null,
          subscription: sub,
        } as PeriodModel,
      };
    });
    modelRows.sort((a, b) => b.row.cost - a.row.cost || b.row.tokens - a.row.tokens || (a.row.model < b.row.model ? -1 : 1));
    const topModels: PeriodModel[] = modelRows.slice(0, 10).map(({ acc, row }) => ({ ...row, p50: sortedPercentiles(acc.samples).p50 }));

    const mergedCounts = new Map([...mergedInto].map(([target, sources]) => [target, sources.size]));
    const ranked = rankProjects(projects, total.cost, { parents, merged: mergedCounts });
    periods[id] = {
      id,
      label: PERIOD_LABELS[id],
      from: id === 'all' && firstDate === null ? null : from,
      to,
      totals: toTotals(total),
      providers: providerRows,
      models: topModels,
      projects: ranked.projects,
      unattributed: ranked.unattributed,
      types: buildTypes(inPeriod, total.cost, total.messages),
      surfaces: buildSurfaces(tools, subagentTotals(store, from, to), { from, to }, total),
      granularity,
      series: [...series.values()],
    };
  }

  // The last six calendar months, newest first.
  const thisMonth = monthOf(today);
  const months: MonthRow[] = [];
  for (let i = 0; i < 6; i += 1) {
    const month = addMonths(thisMonth, -i);
    const acc = newAcc();
    const byProvider = new Map<string, { cost: number; messages: number }>();
    for (const { date, provider, bucket } of entries) {
      if (monthOf(date) !== month) continue;
      addTotals(acc, bucket);
      const t = byProvider.get(provider) ?? { cost: 0, messages: 0 };
      t.cost += bucket.cost;
      t.messages += bucket.messages;
      byProvider.set(provider, t);
    }
    const ranked = [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].messages - a[1].messages || (a[0] < b[0] ? -1 : 1));
    const top = ranked[0];
    months.push({
      month,
      cost: acc.cost,
      messages: acc.messages,
      tokens: acc.tokens,
      subscriptionOnly: byProvider.size > 0 && [...byProvider.keys()].every(subscription),
      top: top ? { provider: top[0], name: providerName(top[0]), cost: top[1].cost, messages: top[1].messages, by: top[1].cost > 0 ? 'spend' : 'replies' } : null,
    });
  }

  const d7 = periods.d7;
  return {
    firstDate,
    periods,
    months,
    hasData: entries.length > 0,
    totals: { today: periods.today.totals, d7: d7.totals, d30: periods.d30.totals },
    providerIds: [...allTime.keys()],
    daily7: d7.series,
  };
};

// ---- Balances -----------------------------------------------------------

const snapshotRank = (s: BalanceSnapshot): number => (
  s.ok ? (Object.keys(s.windows).length > 0 ? 3 : 2) : 1
);

/** The best snapshot for an account: a clean read beats a failed one, then the fresher read wins. */
const bestSnapshot = (balances: Record<string, BalanceSnapshot>, account: string): BalanceSnapshot | null => {
  let best: BalanceSnapshot | null = null;
  for (const s of Object.values(balances)) {
    if (canonicalProvider(s.provider) !== account) continue;
    if (!best || snapshotRank(s) > snapshotRank(best) || (snapshotRank(s) === snapshotRank(best) && s.fetchedAt > best.fetchedAt)) best = s;
  }
  return best;
};

/** The snapshot for a provider id, falling back to another id for the same account. */
export const balanceFor = (balances: Record<string, BalanceSnapshot>, provider: string): BalanceSnapshot | null => {
  const direct = balances[provider];
  if (direct && direct.ok) return direct;
  return bestSnapshot(balances, canonicalProvider(provider)) ?? direct ?? null;
};

const WINDOW_NAMES: Record<string, string> = { '5h': '5h', weekly: 'Weekly', monthly: 'Monthly' };
const WINDOW_ORDER = ['5h', 'weekly', 'monthly'];

const windowTitle = (name: string): string => {
  const known = WINDOW_NAMES[name];
  if (known) return known;
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const pct = (value: number): string => `${Math.round(value)}% used`;

/**
 * One card per account: every provider the ledger holds replies for, plus any
 * account that read cleanly without spend. Money first, then plan windows, then
 * the rest alphabetically. A failed or absent read is a line of words, never $0.00.
 */
export const buildBalanceCards = (balances: Record<string, BalanceSnapshot>, ledgerProviders: string[]): BalanceCard[] => {
  const ledgerAccounts = new Set(ledgerProviders.map(canonicalProvider));
  const accounts = new Set<string>(ledgerAccounts);
  for (const s of Object.values(balances)) if (s.ok) accounts.add(canonicalProvider(s.provider));

  const cards: BalanceCard[] = [];
  for (const account of accounts) {
    const snapshot = bestSnapshot(balances, account);
    const base = { account, name: providerName(account), planLabel: null, headline: null, headlineNote: null, windows: [], note: null, fetchedAt: snapshot?.fetchedAt ?? null } as const;
    if (!snapshot) {
      cards.push({ ...base, windows: [], state: 'unread', note: 'Not read yet' });
      continue;
    }
    if (!snapshot.ok) {
      if (snapshot.needsSignIn) cards.push({ ...base, windows: [], state: 'signin', note: 'Sign in again', headlineNote: snapshot.error ?? null });
      else cards.push({ ...base, windows: [], state: 'failed', note: snapshot.error ?? 'Balance could not be read' });
      continue;
    }
    const entries = Object.entries(snapshot.windows);
    const credits = snapshot.windows.credits_balance ?? entries.find(([n]) => n.startsWith('credits_balance'))?.[1];
    const spendWindow = entries.find(([, w]) => w.usedPercent !== null && w.value?.kind === 'spend' && w.valueLabel);
    let headline: string | null = null;
    let headlineNote: string | null = null;
    let headlineWindow: string | null = null;
    if (credits?.valueLabel) {
      headline = credits.valueLabel;
      headlineNote = 'credits';
    } else if (spendWindow && spendWindow[1].valueLabel) {
      headline = spendWindow[1].valueLabel;
      headlineNote = windowTitle(spendWindow[0]).toLowerCase();
      headlineWindow = spendWindow[0];
    }
    const bars = entries
      .filter(([name, w]) => w.usedPercent !== null && !name.startsWith('credits_balance'))
      .sort((a, b) => {
        const ia = WINDOW_ORDER.indexOf(a[0]);
        const ib = WINDOW_ORDER.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a[0] < b[0] ? -1 : 1);
      })
      .map(([name, window]) => {
        const used = window.usedPercent ?? 0;
        // The label the provider gave (`$0.00 left`) rides along unless it is already the headline.
        const extra = window.valueLabel && name !== headlineWindow ? ` · ${window.valueLabel}` : '';
        return { name, title: windowTitle(name), used: Math.min(100, Math.max(0, used)), detail: `${pct(used)}${extra}`, resetAt: window.resetAt ?? null };
      });
    const state = headline !== null ? 'money' : bars.length > 0 ? 'windows' : 'none';
    cards.push({
      ...base,
      state,
      planLabel: snapshot.planLabel ?? null,
      headline,
      headlineNote,
      windows: bars,
      note: state === 'none' ? 'No balance API — spend is in the ledger' : null,
    });
  }

  const rank = (c: BalanceCard): number => (c.state === 'money' ? 0 : c.state === 'windows' ? 1 : 2);
  // OpenCode Zen and Go draw on one Console credit balance; a Zen card with no replies of its own
  // that repeats another card's credits adds nothing.
  const repeatsCredits = (c: BalanceCard): boolean => (
    !ledgerAccounts.has(c.account) && c.state === 'money' && c.headlineNote === 'credits'
    && cards.some((o) => o !== c && ledgerAccounts.has(o.account) && o.headline === c.headline && o.headlineNote === 'credits')
  );
  // Accounts with no ledger replies and nothing to show are not worth a card.
  return cards
    .filter((c) => !repeatsCredits(c))
    .filter((c) => ledgerAccounts.has(c.account) || c.state === 'money' || c.state === 'windows')
    .sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};
