// What a reply was for (category) and where it ran (scope), and the settings those rules read.
import type { LedgerSettings, SpendCategory, SpendScope } from '../shared/types.ts';

/** The agent id stored on a bucket when nothing says which agent was in force. */
export const UNKNOWN_AGENT = '?';

export const DEFAULT_SETTINGS: LedgerSettings = {
  roots: [],
  localProviders: ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'llama.cpp'],
  utilityModels: [],
  codingAgents: ['build'],
  imagePatterns: ['gpt-image', 'dall-e', 'imagen', 'flux', 'seedream', 'recraft', 'ideogram', 'sdxl', 'stable-diffusion'],
  collapsed: [],
};

export const defaultSettings = (): LedgerSettings => ({
  roots: [...DEFAULT_SETTINGS.roots],
  localProviders: [...DEFAULT_SETTINGS.localProviders],
  utilityModels: [...DEFAULT_SETTINGS.utilityModels],
  codingAgents: [...DEFAULT_SETTINGS.codingAgents],
  imagePatterns: [...DEFAULT_SETTINGS.imagePatterns],
  collapsed: [...DEFAULT_SETTINGS.collapsed],
});

const LIST_MAX = 100;
const ITEM_MAX = 200;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An embedding model is never anything else, so this rule is fixed rather than a setting. */
const EMBEDDING = /embed|(^|[/:_-])bge-/i;

/** `*` matches anything; everything else is literal; the whole id must match. */
const globMatches = (pattern: string, value: string): boolean => {
  if (!pattern.includes('*')) return same(pattern, value);
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
};

export const isLocalProvider = (provider: string, settings: LedgerSettings): boolean => (
  settings.localProviders.some((id) => same(id, provider))
);

/** Local when the provider is a local runtime, unless the model is one of its hosted `:cloud` models. */
export const scopeOf = (provider: string, model: string, settings: LedgerSettings): SpendScope => {
  if (!isLocalProvider(provider, settings)) return 'cloud';
  return model.trim().toLowerCase().endsWith(':cloud') ? 'cloud' : 'local';
};

export const isImageModel = (model: string, settings: LedgerSettings): boolean => {
  const id = model.toLowerCase();
  return settings.imagePatterns.some((pattern) => pattern !== '' && id.includes(pattern.toLowerCase()));
};

export const isEmbeddingModel = (model: string): boolean => EMBEDDING.test(model);

export const isUtilityModel = (provider: string, model: string, settings: LedgerSettings): boolean => (
  settings.utilityModels.some((entry) => globMatches(entry, model) || globMatches(entry, `${provider}/${model}`))
);

/**
 * The category of a reply, in this order: image model, embedding model, a model the user lists
 * as utility, then by the agent in force: unknown is `uncategorised` (never a guess), a coding
 * agent is `coding`, any other agent is `agentic`.
 */
export const categoryOf = (provider: string, model: string, agent: string, settings: LedgerSettings): SpendCategory => {
  if (isImageModel(model, settings)) return 'image';
  if (isEmbeddingModel(model)) return 'embedding';
  if (isUtilityModel(provider, model, settings)) return 'utility';
  if (agent === UNKNOWN_AGENT || agent.trim() === '') return 'uncategorised';
  return settings.codingAgents.some((id) => same(id, agent)) ? 'coding' : 'agentic';
};

// ---- Settings from a request ----------------------------------------------

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

type ListOptions = { absolute?: boolean; lower?: boolean };

const cleanList = (value: unknown, label: string, options: ListOptions): { ok: true; list: string[] } | { ok: false; error: string } => {
  if (!Array.isArray(value)) return { ok: false, error: `${label} must be a list.` };
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return { ok: false, error: `${label} may only hold text.` };
    // eslint-disable-next-line no-control-regex
    let item = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (item === '') continue;
    if (item.length > ITEM_MAX) return { ok: false, error: `${label}: "${item.slice(0, 40)}…" is longer than ${ITEM_MAX} characters.` };
    if (options.absolute) {
      if (!isAbsolute(item)) return { ok: false, error: `${label}: "${item}" is not an absolute path. Start it with / (or a drive letter).` };
      item = item.replace(/[\\/]+$/, '') || item;
    }
    if (options.lower) item = item.toLowerCase();
    const seen = out.some((existing) => (options.absolute ? existing === item : same(existing, item)));
    if (!seen) out.push(item);
  }
  if (out.length > LIST_MAX) return { ok: false, error: `${label} may hold at most ${LIST_MAX} entries.` };
  return { ok: true, list: out };
};

const FIELDS: Array<{ key: keyof LedgerSettings; label: string } & ListOptions> = [
  { key: 'roots', label: 'Workspace roots', absolute: true },
  { key: 'localProviders', label: 'Local provider ids', lower: true },
  { key: 'utilityModels', label: 'Utility models' },
  { key: 'codingAgents', label: 'Coding agents' },
  { key: 'imagePatterns', label: 'Image patterns' },
  { key: 'collapsed', label: 'Merged folders' },
];

/**
 * Settings from a request or a file. A key that is absent keeps `base`; a key that is present replaces
 * it and is validated. Unknown keys are ignored. `strict` refuses a bad value with its reason; otherwise
 * a bad value is dropped and `base` kept (a file edited by hand must not stop the service).
 */
export const mergeSettings = (
  base: LedgerSettings,
  input: unknown,
  strict: boolean,
): { ok: true; settings: LedgerSettings } | { ok: false; error: string } => {
  const settings: LedgerSettings = { ...base };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return strict ? { ok: false, error: 'The settings were not an object.' } : { ok: true, settings };
  }
  const record = input as Record<string, unknown>;
  for (const field of FIELDS) {
    if (!(field.key in record)) continue;
    const cleaned = cleanList(record[field.key], field.label, field);
    if (!cleaned.ok) {
      if (strict) return cleaned;
      continue;
    }
    settings[field.key] = cleaned.list;
  }
  return { ok: true, settings };
};

/** The rules back to the shipped defaults; roots and merged folders are the user's own data and stay. */
export const resetRules = (current: LedgerSettings): LedgerSettings => ({
  ...defaultSettings(),
  roots: [...current.roots],
  collapsed: [...current.collapsed],
});
