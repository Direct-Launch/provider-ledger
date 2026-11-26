// Types shared by the service and the panel. Type-only: nothing here ships code.
import type { QuotaProviderWindow } from '@openchamber/sdk';

export type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

/** One `YYYY-MM-DD|provider|model|project|agent` bucket, or one session's contribution to it. */
export type Bucket = {
  messages: number;
  tokens: Tokens;
  cost: number;
  /** Per-message tokens/second, capped; the source of p50 and p90. */
  samples: number[];
  p50: number | null;
  p90: number | null;
};

export type SessionEntry = {
  /** `time.updated` of the session when its messages were read. */
  updated: number;
  /** The project key its buckets carry (a folder name, `Chats`, `Unattributed`). */
  project?: string;
  /** The directory the session ran in, so a change of workspace roots can re-key it without reading a message. */
  directory?: string;
  /** The session this one was spawned from, when OpenCode says so: it is a subagent session. */
  parent?: string;
  buckets: Record<string, Bucket>;
  /** Set when OpenCode refused this session's messages for good (4xx); retried only once it changes. */
  skipped?: string;
};

/** What one tool did in one day's replies of one model: calls, tokens written while calling it, characters it returned. */
export type ToolRow = {
  calls: number;
  /** Output and reasoning tokens of the replies that called it (once per reply, however many times it was called in it). */
  generated: number;
  /** Characters of the tool's returned text; 0 for a call that had not completed. */
  contextChars: number;
};

/**
 * One session's tool calls, keyed `date|provider|model|class|name`. `toolsSynced` is the
 * session's `time.updated` when its messages were read for tools: the marker that lets an
 * unchanged session be skipped and an interrupted backfill resume.
 */
export type SessionTools = {
  toolsSynced: number;
  rows: Record<string, ToolRow>;
};

export type WindowSnapshot = QuotaProviderWindow;

export type BalanceSnapshot = {
  provider: string;
  fetchedAt: number;
  ok: boolean;
  configured: boolean;
  /** Why the read failed, or (with `ok`) what this provider cannot tell. */
  error?: string;
  /** The OpenCode Console sign-in is expired or refused: the fix is to sign in again. */
  needsSignIn?: boolean;
  /** Plan windows were read for this account at some point, so a later failed read does not turn it into a pay-per-use provider. */
  hadPlan?: boolean;
  planLabel?: string | null;
  windows: Record<string, WindowSnapshot>;
};

export type OllamaUsageModel = {
  model: string;
  usageUsd: number | null;
  requests: number | null;
  tokens: number | null;
};

export type OllamaUsage = {
  fetchedAt: number;
  range: string;
  models: OllamaUsageModel[];
};

/** Version 4 put the agent in force into the bucket key (version 3 put the project there); older stores are re-read, not converted. */
export const STORE_VERSION = 4;

/** Where a reply ran: on this machine, or at a provider that charges for it. */
export type SpendScope = 'local' | 'cloud';

export const SPEND_CATEGORIES = ['coding', 'agentic', 'utility', 'image', 'embedding', 'uncategorised'] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<SpendCategory, string> = {
  coding: 'Coding',
  agentic: 'Agentic',
  utility: 'Utility',
  image: 'Image',
  embedding: 'Embedding',
  uncategorised: 'Uncategorised',
};

/** What each category means, for the tooltip and the Types tab. */
export const CATEGORY_HINTS: Record<SpendCategory, string> = {
  coding: 'Replies from a coding agent',
  agentic: 'Replies from any other agent (planning, exploring, research)',
  utility: 'Models you listed as classification, routing or titling',
  image: 'Image-generation models',
  embedding: 'Embedding models',
  uncategorised: 'The agent behind the reply could not be read, so it is not guessed',
};

/** The rules that turn a reply into a scope and a category, plus where projects are rooted. Editable in the panel. */
export type LedgerSettings = {
  /** Absolute folders. A session under one is keyed by the first folder below it. */
  roots: string[];
  /** Provider ids that run on this machine. A model id ending `:cloud` is cloud even on these. */
  localProviders: string[];
  /** Model ids (or `provider/model`, `*` wildcards allowed) that are classification, routing or titling calls. */
  utilityModels: string[];
  /** Agent ids whose replies are coding; every other agent is agentic. */
  codingAgents: string[];
  /** Case-insensitive fragments that mark an image-generation model id. */
  imagePatterns: string[];
  /** Project keys merged into their parent folder in the Clients view. */
  collapsed: string[];
};

export type Store = {
  version: typeof STORE_VERSION;
  /** Newest `time.updated` among the sessions read so far. */
  watermark: number;
  /** When the last sync run got a session list; null until the first one. */
  syncedAt: number | null;
  lastError: string | null;
  /** Sessions still waiting after the last run. */
  pending: number;
  sessions: Record<string, SessionEntry>;
  /**
   * Tool calls by session id. A second, resumable pass: it does not belong to the store version,
   * so a store written before it simply starts with none and fills in newest first.
   */
  tools: Record<string, SessionTools>;
  /** Sessions whose tool calls are still to be read. */
  toolsPending: number;
  balances: Record<string, BalanceSnapshot>;
  ollamaUsage: OllamaUsage | null;
  /** Monthly caps in USD by provider id. A provider with no entry has no cap. */
  budgets: Record<string, number>;
  settings: LedgerSettings;
  /** The history is being read again after a store migration; figures are partial until it is done. */
  rebuilding?: boolean;
};

export type RangeTotals = { cost: number; tokens: number; messages: number };

/** The ranges the panel can show. All are UTC dates, inclusive. */
export const PERIOD_IDS = ['today', 'd7', 'd30', 'month', 'lastMonth', 'all'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];

export const PERIOD_LABELS: Record<PeriodId, string> = {
  today: 'Today',
  d7: '7 days',
  d30: '30 days',
  month: 'This month',
  lastMonth: 'Last month',
  all: 'All time',
};

export type PeriodProvider = {
  provider: string;
  name: string;
  cost: number;
  tokens: number;
  messages: number;
  /** Blended dollars per million tokens (all token kinds), or null with no tokens or on a subscription. */
  perMillion: number | null;
  p50: number | null;
  p90: number | null;
  samples: number;
  /** Every reply ever recorded carried cost 0 and the provider has plan windows: spend is included in a plan. */
  subscription: boolean;
};

export type PeriodModel = {
  provider: string;
  providerName: string;
  model: string;
  cost: number;
  tokens: number;
  messages: number;
  perMillion: number | null;
  p50: number | null;
  subscription: boolean;
};

/** One client or project in a period: spend, replies and tokens, with its share of the period's spend. */
export type PeriodProject = {
  project: string;
  cost: number;
  tokens: number;
  messages: number;
  /** Percent of the period's spend (0–100); null when the period has no spend at all. */
  share: number | null;
  /** The folder this one sits in, when it can be merged into it; null for a root-level project, `Chats` and `Unattributed`. */
  parent: string | null;
  /** How many merged folders this row already includes. */
  merged: number;
};

/** Spend, replies and tokens of one slice of a period. */
export type TypeTotals = { cost: number; tokens: number; messages: number };

export type TypeCategoryRow = TypeTotals & {
  category: SpendCategory;
  /** Percent of the period's spend; null when the period has no spend. */
  share: number | null;
  /** Percent of the period's replies. */
  replyShare: number | null;
  providers: Array<TypeTotals & { provider: string; name: string; scope: SpendScope }>;
};

/** The Types tab for one period. */
export type PeriodTypes = {
  /** Categories with replies, most spend first (replies break ties). */
  categories: TypeCategoryRow[];
  /** Cloud replies cost money; local replies are counted in replies and tokens only. */
  cloud: TypeTotals;
  local: Omit<TypeTotals, 'cost'>;
  /** What could not be classified because the agent is unknown. */
  uncategorised: { messages: number; cost: number; replyShare: number | null };
};

/** One skill, MCP server, subagent type or other tool in a period. */
export type SurfaceRow = {
  name: string;
  calls: number;
  /** Tokens written (output and reasoning) in the replies that called it. */
  generated: number;
  /** Characters it put into the conversation. */
  contextChars: number;
};

/** The Surfaces tab for one period. */
export type PeriodSurfaces = {
  /** Every tool call in the period, whatever its class. */
  calls: number;
  contextChars: number;
  /** Top ten of each, most context added first. */
  skills: SurfaceRow[];
  mcp: SurfaceRow[];
  other: SurfaceRow[];
  subagents: {
    /** Calls to the subagent tool. */
    dispatches: number;
    /** Top subagent types by dispatches. */
    types: SurfaceRow[];
    /** Sessions run by a subagent that have replies in the period. */
    sessions: number;
    /** Their spend, tokens and replies: already inside the period's totals, never added to them. */
    cost: number;
    tokens: number;
    messages: number;
    /** Percent of the period's spend; null when the period has no spend. */
    share: number | null;
    /** Percent of the period's replies. */
    replyShare: number | null;
  };
};

/** One bar: a UTC day (`YYYY-MM-DD`) or a UTC month (`YYYY-MM`). */
export type SeriesPoint = {
  key: string;
  cost: number;
  tokens: number;
  messages: number;
  byProvider: Record<string, number>;
};

export type PeriodView = {
  id: PeriodId;
  label: string;
  /** First and last UTC date of the range; `from` is null when the ledger holds nothing. */
  from: string | null;
  to: string;
  totals: RangeTotals;
  providers: PeriodProvider[];
  models: PeriodModel[];
  /** Ranked by spend; the long tail is folded into one `Others` row. `Unattributed` is never folded. */
  projects: PeriodProject[];
  /** What no client or folder could be named for; always present, zero when there is none. */
  unattributed: PeriodProject;
  /** Spend by category and by scope. */
  types: PeriodTypes;
  surfaces: PeriodSurfaces;
  granularity: 'day' | 'month';
  series: SeriesPoint[];
};

export type MonthRow = {
  /** `YYYY-MM` */
  month: string;
  cost: number;
  messages: number;
  tokens: number;
  /** Every provider with replies that month is plan-included, so the month has no per-reply spend. */
  subscriptionOnly: boolean;
  top: { provider: string; name: string; cost: number; messages: number; by: 'spend' | 'replies' } | null;
};

export type BalanceState = 'money' | 'windows' | 'none' | 'signin' | 'failed' | 'unread';

/** One account's balance card, built by the service so the panel only draws. */
export type BalanceCard = {
  account: string;
  name: string;
  state: BalanceState;
  planLabel: string | null;
  /** The money left, as the provider labels it (`$7.88`, `$0.00 left`), when there is one. */
  headline: string | null;
  headlineNote: string | null;
  /** Plan windows with a percentage, in display order. */
  windows: Array<{ name: string; title: string; used: number; detail: string; resetAt: number | null }>;
  note: string | null;
  fetchedAt: number | null;
};

export type BudgetState = 'none' | 'ok' | 'warning' | 'error';

/** One provider's month-to-date spend against its cap. */
export type BudgetRow = {
  provider: string;
  name: string;
  capUsd: number | null;
  /** This UTC month so far, the same range as the "This month" period. */
  spentUsd: number;
  remainingUsd: number | null;
  /** Percent of the cap used; null with no cap. */
  share: number | null;
  state: BudgetState;
  /** The money left on the provider as it labels it, or null when no balance could be read. */
  balance: string | null;
};

export type PanelPayload = {
  now: number;
  syncedAt: number | null;
  stale: boolean;
  syncing: boolean;
  pending: number;
  lastError: string | null;
  sessionsTracked: number;
  hasData: boolean;
  /** The first UTC date the ledger holds, or null when empty. */
  firstDate: string | null;
  periods: Record<PeriodId, PeriodView>;
  /** The last six calendar months, newest first. */
  months: MonthRow[];
  balances: BalanceCard[];
  balancesFetchedAt: number | null;
  ollamaUsage: OllamaUsage | null;
  budgets: BudgetRow[];
  /** Providers at or over 100 % of their cap: the rail badge. */
  overCap: number;
  /** The history is being read again after an upgrade: figures are partial until `pending` reaches 0. */
  rebuilding: boolean;
  /** Sessions whose tool calls have been read, and how many are still to be. */
  toolsRead: number;
  toolsPending: number;
  settings: LedgerSettings;
  defaults: LedgerSettings;
  /** Folders merged into a parent, so they can be restored. */
  collapsedProjects: Array<{ project: string; parent: string | null; messages: number }>;
};

export type SettingsResult = { ok: true; settings: LedgerSettings } | { ok: false; error: string };

export type BudgetResult = { ok: true; capUsd: number | null } | { ok: false; error: string };

export type ExportResult =
  | { ok: true; path: string; rows: number; fellBack: boolean }
  | { ok: false; error: string };

export type SyncResult = {
  syncedAt: number | null;
  sessions: number;
  pending: number;
  running?: boolean;
  error?: string;
};
