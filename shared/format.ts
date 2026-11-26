// Number and label formatting shared by the status rows and the panel.
// A missing value is always the em dash, never a zero.

export const DASH = '—';

export const money = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
};

/** Dollars per million tokens, with more precision for cheap models. */
export const pricePerMillion = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value > 0 && value < 0.01) return '<$0.01';
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
};

export const compact = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
};

export const tokensPerSecond = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
};

export const percent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${Math.round(value)}%`;
};

export const ago = (from: number | null | undefined, now: number): string => {
  if (from === null || from === undefined) return DASH;
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const KNOWN_NAMES: Record<string, string> = {
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode Zen',
  'ollama-cloud': 'Ollama Cloud',
  'console-ollama-cloud': 'Ollama Cloud (Console)',
  ollama: 'Ollama',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
};

/** Ids that name one account: Ollama Cloud's key is stored under any of three ids. */
export const canonicalProvider = (id: string): string => (
  id === 'ollama' || id === 'console-ollama-cloud' ? 'ollama-cloud' : id
);

export const providerName = (id: string): string => {
  const known = KNOWN_NAMES[id];
  if (known) return known;
  return id.split(/[-_.]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || id;
};

export const windowLabel = (name: string): string => {
  if (name === 'credits_balance' || name.startsWith('credits_balance_')) return name.replace('credits_balance', 'balance').replace('_', ' ');
  if (name === 'weekly') return 'weekly';
  if (name === 'monthly') return 'monthly';
  return name;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-12` to `12 Nov`, with the year when it is not `thisYear`. */
export const shortDate = (date: string, thisYear?: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  const base = `${Number(m[3])} ${month}`;
  return thisYear !== undefined && Number(m[1]) !== thisYear ? `${base} ${m[1]}` : base;
};

/** `2026-11` to `Nov`, or `Nov 2025` when it is not `thisYear`. */
export const monthName = (month: string, thisYear?: number): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const name = MONTHS[Number(m[2]) - 1] ?? m[2];
  return thisYear !== undefined && Number(m[1]) === thisYear ? (name ?? month) : `${name} ${m[1]}`;
};

/** `resets in 2h 10m`, `resets in 3 days`; null with no reset time. */
export const resetIn = (resetAt: number | null | undefined, now: number): string | null => {
  if (resetAt === null || resetAt === undefined || !Number.isFinite(resetAt)) return null;
  const minutes = Math.round((resetAt - now) / 60_000);
  if (minutes <= 0) return 'resetting now';
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `resets in ${h}h` : `resets in ${h}h ${m}m`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `resets in ${days} days`;
};

/** `4 minutes ago`, `just now`. */
export const agoLong = (from: number | null | undefined, now: number): string => {
  if (from === null || from === undefined) return DASH;
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
};

export type CapParse = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * A cap typed into the panel. Empty clears it; `25`, `$25` and `1,250.50` are dollars; another
 * currency, zero, a negative or anything that is not a plain number is refused with a reason.
 */
export const parseCap = (text: string): CapParse => {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (/[£€¥₹]|^(gbp|eur)\b/i.test(trimmed)) return { ok: false, error: 'The ledger holds dollars (USD) only. Type the cap in dollars.' };
  const plain = trimmed.replace(/^\$\s*/, '').replace(/\s*usd$/i, '').replace(/,/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(plain)) {
    return { ok: false, error: /^-/.test(plain) ? 'A cap must be more than $0.' : 'A cap is a number of dollars, such as 25 or 12.50.' };
  }
  const value = Number(plain);
  if (!Number.isFinite(value)) return { ok: false, error: 'A cap is a number of dollars, such as 25 or 12.50.' };
  if (value <= 0) return { ok: false, error: 'A cap must be more than $0. Clear the field to remove the cap.' };
  return { ok: true, value };
};

/** A share of a total: `<1%` for a sliver, so a client with real spend never reads as 0%. */
export const shareText = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  if (value > 0 && value < 0.5) return '<1%';
  return `${Math.round(value)}%`;
};
