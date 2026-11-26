// service/main.ts
import http from "node:http";

// service/app.ts
import { timingSafeEqual } from "node:crypto";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var GUEST_PROVIDER_LOGO_BYTES_MAX = 1024 * 1024;
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_WIRE_VERSION = 1;
var QUOTA_PROVIDER_METHODS = ["usage.read"];
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
var isQuotaProviderMethod = (value) => QUOTA_PROVIDER_METHODS.some((method) => method === value);
var readQuotaProviderRequest = (body) => {
  let wire;
  try {
    const parsed = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null)
      return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, method, provider, input } = wire;
  if (v !== QUOTA_PROVIDER_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (String(provider) !== provider || provider.length === 0)
    return null;
  if (String(method) !== method || !isQuotaProviderMethod(method))
    return null;
  if (Object(input) !== input || input === null || input === undefined || Array.isArray(input))
    return null;
  const { credentials } = input;
  if (Object(credentials) !== credentials || credentials === null || Array.isArray(credentials))
    return null;
  if (Object.values(Object(credentials)).some((credential) => Object(credential) !== credential || credential === null || Array.isArray(credential)))
    return null;
  return { v: QUOTA_PROVIDER_WIRE_VERSION, requestId, method, provider, input: { credentials } };
};
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// shared/format.ts
var DASH = "—";
var money = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  if (value > 0 && value < 0.01)
    return "<$0.01";
  return `$${value.toFixed(2)}`;
};
var compact = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e9)
    return `${(value / 1e9).toFixed(abs >= 10000000000 ? 0 : 1)}B`;
  if (abs >= 1e6)
    return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1000)
    return `${(value / 1000).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
};
var percent = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value))
    return DASH;
  return `${Math.round(value)}%`;
};
var ago = (from, now) => {
  if (from === null || from === undefined)
    return DASH;
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 45)
    return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};
var KNOWN_NAMES = {
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  "ollama-cloud": "Ollama Cloud",
  "console-ollama-cloud": "Ollama Cloud (Console)",
  ollama: "Ollama",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter"
};
var canonicalProvider = (id) => id === "ollama" || id === "console-ollama-cloud" ? "ollama-cloud" : id;
var providerName = (id) => {
  const known = KNOWN_NAMES[id];
  if (known)
    return known;
  return id.split(/[-_.]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || id;
};
var windowLabel = (name) => {
  if (name === "credits_balance" || name.startsWith("credits_balance_"))
    return name.replace("credits_balance", "balance").replace("_", " ");
  if (name === "weekly")
    return "weekly";
  if (name === "monthly")
    return "monthly";
  return name;
};

// shared/types.ts
var STORE_VERSION = 4;
var SPEND_CATEGORIES = ["coding", "agentic", "utility", "image", "embedding", "uncategorised"];
var PERIOD_IDS = ["today", "d7", "d30", "month", "lastMonth", "all"];
var PERIOD_LABELS = {
  today: "Today",
  d7: "7 days",
  d30: "30 days",
  month: "This month",
  lastMonth: "Last month",
  all: "All time"
};

// service/attribution.ts
var UNATTRIBUTED = "Unattributed";
var CHATS = "Chats";
var KEY_MAX = 80;
var cleanKey = (name) => name.replace(/[|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, KEY_MAX).trim();
var segmentsOf = (path) => path.split(/[\\/]+/).map((s) => s.trim()).filter((s) => s !== "" && s !== ".");
var DRIVE = /^[A-Za-z]:$/;
var isAbsolute = (path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
var sameSegment = (a, b, insensitive) => insensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
var rootOf = (all, directory, roots) => {
  if (!isAbsolute(directory))
    return 0;
  const insensitive = DRIVE.test(all[0] ?? "");
  let best = 0;
  for (const root of roots) {
    const r = segmentsOf(root);
    if (r.length === 0 || r.length <= best || all.length <= r.length)
      continue;
    if (r.every((segment, i) => sameSegment(segment, all[i] ?? "", insensitive)))
      best = r.length;
  }
  return best;
};
var placementOf = (directory, roots = []) => {
  const none = { project: UNATTRIBUTED, parent: null };
  if (typeof directory !== "string" || directory.trim() === "")
    return none;
  const trimmed = directory.trim();
  const all = segmentsOf(trimmed);
  if (all.length === 0)
    return none;
  const chats = all.findIndex((s, i) => s === ".config" && all[i + 1] === "openchamber" && all[i + 2] === "chats");
  if (chats >= 0 && chats + 3 < all.length)
    return { project: CHATS, parent: null };
  const depth = rootOf(all, trimmed, roots);
  if (depth > 0) {
    const name = cleanKey(all[depth] ?? "");
    if (name !== "")
      return { project: name, parent: null };
  }
  const own = cleanKey(all[all.length - 1] ?? "");
  if (own === "")
    return none;
  const above = all.length >= 2 ? all[all.length - 2] ?? "" : "";
  const parent = above !== "" && !DRIVE.test(above) ? cleanKey(above) : "";
  return { project: own, parent: parent !== "" && parent !== own ? parent : null };
};
var projectKeyOf = (directory, roots = []) => placementOf(directory, roots).project;

// service/spend.ts
var UNKNOWN_AGENT = "?";
var DEFAULT_SETTINGS = {
  roots: [],
  localProviders: ["ollama", "lmstudio", "llamacpp", "vllm", "llama.cpp"],
  utilityModels: [],
  codingAgents: ["build"],
  imagePatterns: ["gpt-image", "dall-e", "imagen", "flux", "seedream", "recraft", "ideogram", "sdxl", "stable-diffusion"],
  collapsed: []
};
var defaultSettings = () => ({
  roots: [...DEFAULT_SETTINGS.roots],
  localProviders: [...DEFAULT_SETTINGS.localProviders],
  utilityModels: [...DEFAULT_SETTINGS.utilityModels],
  codingAgents: [...DEFAULT_SETTINGS.codingAgents],
  imagePatterns: [...DEFAULT_SETTINGS.imagePatterns],
  collapsed: [...DEFAULT_SETTINGS.collapsed]
});
var LIST_MAX = 100;
var ITEM_MAX = 200;
var same = (a, b) => a.toLowerCase() === b.toLowerCase();
var EMBEDDING = /embed|(^|[/:_-])bge-/i;
var globMatches = (pattern, value) => {
  if (!pattern.includes("*"))
    return same(pattern, value);
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
};
var isLocalProvider = (provider, settings) => settings.localProviders.some((id) => same(id, provider));
var scopeOf = (provider, model, settings) => {
  if (!isLocalProvider(provider, settings))
    return "cloud";
  return model.trim().toLowerCase().endsWith(":cloud") ? "cloud" : "local";
};
var isImageModel = (model, settings) => {
  const id = model.toLowerCase();
  return settings.imagePatterns.some((pattern) => pattern !== "" && id.includes(pattern.toLowerCase()));
};
var isEmbeddingModel = (model) => EMBEDDING.test(model);
var isUtilityModel = (provider, model, settings) => settings.utilityModels.some((entry) => globMatches(entry, model) || globMatches(entry, `${provider}/${model}`));
var categoryOf = (provider, model, agent, settings) => {
  if (isImageModel(model, settings))
    return "image";
  if (isEmbeddingModel(model))
    return "embedding";
  if (isUtilityModel(provider, model, settings))
    return "utility";
  if (agent === UNKNOWN_AGENT || agent.trim() === "")
    return "uncategorised";
  return settings.codingAgents.some((id) => same(id, agent)) ? "coding" : "agentic";
};
var isAbsolute2 = (path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
var cleanList = (value, label, options) => {
  if (!Array.isArray(value))
    return { ok: false, error: `${label} must be a list.` };
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string")
      return { ok: false, error: `${label} may only hold text.` };
    let item = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (item === "")
      continue;
    if (item.length > ITEM_MAX)
      return { ok: false, error: `${label}: "${item.slice(0, 40)}…" is longer than ${ITEM_MAX} characters.` };
    if (options.absolute) {
      if (!isAbsolute2(item))
        return { ok: false, error: `${label}: "${item}" is not an absolute path. Start it with / (or a drive letter).` };
      item = item.replace(/[\\/]+$/, "") || item;
    }
    if (options.lower)
      item = item.toLowerCase();
    const seen = out.some((existing) => options.absolute ? existing === item : same(existing, item));
    if (!seen)
      out.push(item);
  }
  if (out.length > LIST_MAX)
    return { ok: false, error: `${label} may hold at most ${LIST_MAX} entries.` };
  return { ok: true, list: out };
};
var FIELDS = [
  { key: "roots", label: "Workspace roots", absolute: true },
  { key: "localProviders", label: "Local provider ids", lower: true },
  { key: "utilityModels", label: "Utility models" },
  { key: "codingAgents", label: "Coding agents" },
  { key: "imagePatterns", label: "Image patterns" },
  { key: "collapsed", label: "Merged folders" }
];
var mergeSettings = (base, input, strict) => {
  const settings = { ...base };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return strict ? { ok: false, error: "The settings were not an object." } : { ok: true, settings };
  }
  const record = input;
  for (const field of FIELDS) {
    if (!(field.key in record))
      continue;
    const cleaned = cleanList(record[field.key], field.label, field);
    if (!cleaned.ok) {
      if (strict)
        return cleaned;
      continue;
    }
    settings[field.key] = cleaned.list;
  }
  return { ok: true, settings };
};
var resetRules = (current) => ({
  ...defaultSettings(),
  roots: [...current.roots],
  collapsed: [...current.collapsed]
});

// service/tools.ts
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var str = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
var SKILL_TOOL = "skill";
var SUBAGENT_TOOLS = new Set(["task", "subagent"]);
var MCP_NAME = /^mcp_([^_\s]+)_(.+)$/;
var classifyTool = (toolName, input) => {
  const own = (cls, name) => {
    const cleaned = name === null ? "" : cleanKey(name);
    return cleaned === "" ? { cls: "tool", name: cleanKey(toolName) || "unnamed" } : { cls, name: cleaned };
  };
  const fields = isObject(input) ? input : {};
  if (toolName === SKILL_TOOL)
    return own("skill", str(fields.name) ?? str(fields.id));
  if (SUBAGENT_TOOLS.has(toolName))
    return own("agent", str(fields.subagent_type) ?? str(fields.agent));
  const mcp = MCP_NAME.exec(toolName);
  if (mcp)
    return own("mcp", mcp[1] ?? null);
  return own("tool", toolName);
};
var resultChars = (state) => {
  if (state.status !== "completed")
    return 0;
  let total = 0;
  if (Array.isArray(state.content)) {
    for (const entry of state.content) {
      if (isObject(entry) && entry.type === "text" && typeof entry.text === "string")
        total += entry.text.length;
    }
  } else if (typeof state.output === "string") {
    total += state.output.length;
  }
  return total;
};
var toolCallsOf = (raw) => {
  if (!isObject(raw))
    return [];
  const info = isObject(raw.info) ? raw.info : raw;
  const lists = [raw.content, info.content, raw.parts].filter(Array.isArray);
  const calls = [];
  const seen = new Set;
  for (const list of lists) {
    for (const part of list) {
      if (!isObject(part) || part.type !== "tool")
        continue;
      const name = str(part.name) ?? str(part.tool);
      if (name === null)
        continue;
      const id = str(part.id) ?? str(part.callID);
      if (id !== null) {
        if (seen.has(id))
          continue;
        seen.add(id);
      }
      const state = isObject(part.state) ? part.state : {};
      calls.push({ ...classifyTool(name, state.input), contextChars: resultChars(state) });
    }
  }
  return calls;
};
var toolKey = (date, provider, model, cls, name) => `${date}|${provider}|${model}|${cls}|${name}`;
var CLASSES = new Set(["skill", "mcp", "agent", "tool"]);
var parseToolKey = (key) => {
  const first = key.indexOf("|");
  const second = first < 0 ? -1 : key.indexOf("|", first + 1);
  const last = key.lastIndexOf("|");
  const before = last < 0 ? -1 : key.lastIndexOf("|", last - 1);
  if (first < 0 || second < 0 || before <= second || last <= before)
    return null;
  const cls = key.slice(before + 1, last);
  const name = key.slice(last + 1);
  if (!CLASSES.has(cls) || name === "")
    return null;
  return { date: key.slice(0, first), provider: key.slice(first + 1, second), model: key.slice(second + 1, before), cls, name };
};

// service/ledger.ts
var RETENTION_DAYS = 3 * 366;
var MAX_STORE_BYTES = 16 * 1024 * 1024;
var MAX_SESSIONS_PER_RUN = 40;
var RECENT_TOOLS_DAYS = 30;
var SAMPLE_CAP = 300;
var DAY_MS = 86400000;
var isObject2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var num = (value) => {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return null;
};
var str2 = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
var toEpochMs = (value) => {
  const n = num(value);
  if (n !== null)
    return n < 100000000000 ? Math.round(n * 1000) : Math.round(n);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
var dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);
var emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
var totalTokens = (t) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
var percentile = (sortedAscending, p) => {
  const n = sortedAscending.length;
  if (n === 0)
    return null;
  if (n === 1)
    return sortedAscending[0] ?? null;
  const rank = p / 100 * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sortedAscending[lo] ?? 0;
  const b = sortedAscending[hi] ?? a;
  return a + (b - a) * (rank - lo);
};
var round = (value, places) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
var thin = (values, cap) => {
  if (values.length <= cap)
    return values;
  const out = [];
  for (let i = 0;i < cap; i += 1)
    out.push(values[Math.floor(i * values.length / cap)] ?? 0);
  return out;
};
var sortedCopy = (values) => Float64Array.from(values).sort();
var finishPercentiles = (bucket) => {
  const sorted = sortedCopy(bucket.samples);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  bucket.p50 = p50 === null ? null : round(p50, 2);
  bucket.p90 = p90 === null ? null : round(p90, 2);
};
var normalizeMessage = (raw) => {
  if (!isObject2(raw))
    return null;
  const info = isObject2(raw.info) ? raw.info : raw;
  const role = str2(info.role);
  if (role !== null && role !== "assistant")
    return null;
  const type = str2(info.type);
  if (type !== null && type !== "assistant")
    return null;
  const model = isObject2(info.model) ? info.model : null;
  const provider = str2(info.providerID) ?? (model ? str2(model.providerID) : null);
  const modelId = str2(info.modelID) ?? (model ? str2(model.modelID) ?? str2(model.id) : null);
  if (!provider || !modelId)
    return null;
  const tokensRaw = isObject2(info.tokens) ? info.tokens : null;
  if (role === null && tokensRaw === null)
    return null;
  const time = isObject2(info.time) ? info.time : {};
  const created = toEpochMs(time.created);
  const completed = toEpochMs(time.completed);
  const at = created ?? completed;
  if (at === null)
    return null;
  const cache = tokensRaw && isObject2(tokensRaw.cache) ? tokensRaw.cache : {};
  const tokens = {
    input: Math.max(0, num(tokensRaw?.input) ?? 0),
    output: Math.max(0, num(tokensRaw?.output) ?? 0),
    reasoning: Math.max(0, num(tokensRaw?.reasoning) ?? 0),
    cacheRead: Math.max(0, num(cache.read) ?? 0),
    cacheWrite: Math.max(0, num(cache.write) ?? 0)
  };
  let rate = null;
  if (created !== null && completed !== null) {
    const seconds = (completed - created) / 1000;
    const generated = tokens.output + tokens.reasoning;
    if (seconds >= 1 && generated > 0)
      rate = generated / seconds;
  }
  return {
    date: dateKey(at),
    provider,
    model: modelId,
    cost: Math.max(0, num(info.cost) ?? 0),
    tokens,
    rate,
    agent: ownAgentOf(info)
  };
};
var ownAgentOf = (info) => str2(info.agent) ?? str2(info.mode);
var agentId = (value) => typeof value === "string" ? str2(value) : isObject2(value) ? str2(value.id) ?? str2(value.name) : null;
var agentKey = (agent) => {
  const cleaned = cleanKey(agent ?? "");
  return cleaned === "" ? UNKNOWN_AGENT : cleaned;
};
var bucketKey = (date, provider, model, project, agent = null) => `${date}|${provider}|${model}|${project}|${agentKey(agent)}`;
var parseBucketKey = (key) => {
  const first = key.indexOf("|");
  const second = first < 0 ? -1 : key.indexOf("|", first + 1);
  const last = key.lastIndexOf("|");
  const before = last < 0 ? -1 : key.lastIndexOf("|", last - 1);
  if (first < 0 || second < 0 || before <= second || last <= before)
    return null;
  return {
    date: key.slice(0, first),
    provider: key.slice(first + 1, second),
    model: key.slice(second + 1, before),
    project: key.slice(before + 1, last) || UNATTRIBUTED,
    agent: key.slice(last + 1) || UNKNOWN_AGENT
  };
};
var rekeyBuckets = (buckets, project) => {
  const out = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    const parsed = parseBucketKey(key);
    if (parsed)
      out[bucketKey(parsed.date, parsed.provider, parsed.model, project, parsed.agent)] = bucket;
  }
  return out;
};
var newBucket = () => ({ messages: 0, tokens: emptyTokens(), cost: 0, samples: [], p50: null, p90: null });
var switchOf = (raw) => {
  if (!isObject2(raw))
    return null;
  const info = isObject2(raw.info) ? raw.info : raw;
  const type = str2(info.type)?.toLowerCase().replace(/_/g, "-");
  return type === "agent-switched" ? { agent: agentId(info.agent) } : null;
};
var timeOf = (raw) => {
  if (!isObject2(raw))
    return null;
  const info = isObject2(raw.info) ? raw.info : raw;
  const time = isObject2(info.time) ? info.time.created ?? info.time.completed : info.time;
  return toEpochMs(time ?? info.created ?? info.timestamp);
};
var inOrder = (messages) => {
  const items = [];
  messages.forEach((raw, index) => {
    const switched = switchOf(raw);
    if (switched || normalizeMessage(raw))
      items.push({ raw, index, at: timeOf(raw), switched });
  });
  if (items.length > 1 && items.every((item) => item.at !== null)) {
    items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.index - b.index);
  }
  return items;
};
var aggregateMessages = (messages, project = UNATTRIBUTED, sessionAgent = null) => {
  const buckets = {};
  const ordered = inOrder(messages);
  const hasSwitch = ordered.some((item) => item.switched !== null);
  let skipped = messages.length - ordered.length;
  let current = null;
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
    const bucket = buckets[key] ??= newBucket();
    bucket.messages += 1;
    bucket.cost += m.cost;
    bucket.tokens.input += m.tokens.input;
    bucket.tokens.output += m.tokens.output;
    bucket.tokens.reasoning += m.tokens.reasoning;
    bucket.tokens.cacheRead += m.tokens.cacheRead;
    bucket.tokens.cacheWrite += m.tokens.cacheWrite;
    if (m.rate !== null)
      bucket.samples.push(round(m.rate, 2));
  }
  for (const bucket of Object.values(buckets)) {
    bucket.samples = thin(bucket.samples, SAMPLE_CAP);
    finishPercentiles(bucket);
  }
  return { buckets, skipped };
};
var newToolRow = () => ({ calls: 0, generated: 0, contextChars: 0 });
var aggregateTools = (messages) => {
  const rows = {};
  for (const raw of messages) {
    const calls = toolCallsOf(raw);
    if (calls.length === 0)
      continue;
    const m = normalizeMessage(raw);
    if (!m)
      continue;
    const generated = m.tokens.output + m.tokens.reasoning;
    const counted = new Set;
    for (const call of calls) {
      const key = toolKey(m.date, m.provider, m.model, call.cls, call.name);
      const row = rows[key] ??= newToolRow();
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
var selectSessions = (refs, known, options) => {
  const due = refs.filter((ref) => {
    const seen = known[ref.id];
    return seen === undefined || seen.updated < ref.updated;
  }).sort((a, b) => a.updated - b.updated || (a.id < b.id ? -1 : 1));
  const max = options.max ?? MAX_SESSIONS_PER_RUN;
  return { selected: due.slice(0, max), pending: Math.max(0, due.length - max) };
};
var mainDue = (store, ref) => {
  const seen = store.sessions[ref.id];
  return seen === undefined || seen.updated < ref.updated;
};
var toolsDue = (store, ref) => {
  const seen = store.tools[ref.id];
  return seen === undefined || seen.toolsSynced < ref.updated;
};
var byNewest = (a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1);
var selectRecentSessions = (refs, store, options) => {
  const since = options.now - RECENT_TOOLS_DAYS * DAY_MS;
  return refs.filter((ref) => ref.updated >= since && (mainDue(store, ref) || toolsDue(store, ref))).sort(byNewest).slice(0, Math.max(0, options.max));
};
var selectToolSessions = (refs, store, options) => refs.filter((ref) => toolsDue(store, ref)).sort(byNewest).slice(0, Math.max(0, options.max));
var countToolsPending = (refs, store) => refs.filter((ref) => toolsDue(store, ref)).length;
var emptyStore = () => ({
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
  settings: defaultSettings()
});
var pruneStore = (store, now) => {
  const cutoffDate = dateKey(now - RETENTION_DAYS * DAY_MS);
  for (const entry of Object.values(store.sessions)) {
    for (const key of Object.keys(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (!parsed || parsed.date < cutoffDate)
        delete entry.buckets[key];
    }
  }
  for (const entry of Object.values(store.tools)) {
    for (const key of Object.keys(entry.rows)) {
      const parsed = parseToolKey(key);
      if (!parsed || parsed.date < cutoffDate)
        delete entry.rows[key];
    }
  }
};
var capStoreSize = (store, maxBytes = MAX_STORE_BYTES) => {
  let size = JSON.stringify(store).length;
  if (size <= maxBytes)
    return 0;
  const dates = new Set;
  for (const entry of Object.values(store.sessions)) {
    for (const key of Object.keys(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (parsed)
        dates.add(parsed.date);
    }
  }
  for (const entry of Object.values(store.tools)) {
    for (const key of Object.keys(entry.rows)) {
      const parsed = parseToolKey(key);
      if (parsed)
        dates.add(parsed.date);
    }
  }
  const ordered = [...dates].sort();
  let dropped = 0;
  while (size > maxBytes && dropped < ordered.length) {
    const share = Math.ceil((size - maxBytes) / size * ordered.length);
    const upTo = Math.min(ordered.length, dropped + Math.max(1, share));
    const cut = new Set(ordered.slice(dropped, upTo));
    for (const entry of Object.values(store.sessions)) {
      for (const key of Object.keys(entry.buckets)) {
        const parsed = parseBucketKey(key);
        if (parsed && cut.has(parsed.date))
          delete entry.buckets[key];
      }
    }
    for (const entry of Object.values(store.tools)) {
      for (const key of Object.keys(entry.rows)) {
        const parsed = parseToolKey(key);
        if (parsed && cut.has(parsed.date))
          delete entry.rows[key];
      }
    }
    dropped = upTo;
    size = JSON.stringify(store).length;
  }
  return dropped;
};
var applySession = (store, ref, messages) => {
  const project = projectKeyOf(ref.directory, store.settings.roots);
  const { buckets } = aggregateMessages(messages, project, ref.agent ?? null);
  store.sessions[ref.id] = { updated: ref.updated, project, ...directoryField(ref.directory), ...parentField(ref.parent), buckets };
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: aggregateTools(messages) };
  if (ref.updated > store.watermark)
    store.watermark = ref.updated;
};
var applyToolsOnly = (store, ref, messages) => {
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: aggregateTools(messages) };
};
var applySkippedTools = (store, ref) => {
  store.tools[ref.id] = { toolsSynced: ref.updated, rows: {} };
};
var parentField = (parent) => typeof parent === "string" && parent.trim() !== "" ? { parent: parent.trim().slice(0, 200) } : {};
var markParents = (store, refs) => {
  let marked = 0;
  for (const ref of refs) {
    const entry = store.sessions[ref.id];
    const parent = parentField(ref.parent).parent;
    if (!entry || parent === undefined || entry.parent === parent)
      continue;
    entry.parent = parent;
    marked += 1;
  }
  return marked;
};
var directoryField = (directory) => typeof directory === "string" && directory.trim() !== "" ? { directory: directory.trim().slice(0, 500) } : {};
var applySkippedSession = (store, ref, reason) => {
  store.sessions[ref.id] = {
    updated: ref.updated,
    project: projectKeyOf(ref.directory, store.settings.roots),
    ...directoryField(ref.directory),
    ...parentField(ref.parent),
    buckets: {},
    skipped: reason
  };
  applySkippedTools(store, ref);
  if (ref.updated > store.watermark)
    store.watermark = ref.updated;
};
var reattributeSessions = (store, refs) => {
  let moved = 0;
  for (const ref of refs) {
    const entry = store.sessions[ref.id];
    if (!entry || typeof ref.directory !== "string" || ref.directory.trim() === "")
      continue;
    const project = projectKeyOf(ref.directory, store.settings.roots);
    if ((entry.project ?? UNATTRIBUTED) === project) {
      if (entry.directory === undefined)
        entry.directory = directoryField(ref.directory).directory;
      continue;
    }
    entry.buckets = rekeyBuckets(entry.buckets, project);
    entry.project = project;
    entry.directory = directoryField(ref.directory).directory;
    moved += 1;
  }
  return moved;
};
var rekeySessions = (store) => {
  let moved = 0;
  for (const entry of Object.values(store.sessions)) {
    if (entry.directory === undefined)
      continue;
    const project = projectKeyOf(entry.directory, store.settings.roots);
    if ((entry.project ?? UNATTRIBUTED) === project)
      continue;
    entry.buckets = rekeyBuckets(entry.buckets, project);
    entry.project = project;
    moved += 1;
  }
  return moved;
};
var mergeSessions = (store) => {
  const merged = new Map;
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
  for (const bucket of merged.values())
    finishPercentiles(bucket);
  return merged;
};
var newAcc = () => ({ cost: 0, tokens: 0, messages: 0, samples: [] });
var addTotals = (acc, bucket) => {
  acc.cost += bucket.cost;
  acc.tokens += totalTokens(bucket.tokens);
  acc.messages += bucket.messages;
};
var addTo = (acc, bucket) => {
  addTotals(acc, bucket);
  acc.samples.push(...bucket.samples);
};
var sortedPercentiles = (samples) => {
  const sorted = sortedCopy(samples);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  return { p50: p50 === null ? null : round(p50, 1), p90: p90 === null ? null : round(p90, 1) };
};
var pad2 = (n) => String(n).padStart(2, "0");
var ymd = (year, month0, day) => dateKey(Date.UTC(year, month0, day));
var parseDate = (date) => Date.parse(`${date}T00:00:00Z`);
var addDays = (date, days) => dateKey(parseDate(date) + days * DAY_MS);
var monthOf = (date) => date.slice(0, 7);
var addMonths = (month, delta) => {
  const year = Number(month.slice(0, 4));
  const m0 = Number(month.slice(5, 7)) - 1 + delta;
  return `${year + Math.floor(m0 / 12)}-${pad2((m0 % 12 + 12) % 12 + 1)}`;
};
var periodRange = (id, today, firstDate) => {
  const year = Number(today.slice(0, 4));
  const month0 = Number(today.slice(5, 7)) - 1;
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "d7":
      return { from: addDays(today, -6), to: today };
    case "d30":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: ymd(year, month0, 1), to: today };
    case "lastMonth":
      return { from: ymd(year, month0 - 1, 1), to: ymd(year, month0, 0) };
    case "all":
      return { from: firstDate ?? today, to: today };
  }
};
var daysBetween = (from, to) => Math.round((parseDate(to) - parseDate(from)) / DAY_MS) + 1;
var planWindowsOf = (snapshot) => snapshot !== null && snapshot.ok && Object.entries(snapshot.windows).some(([name, w]) => w.usedPercent !== null && !name.startsWith("credits_balance"));
var hasPlanWindows = (snapshot) => snapshot !== null && (planWindowsOf(snapshot) || snapshot.hadPlan === true);
var PROJECTS_SHOWN = 30;
var OTHERS = "Others";
var rankProjects = (accs, totalCost, tree = {}) => {
  const share = (cost) => totalCost > 0 ? cost / totalCost * 100 : null;
  const row = (project, acc) => ({
    project,
    cost: acc.cost,
    tokens: acc.tokens,
    messages: acc.messages,
    share: share(acc.cost),
    parent: tree.parents?.get(project) ?? null,
    merged: tree.merged?.get(project) ?? 0
  });
  const ranked = [...accs.entries()].map(([project, acc]) => row(project, acc)).sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.project < b.project ? -1 : 1));
  const unattributed = ranked.find((p) => p.project === UNATTRIBUTED) ?? { project: UNATTRIBUTED, cost: 0, tokens: 0, messages: 0, share: share(0), parent: null, merged: 0 };
  if (ranked.length <= PROJECTS_SHOWN)
    return { projects: ranked, unattributed };
  const head = ranked.slice(0, PROJECTS_SHOWN - 1);
  const tail = ranked.slice(PROJECTS_SHOWN - 1);
  const unattributedInTail = tail.find((p) => p.project === UNATTRIBUTED);
  if (unattributedInTail)
    head.push(unattributedInTail);
  const rest = tail.filter((p) => p.project !== UNATTRIBUTED);
  if (rest.length > 0) {
    const sum = rest.reduce((a, p) => ({ cost: a.cost + p.cost, tokens: a.tokens + p.tokens, messages: a.messages + p.messages }), { cost: 0, tokens: 0, messages: 0 });
    head.push({ project: `${OTHERS} (${rest.length})`, ...sum, share: share(sum.cost), parent: null, merged: 0 });
  }
  return { projects: head, unattributed };
};
var parentMap = (store) => {
  const counts = new Map;
  for (const entry of Object.values(store.sessions)) {
    if (entry.directory === undefined)
      continue;
    const { project, parent } = placementOf(entry.directory, store.settings.roots);
    if (parent === null || project === UNATTRIBUTED)
      continue;
    const by = counts.get(project) ?? new Map;
    counts.set(project, by);
    by.set(parent, (by.get(parent) ?? 0) + 1);
  }
  const out = new Map;
  for (const [project, by] of counts) {
    const total = [...by.values()].reduce((a, c) => a + c, 0);
    const best = [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (best && best[1] * 2 > total)
      out.set(project, best[0]);
  }
  return out;
};
var resolveProject = (project, collapsed, parents) => {
  let at = project;
  const seen = new Set;
  while (collapsed.has(at) && !seen.has(at)) {
    seen.add(at);
    const up = parents.get(at);
    if (!up)
      break;
    at = up;
  }
  return at;
};
var newTypeTotals = () => ({ cost: 0, tokens: 0, messages: 0 });
var addType = (t, bucket) => {
  t.cost += bucket.cost;
  t.tokens += totalTokens(bucket.tokens);
  t.messages += bucket.messages;
};
var buildTypes = (entries, totalCost, totalMessages) => {
  const byCategory = new Map;
  const cloud = newTypeTotals();
  const local = { tokens: 0, messages: 0 };
  for (const { provider, category, scope, bucket } of entries) {
    const slot = byCategory.get(category) ?? { totals: newTypeTotals(), providers: new Map };
    byCategory.set(category, slot);
    addType(slot.totals, bucket);
    const key = `${provider}|${scope}`;
    const row = slot.providers.get(key) ?? { ...newTypeTotals(), provider, scope };
    slot.providers.set(key, row);
    addType(row, bucket);
    if (scope === "cloud")
      addType(cloud, bucket);
    else {
      local.tokens += totalTokens(bucket.tokens);
      local.messages += bucket.messages;
    }
  }
  const categories = SPEND_CATEGORIES.flatMap((category) => {
    const slot = byCategory.get(category);
    if (!slot || slot.totals.messages === 0)
      return [];
    const providers = [...slot.providers.values()].map((r) => ({ ...r, name: providerName(r.provider) })).sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.scope < b.scope ? -1 : 1));
    return [{
      category,
      ...slot.totals,
      share: totalCost > 0 ? slot.totals.cost / totalCost * 100 : null,
      replyShare: totalMessages > 0 ? slot.totals.messages / totalMessages * 100 : null,
      providers
    }];
  }).sort((a, b) => b.cost - a.cost || b.messages - a.messages || SPEND_CATEGORIES.indexOf(a.category) - SPEND_CATEGORIES.indexOf(b.category));
  const un = byCategory.get("uncategorised");
  return {
    categories,
    cloud,
    local,
    uncategorised: {
      messages: un?.totals.messages ?? 0,
      cost: un?.totals.cost ?? 0,
      replyShare: totalMessages > 0 ? (un?.totals.messages ?? 0) / totalMessages * 100 : null
    }
  };
};
var collapsedProjects = (store) => {
  const parents = parentMap(store);
  const replies = new Map;
  for (const entry of Object.values(store.sessions)) {
    for (const bucket of Object.values(entry.buckets))
      replies.set(entry.project ?? UNATTRIBUTED, (replies.get(entry.project ?? UNATTRIBUTED) ?? 0) + bucket.messages);
  }
  return store.settings.collapsed.map((project) => ({ project, parent: parents.get(project) ?? null, messages: replies.get(project) ?? 0 }));
};
var SURFACE_TOP = 10;
var SUBAGENT_TYPES_TOP = 5;
var toolEntries = (store, today) => {
  const out = [];
  for (const entry of Object.values(store.tools)) {
    for (const [key, row] of Object.entries(entry.rows)) {
      const parsed = parseToolKey(key);
      if (parsed && parsed.date <= today)
        out.push({ ...parsed, row });
    }
  }
  return out;
};
var bySurface = (a, b) => b.contextChars - a.contextChars || b.generated - a.generated || b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
var subagentTotals = (store, from, to) => {
  const out = { cost: 0, tokens: 0, messages: 0, sessions: 0 };
  for (const entry of Object.values(store.sessions)) {
    if (entry.parent === undefined)
      continue;
    let touched = false;
    for (const [key, bucket] of Object.entries(entry.buckets)) {
      const parsed = parseBucketKey(key);
      if (!parsed || parsed.date < from || parsed.date > to)
        continue;
      out.cost += bucket.cost;
      out.tokens += totalTokens(bucket.tokens);
      out.messages += bucket.messages;
      touched = true;
    }
    if (touched)
      out.sessions += 1;
  }
  return out;
};
var buildSurfaces = (entries, subagent, range, totals) => {
  const groups = { skill: new Map, mcp: new Map, agent: new Map, tool: new Map };
  let calls = 0;
  let contextChars = 0;
  for (const { date, cls, name, row } of entries) {
    if (date < range.from || date > range.to)
      continue;
    calls += row.calls;
    contextChars += row.contextChars;
    const map = groups[cls];
    const into = map.get(name) ?? { name, calls: 0, generated: 0, contextChars: 0 };
    map.set(name, into);
    into.calls += row.calls;
    into.generated += row.generated;
    into.contextChars += row.contextChars;
  }
  const ranked = (map, top) => [...map.values()].sort(bySurface).slice(0, top);
  const dispatches = [...groups.agent.values()].reduce((sum, r) => sum + r.calls, 0);
  return {
    calls,
    contextChars,
    skills: ranked(groups.skill, SURFACE_TOP),
    mcp: ranked(groups.mcp, SURFACE_TOP),
    other: ranked(groups.tool, SURFACE_TOP),
    mcpViaCodeMode: groups.mcp.size === 0 && (groups.tool.get("execute")?.calls ?? 0) > 0,
    subagents: {
      dispatches,
      types: [...groups.agent.values()].sort((a, b) => b.calls - a.calls || bySurface(a, b)).slice(0, SUBAGENT_TYPES_TOP),
      ...subagent,
      share: totals.cost > 0 ? subagent.cost / totals.cost * 100 : null,
      replyShare: totals.messages > 0 ? subagent.messages / totals.messages * 100 : null
    }
  };
};
var toTotals = (acc) => ({ cost: acc.cost, tokens: acc.tokens, messages: acc.messages });
var deriveLedger = (store, now) => {
  const merged = mergeSessions(store);
  const today = dateKey(now);
  const tools = toolEntries(store, today);
  const settings = store.settings;
  const parents = parentMap(store);
  const collapsed = new Set(settings.collapsed);
  const entries = [];
  const classes = new Map;
  const classify = (provider, model, agent) => {
    const key = `${provider}|${model}|${agent}`;
    let found = classes.get(key);
    if (!found) {
      found = { category: categoryOf(provider, model, agent, settings), scope: scopeOf(provider, model, settings) };
      classes.set(key, found);
    }
    return found;
  };
  const allTime = new Map;
  let firstDate = null;
  for (const [key, bucket] of merged) {
    const parsed = parseBucketKey(key);
    if (!parsed || parsed.date > today)
      continue;
    entries.push({ date: parsed.date, provider: parsed.provider, model: parsed.model, project: parsed.project, ...classify(parsed.provider, parsed.model, parsed.agent), bucket });
    if (firstDate === null || parsed.date < firstDate)
      firstDate = parsed.date;
    const t = allTime.get(parsed.provider) ?? { cost: 0, messages: 0 };
    t.cost += bucket.cost;
    t.messages += bucket.messages;
    allTime.set(parsed.provider, t);
  }
  const subscription = (provider) => {
    const t = allTime.get(provider);
    return t !== undefined && t.messages > 0 && t.cost === 0 && hasPlanWindows(balanceFor(store.balances, provider));
  };
  const periods = {};
  for (const id of PERIOD_IDS) {
    const { from, to } = periodRange(id, today, firstDate);
    const days = daysBetween(from, to);
    const granularity = id === "all" || days > 31 ? "month" : "day";
    const total = newAcc();
    const providers = new Map;
    const models = new Map;
    const projects = new Map;
    const mergedInto = new Map;
    const inPeriod = [];
    const series = new Map;
    if (granularity === "day") {
      for (let i = 0;i < days; i += 1) {
        const key = addDays(from, i);
        series.set(key, { key, cost: 0, tokens: 0, messages: 0, byProvider: {} });
      }
    } else if (firstDate !== null || id !== "all") {
      const last = monthOf(to);
      for (let m = monthOf(from);m <= last; m = addMonths(m, 1)) {
        series.set(m, { key: m, cost: 0, tokens: 0, messages: 0, byProvider: {} });
      }
    }
    for (const entry of entries) {
      const { date, provider, model, project, bucket } = entry;
      if (date < from || date > to)
        continue;
      inPeriod.push(entry);
      addTotals(total, bucket);
      const shown = resolveProject(project, collapsed, parents);
      if (shown !== project) {
        const set = mergedInto.get(shown) ?? new Set;
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
      const point = series.get(granularity === "day" ? date : monthOf(date));
      if (point) {
        point.cost += bucket.cost;
        point.tokens += totalTokens(bucket.tokens);
        point.messages += bucket.messages;
        point.byProvider[provider] = (point.byProvider[provider] ?? 0) + bucket.cost;
      }
    }
    const providerRows = [...providers.entries()].map(([provider, acc]) => {
      const sub = subscription(provider);
      const { p50, p90 } = sortedPercentiles(acc.samples);
      return {
        provider,
        name: providerName(provider),
        cost: acc.cost,
        tokens: acc.tokens,
        messages: acc.messages,
        perMillion: sub || acc.tokens <= 0 ? null : acc.cost / acc.tokens * 1e6,
        p50,
        p90,
        samples: acc.samples.length,
        subscription: sub
      };
    });
    providerRows.sort((a, b) => b.cost - a.cost || b.messages - a.messages || (a.provider < b.provider ? -1 : 1));
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
          perMillion: sub || acc.tokens <= 0 ? null : acc.cost / acc.tokens * 1e6,
          p50: null,
          subscription: sub
        }
      };
    });
    modelRows.sort((a, b) => b.row.cost - a.row.cost || b.row.tokens - a.row.tokens || (a.row.model < b.row.model ? -1 : 1));
    const topModels = modelRows.slice(0, 10).map(({ acc, row }) => ({ ...row, p50: sortedPercentiles(acc.samples).p50 }));
    const mergedCounts = new Map([...mergedInto].map(([target, sources]) => [target, sources.size]));
    const ranked = rankProjects(projects, total.cost, { parents, merged: mergedCounts });
    periods[id] = {
      id,
      label: PERIOD_LABELS[id],
      from: id === "all" && firstDate === null ? null : from,
      to,
      totals: toTotals(total),
      providers: providerRows,
      models: topModels,
      projects: ranked.projects,
      unattributed: ranked.unattributed,
      types: buildTypes(inPeriod, total.cost, total.messages),
      surfaces: buildSurfaces(tools, subagentTotals(store, from, to), { from, to }, total),
      granularity,
      series: [...series.values()]
    };
  }
  const thisMonth = monthOf(today);
  const months = [];
  for (let i = 0;i < 6; i += 1) {
    const month = addMonths(thisMonth, -i);
    const acc = newAcc();
    const byProvider = new Map;
    for (const { date, provider, bucket } of entries) {
      if (monthOf(date) !== month)
        continue;
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
      top: top ? { provider: top[0], name: providerName(top[0]), cost: top[1].cost, messages: top[1].messages, by: top[1].cost > 0 ? "spend" : "replies" } : null
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
    daily7: d7.series
  };
};
var snapshotRank = (s) => s.ok ? Object.keys(s.windows).length > 0 ? 3 : 2 : 1;
var bestSnapshot = (balances, account) => {
  let best = null;
  for (const s of Object.values(balances)) {
    if (canonicalProvider(s.provider) !== account)
      continue;
    if (!best || snapshotRank(s) > snapshotRank(best) || snapshotRank(s) === snapshotRank(best) && s.fetchedAt > best.fetchedAt)
      best = s;
  }
  return best;
};
var balanceFor = (balances, provider) => {
  const direct = balances[provider];
  if (direct && direct.ok)
    return direct;
  return bestSnapshot(balances, canonicalProvider(provider)) ?? direct ?? null;
};
var WINDOW_NAMES = { "5h": "5h", weekly: "Weekly", monthly: "Monthly" };
var WINDOW_ORDER = ["5h", "weekly", "monthly"];
var windowTitle = (name) => {
  const known = WINDOW_NAMES[name];
  if (known)
    return known;
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
var pct = (value) => `${Math.round(value)}% used`;
var buildBalanceCards = (balances, ledgerProviders) => {
  const ledgerAccounts = new Set(ledgerProviders.map(canonicalProvider));
  const accounts = new Set(ledgerAccounts);
  for (const s of Object.values(balances))
    if (s.ok)
      accounts.add(canonicalProvider(s.provider));
  const cards = [];
  for (const account of accounts) {
    const snapshot = bestSnapshot(balances, account);
    const base = { account, name: providerName(account), planLabel: null, headline: null, headlineNote: null, windows: [], note: null, fetchedAt: snapshot?.fetchedAt ?? null };
    if (!snapshot) {
      cards.push({ ...base, windows: [], state: "unread", note: "Not read yet" });
      continue;
    }
    if (!snapshot.ok) {
      if (snapshot.needsSignIn)
        cards.push({ ...base, windows: [], state: "signin", note: "Sign in again", headlineNote: snapshot.error ?? null });
      else
        cards.push({ ...base, windows: [], state: "failed", note: snapshot.error ?? "Balance could not be read" });
      continue;
    }
    const entries = Object.entries(snapshot.windows);
    const credits = snapshot.windows.credits_balance ?? entries.find(([n]) => n.startsWith("credits_balance"))?.[1];
    const spendWindow = entries.find(([, w]) => w.usedPercent !== null && w.value?.kind === "spend" && w.valueLabel);
    let headline = null;
    let headlineNote = null;
    let headlineWindow = null;
    if (credits?.valueLabel) {
      headline = credits.valueLabel;
      headlineNote = "credits";
    } else if (spendWindow && spendWindow[1].valueLabel) {
      headline = spendWindow[1].valueLabel;
      headlineNote = windowTitle(spendWindow[0]).toLowerCase();
      headlineWindow = spendWindow[0];
    }
    const bars = entries.filter(([name, w]) => w.usedPercent !== null && !name.startsWith("credits_balance")).sort((a, b) => {
      const ia = WINDOW_ORDER.indexOf(a[0]);
      const ib = WINDOW_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a[0] < b[0] ? -1 : 1);
    }).map(([name, window2]) => {
      const used = window2.usedPercent ?? 0;
      const extra = window2.valueLabel && name !== headlineWindow ? ` · ${window2.valueLabel}` : "";
      return { name, title: windowTitle(name), used: Math.min(100, Math.max(0, used)), detail: `${pct(used)}${extra}`, resetAt: window2.resetAt ?? null };
    });
    const state = headline !== null ? "money" : bars.length > 0 ? "windows" : "none";
    cards.push({
      ...base,
      state,
      planLabel: snapshot.planLabel ?? null,
      headline,
      headlineNote,
      windows: bars,
      note: state === "none" ? "No balance API — spend is in the ledger" : null
    });
  }
  const rank = (c) => c.state === "money" ? 0 : c.state === "windows" ? 1 : 2;
  const repeatsCredits = (c) => !ledgerAccounts.has(c.account) && c.state === "money" && c.headlineNote === "credits" && cards.some((o) => o !== c && ledgerAccounts.has(o.account) && o.headline === c.headline && o.headlineNote === "credits");
  return cards.filter((c) => !repeatsCredits(c)).filter((c) => ledgerAccounts.has(c.account) || c.state === "money" || c.state === "windows").sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

// service/budgets.ts
var WARN_PERCENT = 80;
var OVER_PERCENT = 100;
var CAP_MAX_USD = 1e6;
var PROVIDER_ID_MAX = 100;
var toCents = (usd) => Math.round(usd * 100);
var budgetState = (spentUsd, capUsd) => {
  if (capUsd === null || capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0)
    return "none";
  const spent = toCents(Math.max(0, spentUsd)) * 100;
  const cap = toCents(capUsd);
  if (spent >= cap * OVER_PERCENT)
    return "error";
  if (spent >= cap * WARN_PERCENT)
    return "warning";
  return "ok";
};
var budgetShare = (spentUsd, capUsd) => capUsd === null || capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0 ? null : Math.max(0, spentUsd) / capUsd * 100;
var buildBudgetRows = (view, caps, balances = []) => {
  const monthSpend = new Map(view.periods.month.providers.map((p) => [p.provider, p.cost]));
  const included = new Set(view.periods.all.providers.filter((p) => p.subscription).map((p) => p.provider));
  const ids = new Set(Object.keys(caps));
  for (const id of view.providerIds)
    if (!included.has(id))
      ids.add(id);
  const balanceOf = (provider) => {
    const card = balances.find((c) => c.account === canonicalProvider(provider));
    if (!card)
      return null;
    if (card.state === "money")
      return card.headline;
    const busiest = card.state === "windows" ? [...card.windows].sort((x, y) => y.used - x.used)[0] : undefined;
    return busiest ? `${Math.round(busiest.used)}% ${busiest.title.toLowerCase()}` : null;
  };
  const rows = [...ids].map((provider) => {
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
      balance: balanceOf(provider)
    };
  });
  return rows.sort((a, b) => Number(b.capUsd !== null) - Number(a.capUsd !== null) || (b.share ?? 0) - (a.share ?? 0) || b.spentUsd - a.spentUsd || (a.provider < b.provider ? -1 : 1));
};
var badgeCount = (rows) => {
  const n = rows.filter((r) => r.state === "error").length;
  return n > 0 ? n : null;
};
var setBudget = (store, provider, capUsd) => {
  if (typeof provider !== "string" || provider.trim() === "" || provider.length > PROVIDER_ID_MAX || provider.includes("|")) {
    return { ok: false, error: "Name the provider the cap is for." };
  }
  const id = provider.trim();
  if (capUsd === null) {
    delete store.budgets[id];
    return { ok: true, capUsd: null };
  }
  if (typeof capUsd !== "number" || !Number.isFinite(capUsd)) {
    return { ok: false, error: "A cap is a number of dollars, such as 25 or 12.50." };
  }
  if (capUsd <= 0)
    return { ok: false, error: "A cap must be more than $0. Clear the field to remove the cap." };
  const rounded = toCents(capUsd) / 100;
  if (rounded <= 0)
    return { ok: false, error: "A cap must be at least $0.01." };
  if (rounded > CAP_MAX_USD)
    return { ok: false, error: `A cap above $${CAP_MAX_USD.toLocaleString("en-US")} looks like a typo.` };
  store.budgets[id] = rounded;
  return { ok: true, capUsd: rounded };
};

// service/export.ts
import { constants } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var CSV_HEADER = "date,provider,model,project,category,scope,replies,tokens_input,tokens_output,tokens_reasoning,cache_read,cache_write,usd";
var field = (value) => {
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
var usd = (cost) => {
  const rounded = Math.round(cost * 1e6) / 1e6;
  return rounded.toFixed(6).replace(/\.?0+$/, "") || "0";
};
var buildCsv = (store) => {
  const byRow = new Map;
  for (const [key, bucket] of mergeSessions(store)) {
    const parsed = parseBucketKey(key);
    if (!parsed)
      continue;
    const category = categoryOf(parsed.provider, parsed.model, parsed.agent, store.settings);
    const scope = scopeOf(parsed.provider, parsed.model, store.settings);
    const id = JSON.stringify([parsed.date, parsed.provider, parsed.model, parsed.project, category, scope]);
    const row = byRow.get(id) ?? { date: parsed.date, provider: parsed.provider, model: parsed.model, project: parsed.project, category, scope, replies: 0, input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0 };
    byRow.set(id, row);
    row.replies += bucket.messages;
    row.input += bucket.tokens.input;
    row.output += bucket.tokens.output;
    row.reasoning += bucket.tokens.reasoning;
    row.read += bucket.tokens.cacheRead;
    row.write += bucket.tokens.cacheWrite;
    row.cost += bucket.cost;
  }
  const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const rows = [...byRow.values()].sort((a, b) => order(a.date, b.date) || order(a.provider, b.provider) || order(a.model, b.model) || order(a.project, b.project) || order(a.category, b.category) || order(a.scope, b.scope));
  const lines = rows.map((r) => [
    field(r.date),
    field(r.provider),
    field(r.model),
    field(r.project),
    field(r.category),
    field(r.scope),
    String(r.replies),
    String(r.input),
    String(r.output),
    String(r.reasoning),
    String(r.read),
    String(r.write),
    usd(r.cost)
  ].join(","));
  return { csv: `${[CSV_HEADER, ...lines].join(`
`)}
`, rows: rows.length };
};
var isDirectory = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};
var exportCsv = async (store, now, home = homedir()) => {
  const downloads = join(home, "Downloads");
  const fellBack = !await isDirectory(downloads);
  const dir = fellBack ? home : downloads;
  const path = join(dir, `provider-ledger-${dateKey(now)}.csv`);
  const { csv, rows } = buildCsv(store);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, csv, { mode: 384, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC });
    await chmod(tmp, 384);
    await rename(tmp, path);
    return { ok: true, path, rows, fellBack };
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {
      return;
    });
    const reason = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: `Could not write ${path}: ${reason}`.slice(0, 400) };
  }
};

// service/opencode.ts
class UpstreamError extends Error {
  status;
  transient;
  constructor(message, status, transient) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}
var REQUEST_TIMEOUT_MS = 20000;
var MAX_PAGES = 400;
var isObject3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var cursorOf = (raw) => {
  if (typeof raw === "string" && raw !== "")
    return raw;
  if (isObject3(raw) && typeof raw.next === "string" && raw.next !== "")
    return raw.next;
  return null;
};
var unwrapList = (body) => {
  if (Array.isArray(body))
    return { items: body, cursor: null };
  if (!isObject3(body))
    return { items: [], cursor: null };
  const key = ["items", "data", "sessions", "messages", "results"].find((k) => Array.isArray(body[k]));
  const items = key ? body[key] : [];
  return { items, cursor: cursorOf(body.cursor) ?? cursorOf(body.nextCursor) ?? cursorOf(body.next) };
};
var directoryOf = (raw) => {
  const direct = typeof raw.directory === "string" && raw.directory.trim() !== "" ? raw.directory : null;
  if (direct)
    return direct;
  const location = isObject3(raw.location) ? raw.location : null;
  return location && typeof location.directory === "string" && location.directory.trim() !== "" ? location.directory : null;
};
var agentOf = (raw) => {
  const value = raw.agent;
  if (typeof value === "string" && value.trim() !== "")
    return value.trim();
  if (isObject3(value)) {
    const id = typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : "";
    return id.trim() !== "" ? id.trim() : null;
  }
  return null;
};
var parentOf = (raw) => {
  for (const key of ["parentID", "parentId", "parent_id"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim() !== "")
      return value.trim();
  }
  const parent = raw.parent;
  if (typeof parent === "string" && parent.trim() !== "")
    return parent.trim();
  if (isObject3(parent) && typeof parent.id === "string" && parent.id.trim() !== "")
    return parent.id.trim();
  return null;
};
var sessionRefOf = (raw) => {
  if (!isObject3(raw))
    return null;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
  if (!id)
    return null;
  const time = isObject3(raw.time) ? raw.time : {};
  const updated = toEpochMs(time.updated ?? raw.updatedAt ?? raw.updated ?? time.created ?? raw.createdAt);
  if (updated === null)
    return null;
  return { id, updated, directory: directoryOf(raw), agent: agentOf(raw), parent: parentOf(raw) };
};
var createOpenCodeReader = (baseUrl, token, fetchFn = fetch) => {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async (path, cursor) => {
    const url = cursor ? `${base}${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : `${base}${path}`;
    let response;
    try {
      response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new UpstreamError(`OpenCode read failed: ${error instanceof Error ? error.message : "network error"}`, null, true);
    }
    if (!response.ok) {
      throw new UpstreamError(`OpenCode answered HTTP ${response.status} for ${path.split("?")[0]}`, response.status, response.status >= 500 || response.status === 429);
    }
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(`OpenCode answered an unreadable body for ${path.split("?")[0]}`, response.status, false);
    }
  };
  const collect = async (path) => {
    const all = [];
    let cursor = null;
    for (let page = 0;page < MAX_PAGES; page += 1) {
      const { items, cursor: next } = unwrapList(await get(path, cursor));
      all.push(...items);
      if (!next || next === cursor)
        break;
      cursor = next;
    }
    return all;
  };
  return {
    async listSessions() {
      const raw = await collect("/api/session");
      return raw.flatMap((item) => {
        const ref = sessionRefOf(item);
        return ref ? [ref] : [];
      });
    },
    listMessages(sessionId) {
      return collect(`/api/session/${encodeURIComponent(sessionId)}/message`);
    }
  };
};
var syncOnce = async (store, reader, options) => {
  let refs;
  try {
    refs = await reader.listSessions();
  } catch (error2) {
    const message = error2 instanceof Error ? error2.message : "OpenCode session list failed";
    store.lastError = message;
    return { processed: 0, pending: store.pending, toolsPending: store.toolsPending, error: message, listed: false };
  }
  reattributeSessions(store, refs);
  markParents(store, refs);
  const max = options.maxSessions ?? MAX_SESSIONS_PER_RUN;
  let processed = 0;
  let error = null;
  const readAll = async (batch) => {
    for (const ref of batch) {
      const buckets = store.sessions[ref.id];
      const needsBuckets = buckets === undefined || buckets.updated < ref.updated;
      try {
        const messages = await reader.listMessages(ref.id);
        if (needsBuckets)
          applySession(store, ref, messages);
        else
          applyToolsOnly(store, ref, messages);
        processed += 1;
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "OpenCode message read failed";
        if (caught instanceof UpstreamError && !caught.transient) {
          if (needsBuckets)
            applySkippedSession(store, ref, message);
          else
            applySkippedTools(store, ref);
          continue;
        }
        error = message;
        return false;
      }
    }
    return true;
  };
  let ok = await readAll(selectRecentSessions(refs, store, { now: options.now, max }));
  if (ok)
    ok = await readAll(selectSessions(refs, store.sessions, { max: Math.max(0, max - processed) }).selected);
  if (ok)
    await readAll(selectToolSessions(refs, store, { max: Math.max(0, max - processed) }));
  const left = selectSessions(refs, store.sessions, { max: 0 }).pending;
  pruneStore(store, options.now);
  store.syncedAt = options.now;
  store.pending = left;
  store.toolsPending = countToolsPending(refs, store);
  store.lastError = error;
  if (store.rebuilding && error === null && left === 0)
    delete store.rebuilding;
  return { processed, pending: left, toolsPending: store.toolsPending, error, listed: true };
};

// service/providers.ts
var FETCH_TIMEOUT_MS = 8000;
var GO_STATUS_URL = "https://opencode.ai/console/api/go/status";
var BILLING_URL = "https://opencode.ai/console/api/billing/status";
var GO_INFERENCE_USAGE_URL = "https://opencode.ai/inference/go/v1/usage";
var OLLAMA_BALANCE_URL = "https://ollama.com/api/balance";
var OLLAMA_USAGE_URL = "https://ollama.com/api/usage?range=7d&group_by=model";
var DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
var MICRO_CENTS_PER_DOLLAR = 1e8;
var GO_PRODUCTS = { go: "Go", "go-plus": "Go Plus", "go-teams": "Go Teams" };
var isObject4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var num2 = (value) => {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return null;
};
var usd2 = (value) => `$${value.toFixed(2)}`;
var clampPercent = (value) => Math.min(100, Math.max(0, value));
var parseMicroCents = (value) => {
  const n = num2(value);
  return n !== null && n >= 0 ? n : null;
};
var GO_METERS = [
  { source: "fiveHour", name: "5h", windowSeconds: 5 * 3600 },
  { source: "week", name: "weekly", windowSeconds: 7 * 86400 },
  { source: "month", name: "monthly", windowSeconds: null }
];
var resetOf = (meter) => toEpochMs(meter.resetsAt ?? meter.resetAt ?? meter.resetsAtMs ?? meter.resetAtMs ?? null);
var parseGoStatus = (json) => {
  if (!isObject4(json))
    return { ok: false, error: "OpenCode Go status was not an object." };
  const product = typeof json.product === "string" ? json.product : "";
  const planLabel = GO_PRODUCTS[product];
  if (!planLabel)
    return { ok: false, error: product ? `This account is on "${product}", not an OpenCode Go plan.` : "OpenCode Go status named no product." };
  const access = isObject4(json.access) ? json.access : null;
  const meters = access && isObject4(access.meters) ? access.meters : null;
  if (!access)
    return { ok: false, error: "No active OpenCode Go subscription on the selected Console account." };
  if (!meters)
    return { ok: false, error: "OpenCode Go status had no meters." };
  const windows = {};
  for (const { source, name, windowSeconds } of GO_METERS) {
    const meter = meters[source];
    if (!isObject4(meter))
      continue;
    const limit = parseMicroCents(meter.limitMicroCents);
    const used = parseMicroCents(meter.usedMicroCents);
    const resetAt = resetOf(meter);
    if (limit === null || used === null || limit <= 0 || resetAt === null)
      continue;
    windows[name] = { usedPercent: clampPercent(used / limit * 100), windowSeconds, resetAt };
  }
  if (Object.keys(windows).length === 0)
    return { ok: false, error: "OpenCode Go status had no usable meters." };
  return { ok: true, value: { planLabel, windows } };
};
var parseBilling = (json) => {
  const source = isObject4(json) && isObject4(json.data) && json.availableMicroCents === undefined ? json.data : json;
  if (!isObject4(source))
    return null;
  const micro = parseMicroCents(source.availableMicroCents);
  if (micro === null)
    return null;
  return { usedPercent: null, valueLabel: usd2(micro / MICRO_CENTS_PER_DOLLAR) };
};
var parseGoInference = (json) => {
  const usage = isObject4(json) && isObject4(json.usage) ? json.usage : null;
  if (!usage)
    return { ok: false, error: "OpenCode Go usage had no usage block." };
  const map = [["rolling", "5h", 5 * 3600], ["weekly", "weekly", 7 * 86400], ["monthly", "monthly", null]];
  const windows = {};
  for (const [source, name, windowSeconds] of map) {
    const entry = usage[source];
    if (!isObject4(entry))
      continue;
    const percent2 = num2(entry.percent);
    if (percent2 === null)
      continue;
    const window2 = { usedPercent: clampPercent(percent2), windowSeconds };
    const resetAt = toEpochMs(entry.resetsAt ?? entry.resetAt ?? null);
    if (resetAt !== null)
      window2.resetAt = resetAt;
    windows[name] = window2;
  }
  if (Object.keys(windows).length === 0)
    return { ok: false, error: "OpenCode Go usage had no usable windows." };
  return { ok: true, value: { windows } };
};
var parseOllamaBalance = (json) => {
  if (!isObject4(json))
    return { ok: false, error: "Ollama balance was not an object." };
  const windows = {};
  const included = isObject4(json.included) ? json.included : null;
  if (included) {
    const balance = num2(included.balance_usd);
    const allowance = num2(included.allowance_usd);
    if (balance !== null && allowance !== null && allowance > 0) {
      const spent = Math.max(0, allowance - balance);
      const window2 = {
        usedPercent: clampPercent(spent / allowance * 100),
        windowSeconds: null,
        valueLabel: `${usd2(Math.max(0, balance))} left`,
        value: { kind: "spend", spent, limit: allowance }
      };
      const period = isObject4(included.period) ? included.period : null;
      const until = period ? toEpochMs(period.until) : null;
      if (until !== null)
        window2.resetAt = until;
      windows.monthly = window2;
    }
  }
  const purchased = isObject4(json.purchased) ? json.purchased : null;
  const purchasedBalance = purchased ? num2(purchased.balance_usd) : null;
  if (purchasedBalance !== null && purchasedBalance > 0) {
    windows.credits_balance = { usedPercent: null, valueLabel: usd2(purchasedBalance) };
  }
  for (const [source, name, seconds] of [["session", "5h", 5 * 3600], ["weekly", "weekly", 7 * 86400]]) {
    const entry = json[source];
    if (!isObject4(entry))
      continue;
    const remaining = num2(entry.remaining_percent);
    if (remaining === null)
      continue;
    const window2 = { usedPercent: clampPercent(100 - remaining), windowSeconds: seconds };
    const resetAt = toEpochMs(entry.resets_at ?? entry.reset_at ?? entry.until ?? null);
    if (resetAt !== null)
      window2.resetAt = resetAt;
    windows[name] = window2;
  }
  if (Object.keys(windows).length === 0)
    return { ok: false, error: "Ollama balance had no readable window." };
  return { ok: true, value: { windows } };
};
var parseOllamaUsage = (json, fetchedAt) => {
  let list = null;
  let range = "7d";
  if (Array.isArray(json))
    list = json;
  else if (isObject4(json)) {
    if (typeof json.range === "string")
      range = json.range;
    for (const key of ["models", "usage", "data", "items", "results", "groups"]) {
      const candidate = json[key];
      if (Array.isArray(candidate)) {
        list = candidate;
        break;
      }
      if (isObject4(candidate)) {
        list = Object.entries(candidate).map(([model, value]) => isObject4(value) ? { model, ...value } : { model });
        break;
      }
    }
  }
  if (!list)
    return null;
  const models = [];
  for (const item of list) {
    if (!isObject4(item))
      continue;
    const model = [item.model, item.name, item.group, item.key].find((v) => typeof v === "string" && v !== "");
    if (!model)
      continue;
    models.push({
      model,
      usageUsd: num2(item.usage_usd ?? item.cost_usd ?? item.usd),
      requests: num2(item.requests ?? item.request_count),
      tokens: num2(item.tokens ?? item.total_tokens)
    });
  }
  models.sort((a, b) => (b.usageUsd ?? -1) - (a.usageUsd ?? -1));
  return { fetchedAt, range, models: models.slice(0, 20) };
};
var currencyLabel = (amount, currency) => {
  if (currency === "USD")
    return `$${amount.toFixed(2)}`;
  if (currency === "CNY")
    return `¥${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
};
var parseDeepSeekBalance = (json) => {
  const infos = isObject4(json) && Array.isArray(json.balance_infos) ? json.balance_infos : null;
  if (!infos)
    return { ok: false, error: "DeepSeek balance had no balance_infos." };
  const rows = infos.flatMap((info) => {
    if (!isObject4(info))
      return [];
    const currency = typeof info.currency === "string" && info.currency !== "" ? info.currency.toUpperCase() : null;
    const total = num2(info.total_balance);
    return currency && total !== null ? [{ currency, total }] : [];
  });
  if (rows.length === 0)
    return { ok: false, error: "DeepSeek balance had no readable amount." };
  rows.sort((a, b) => (a.currency === "USD" ? -1 : 0) - (b.currency === "USD" ? -1 : 0));
  const windows = {};
  rows.forEach((row, index) => {
    const name = index === 0 ? "credits_balance" : `credits_balance_${row.currency.toLowerCase()}`;
    windows[name] = { usedPercent: null, valueLabel: currencyLabel(row.total, row.currency) };
  });
  return { ok: true, value: { windows } };
};
var getJson = async (fetchFn, url, headers) => {
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const raw = name === "TimeoutError" || name === "AbortError" ? "timed out after 8 s" : error instanceof Error ? error.message : "network error";
    const secret = (headers.Authorization ?? "").replace(/^Bearer\s+/i, "");
    return { status: null, error: secret ? raw.split(secret).join("[key]") : raw };
  }
};
var httpFailure = (label, result) => result.status === null ? `${label}: ${result.error}.` : `${label}: HTTP ${result.status}.`;
var apiKeyOf = (credential, label) => {
  if (credential.type !== "api")
    return { error: `${label} needs an API key; its OpenCode login is a browser (OAuth) login, which Provider Ledger cannot use.` };
  const key = credential.key;
  return typeof key === "string" && key.trim() !== "" ? { key: key.trim() } : { error: `${label} has an empty API key.` };
};
var failure = (error, needsSignIn = false) => ({
  ok: false,
  configured: true,
  error,
  ...needsSignIn ? { needsSignIn: true } : {},
  windows: {}
});
var SIGN_IN_EXPIRED = "Your OpenCode sign-in has expired — sign in again on OpenCode Console in Providers.";
var ORGANIZATION_ID = /^(?:org|wrk)_[A-Za-z0-9]+$/;
var openCodeAuth = (credential, label, now) => {
  if (credential.type === "api") {
    const key = typeof credential.key === "string" ? credential.key.trim() : "";
    return key ? { kind: "api", headers: { Authorization: `Bearer ${key}` } } : { kind: "error", error: `${label} has an empty API key.`, needsSignIn: false };
  }
  if (typeof credential.expires === "number" && credential.expires > 0 && credential.expires <= now) {
    return { kind: "error", error: SIGN_IN_EXPIRED, needsSignIn: true };
  }
  const access = typeof credential.access === "string" ? credential.access.trim() : "";
  const orgID = typeof credential.orgID === "string" ? credential.orgID.trim() : "";
  if (!access)
    return { kind: "error", error: SIGN_IN_EXPIRED, needsSignIn: true };
  if (!ORGANIZATION_ID.test(orgID)) {
    return { kind: "error", error: `${label}: the OpenCode sign-in has no organization selected. Choose one on OpenCode Console in Providers.`, needsSignIn: false };
  }
  return { kind: "oauth", headers: { Authorization: `Bearer ${access}`, "x-org-id": orgID } };
};
var isOk = (result) => result.status !== null && result.status >= 200 && result.status < 300;
var isRefused = (result) => result.status === 401 || result.status === 403;
var readOpenCodeGo = async (credential, fetchFn, now = Date.now()) => {
  const auth = openCodeAuth(credential, "OpenCode Go", now);
  if (auth.kind === "error")
    return failure(auth.error, auth.needsSignIn);
  const headers = auth.headers;
  const [status, billing] = await Promise.all([
    getJson(fetchFn, GO_STATUS_URL, headers),
    getJson(fetchFn, BILLING_URL, headers)
  ]);
  const billingWindow = isOk(billing) ? parseBilling(billing.json) : null;
  if (auth.kind === "oauth") {
    if (isRefused(status))
      return failure(SIGN_IN_EXPIRED, true);
    if (!isOk(status))
      return failure(httpFailure("OpenCode Go status", status));
    const parsed = parseGoStatus(status.json);
    if (!parsed.ok)
      return failure(parsed.error);
    const windows = { ...parsed.value.windows };
    if (billingWindow)
      windows.credits_balance = billingWindow;
    return { ok: true, configured: true, planLabel: parsed.value.planLabel, windows };
  }
  if (isOk(status)) {
    const parsed = parseGoStatus(status.json);
    if (!parsed.ok)
      return failure(parsed.error);
    const windows = { ...parsed.value.windows };
    if (billingWindow)
      windows.credits_balance = billingWindow;
    return { ok: true, configured: true, planLabel: parsed.value.planLabel, windows };
  }
  const fallback = await getJson(fetchFn, GO_INFERENCE_USAGE_URL, { ...headers, "x-opencode-session": "openchamber-provider-ledger" });
  if (isOk(fallback)) {
    const parsed = parseGoInference(fallback.json);
    if (parsed.ok) {
      const windows = { ...parsed.value.windows };
      if (billingWindow)
        windows.credits_balance = billingWindow;
      return { ok: true, configured: true, planLabel: null, windows };
    }
  }
  return failure(`${httpFailure("OpenCode Go status", status)} ${httpFailure("Fallback usage", fallback)}`.trim());
};
var readOpenCodeZen = async (credential, fetchFn, now = Date.now()) => {
  const auth = openCodeAuth(credential, "OpenCode Zen", now);
  if (auth.kind === "error")
    return failure(auth.error, auth.needsSignIn);
  const result = await getJson(fetchFn, BILLING_URL, auth.headers);
  if (isRefused(result)) {
    return auth.kind === "oauth" ? failure(SIGN_IN_EXPIRED, true) : failure("OpenCode Zen has no balance API for API keys.");
  }
  if (isOk(result)) {
    const window2 = parseBilling(result.json);
    if (window2)
      return { ok: true, configured: true, planLabel: null, windows: { credits_balance: window2 } };
    return failure("OpenCode Zen billing answered without a balance.");
  }
  return failure(httpFailure("OpenCode Zen billing", result));
};
var readOllama = async (credential, fetchFn, now) => {
  const auth = apiKeyOf(credential, "Ollama");
  if ("error" in auth)
    return failure(auth.error);
  const headers = { Authorization: `Bearer ${auth.key}` };
  const balance = await getJson(fetchFn, OLLAMA_BALANCE_URL, headers);
  if (balance.status === 429)
    return failure("Ollama rate limit reached (10 requests a minute); it will retry on the next refresh.");
  if (balance.status === null || balance.status < 200 || balance.status >= 300)
    return failure(httpFailure("Ollama balance", balance));
  const parsed = parseOllamaBalance(balance.json);
  if (!parsed.ok)
    return failure(parsed.error);
  const usage = await getJson(fetchFn, OLLAMA_USAGE_URL, headers);
  const ollamaUsage = usage.status !== null && usage.status >= 200 && usage.status < 300 ? parseOllamaUsage(usage.json, now) : null;
  return { ok: true, configured: true, planLabel: null, windows: parsed.value.windows, ollamaUsage };
};
var readDeepSeek = async (credential, fetchFn) => {
  const auth = apiKeyOf(credential, "DeepSeek");
  if ("error" in auth)
    return failure(auth.error);
  const result = await getJson(fetchFn, DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${auth.key}` });
  if (result.status === null || result.status < 200 || result.status >= 300)
    return failure(httpFailure("DeepSeek balance", result));
  const parsed = parseDeepSeekBalance(result.json);
  if (!parsed.ok)
    return failure(parsed.error);
  return { ok: true, configured: true, planLabel: null, windows: parsed.value.windows };
};
var readAnthropic = () => ({
  ok: true,
  configured: true,
  error: "Anthropic has no balance API; see the ledger for spend.",
  planLabel: null,
  windows: {}
});
var READERS = {
  "opencode-go": { family: "opencode-go", read: (c, f, n) => readOpenCodeGo(c, f, n) },
  opencode: { family: "opencode-zen", read: (c, f, n) => readOpenCodeZen(c, f, n) },
  "ollama-cloud": { family: "ollama", read: (c, f, n) => readOllama(c, f, n) },
  "console-ollama-cloud": { family: "ollama", read: (c, f, n) => readOllama(c, f, n) },
  ollama: { family: "ollama", read: (c, f, n) => readOllama(c, f, n) },
  deepseek: { family: "deepseek", read: (c, f) => readDeepSeek(c, f) },
  anthropic: { family: "anthropic", read: () => Promise.resolve(readAnthropic()) }
};
var refreshProviders = async (credentials, fetchFn, now) => {
  const list = Object.entries(credentials).map(([provider, credential]) => ({ provider, credential, derived: false }));
  const shared0 = credentials.opencode;
  if (shared0 && !credentials["opencode-go"])
    list.push({ provider: "opencode-go", credential: shared0, derived: true });
  const shared = new Map;
  const jobs = list.flatMap(({ provider, credential, derived }) => {
    const reader = READERS[provider];
    if (!reader)
      return [];
    const identity = credential.type === "api" ? `${reader.family}:${credential.key}` : `${reader.family}:oauth:${provider}`;
    let entry = shared.get(identity);
    let duplicateOf = null;
    if (entry)
      duplicateOf = entry.first;
    else {
      entry = {
        first: provider,
        promise: reader.read(credential, fetchFn, now).catch((error) => {
          const secret = credential.type === "api" ? credential.key : "";
          const raw = error instanceof Error ? error.message : "unknown error";
          return failure(`${providerName(provider)} read failed: ${secret ? raw.split(secret).join("[key]") : raw}`);
        })
      };
      shared.set(identity, entry);
    }
    const quiet = derived && credential.type === "api";
    return [entry.promise.then((result) => quiet && !result.ok ? null : { provider, result, duplicateOf })];
  });
  return (await Promise.all(jobs)).filter((item) => item !== null);
};
var snapshotOf = (provider, result, fetchedAt) => ({
  provider,
  fetchedAt,
  ok: result.ok,
  configured: result.configured,
  ...result.error ? { error: result.error } : {},
  ...result.needsSignIn ? { needsSignIn: true } : {},
  planLabel: result.planLabel ?? null,
  windows: result.windows
});

// service/quota.ts
var WINDOWS_MAX = 32;
var ERROR_MAX = 2000;
var spendWindow = (spent) => ({
  usedPercent: null,
  windowSeconds: null,
  valueLabel: `${money(spent)} spent`,
  value: { kind: "spend", spent, limit: null }
});
var buildQuotaData = (view, store, refreshed) => {
  const windows = {};
  if (store.syncedAt !== null) {
    windows.today = spendWindow(view.totals.today.cost);
    windows.weekly = spendWindow(view.totals.d7.cost);
    windows.monthly = spendWindow(view.totals.d30.cost);
  }
  for (const { provider, result, duplicateOf } of refreshed) {
    if (!result.ok || duplicateOf)
      continue;
    for (const [name, window2] of Object.entries(result.windows)) {
      if (Object.keys(windows).length >= WINDOWS_MAX)
        break;
      windows[`${providerName(provider)} · ${windowLabel(name)}`.slice(0, 128)] = window2;
    }
  }
  const failed = refreshed.filter((r) => !r.result.ok && !r.duplicateOf);
  const attempted = refreshed.filter((r) => !r.duplicateOf);
  const everyFailed = attempted.length > 0 && failed.length === attempted.length;
  const error = everyFailed ? failed.map((r) => `${providerName(r.provider)}: ${r.result.error ?? "read failed"}`).join(" ").slice(0, ERROR_MAX) : undefined;
  return {
    ok: !everyFailed,
    configured: true,
    ...error ? { error } : {},
    usage: { windows }
  };
};

// service/status.ts
var ROWS_MAX = 16;
var WINDOW_ORDER2 = ["5h", "weekly", "monthly", "credits_balance"];
var toneFor = (usedPercent) => usedPercent >= 85 ? "error" : usedPercent >= 60 ? "warning" : "success";
var slug = (value) => `p-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 40);
var pickWindow = (windows) => {
  for (const name of WINDOW_ORDER2) {
    const window2 = windows[name];
    if (window2)
      return [name, window2];
  }
  const first = Object.entries(windows)[0];
  return first ?? null;
};
var balanceRow = (snapshot, now) => {
  if (!snapshot.ok)
    return null;
  const picked = pickWindow(snapshot.windows);
  if (!picked)
    return null;
  const [name, window2] = picked;
  const label = providerName(snapshot.provider);
  const tooltip = `${label} ${windowLabel(name)}, read ${ago(snapshot.fetchedAt, now)}.`;
  if (window2.usedPercent !== null) {
    const value = window2.valueLabel ? window2.valueLabel : `${windowLabel(name)} ${percent(window2.usedPercent)}`;
    return {
      kind: "line",
      id: slug(snapshot.provider),
      label,
      content: { kind: "bar", value: Math.min(100, Math.max(0, window2.usedPercent)), tone: toneFor(window2.usedPercent) },
      value: value.slice(0, 80),
      tooltip
    };
  }
  if (window2.valueLabel) {
    return { kind: "line", id: slug(snapshot.provider), label, value: window2.valueLabel.slice(0, 80), tooltip };
  }
  return null;
};
var budgetRows = (view, store) => buildBudgetRows(view, store.budgets).flatMap((b) => {
  if (b.capUsd === null || b.share === null || b.state !== "warning" && b.state !== "error")
    return [];
  const tone = b.state;
  const partial = store.rebuilding === true ? " History is still being re-read, so the real figure may be higher." : "";
  return [{
    kind: "line",
    id: `cap-${slug(b.provider)}`,
    label: `${b.name} cap`,
    dot: tone,
    content: { kind: "bar", value: Math.min(100, b.share), tone },
    value: `${money(b.spentUsd)} of ${money(b.capUsd)} · ${percent(b.share)}`.slice(0, 80),
    valueTone: tone,
    tooltip: `${b.name} has used ${percent(b.share)} of its ${money(b.capUsd)} monthly cap (${money(b.spentUsd)} this UTC month, ${money(b.remainingUsd)} left).${partial}`.slice(0, 300)
  }];
});
var buildStatusView = (view, store, now) => {
  const rows = [...budgetRows(view, store)];
  if (store.syncedAt === null) {
    rows.push({
      kind: "note",
      id: "not-synced",
      tone: store.lastError ? "warning" : "info",
      text: store.lastError ? `Ledger has not synced yet: ${store.lastError}`.slice(0, 300) : "Ledger has not synced yet. The first sync reads up to 40 sessions a run, so it takes a few runs."
    });
  } else {
    const today = view.totals.today;
    rows.push({
      kind: "line",
      id: "today",
      label: "Today",
      value: money(today.cost),
      tooltip: `${compact(today.tokens)} tokens in ${today.messages} replies (UTC day).`
    });
    const week = view.totals.d7;
    rows.push({
      kind: "line",
      id: "week",
      label: "7 days",
      value: money(week.cost),
      content: { kind: "chart", values: view.daily7.map((d) => d.cost), tone: "accent" },
      tooltip: `${compact(week.tokens)} tokens in ${week.messages} replies. 30 days: ${money(view.totals.d30.cost)}.`
    });
    const top = view.periods.d7.providers[0];
    if (top && top.cost > 0 && week.cost > 0) {
      const share = top.cost / week.cost * 100;
      rows.push({
        kind: "line",
        id: "top",
        label: "Top provider",
        content: { kind: "bar", value: Math.min(100, share), tone: "accent" },
        value: `${top.name} · ${percent(share)}`.slice(0, 80),
        tooltip: `${top.name} spent ${money(top.cost)} of ${money(week.cost)} over 7 days.`
      });
    }
  }
  const ranked = view.periods.all.providers;
  const rank = new Map(ranked.map((p, i) => [canonicalProvider(p.provider), i]));
  const ledgerId = new Map(ranked.map((p) => [canonicalProvider(p.provider), p.provider]));
  const snapshots = Object.values(store.balances).sort((a, b) => (rank.get(canonicalProvider(a.provider)) ?? 999) - (rank.get(canonicalProvider(b.provider)) ?? 999) || (a.provider < b.provider ? -1 : 1));
  const seen = new Set(rows.map((r) => r.id));
  const accounts = new Set;
  for (const snapshot of snapshots) {
    const account = canonicalProvider(snapshot.provider);
    if (accounts.has(account))
      continue;
    const row = balanceRow({ ...snapshot, provider: ledgerId.get(account) ?? snapshot.provider }, now);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      accounts.add(account);
      rows.push(row);
    }
  }
  if (store.syncedAt !== null && store.rebuilding) {
    rows.push({ kind: "note", id: "backfill", tone: "info", text: `Re-reading history for client attribution${store.pending > 0 ? `: ${store.pending} sessions still to go` : ""}. Figures are partial until it finishes.`.slice(0, 300) });
  } else if (store.syncedAt !== null && store.pending > 0) {
    rows.push({ kind: "note", id: "backfill", tone: "info", text: `Reading history: ${store.pending} older sessions still to go.` });
  } else if (store.syncedAt !== null && store.lastError) {
    rows.push({ kind: "note", id: "sync-error", tone: "warning", text: `Last sync: ${store.lastError}`.slice(0, 300) });
  }
  if (rows.length === 0)
    rows.push({ kind: "note", id: "empty", text: DASH });
  return { rows: rows.slice(0, ROWS_MAX) };
};

// service/store.ts
import { constants as constants2 } from "node:fs";
import { chmod as chmod2, copyFile, mkdir as mkdir2, readFile, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
var defaultStorePath = () => process.env.PROVIDER_LEDGER_STORE || join2(homedir2(), ".local", "share", "openchamber-provider-ledger", "store.json");
var isStore = (value) => {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  return typeof v.version === "number" && Number.isInteger(v.version) && v.version >= 1 && v.version <= STORE_VERSION && typeof v.sessions === "object" && v.sessions !== null && typeof v.balances === "object" && v.balances !== null;
};
var cleanBudgets = (value) => {
  const out = {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return out;
  for (const [provider, cap] of Object.entries(value)) {
    if (provider !== "" && typeof cap === "number" && Number.isFinite(cap) && cap > 0)
      out[provider] = cap;
  }
  return out;
};
var cleanTools = (value) => {
  const out = {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return out;
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== "object" || entry === null)
      continue;
    const { toolsSynced, rows } = entry;
    if (typeof toolsSynced !== "number" || !Number.isFinite(toolsSynced) || typeof rows !== "object" || rows === null || Array.isArray(rows))
      continue;
    const clean = {};
    for (const [key, row] of Object.entries(rows)) {
      const r = row;
      if (typeof r?.calls === "number" && typeof r.generated === "number" && typeof r.contextChars === "number" && Number.isFinite(r.calls + r.generated + r.contextChars)) {
        clean[key] = { calls: r.calls, generated: r.generated, contextChars: r.contextChars };
      }
    }
    out[id] = { toolsSynced, rows: clean };
  }
  return out;
};
var cleanSettings = (value) => {
  const merged = mergeSettings(defaultSettings(), value, false);
  return merged.ok ? merged.settings : defaultSettings();
};
var migrateStore = async (path, old) => {
  try {
    await copyFile(path, `${path}.v${old.version}-backup`, constants2.COPYFILE_EXCL);
  } catch {}
  return {
    ...emptyStore(),
    syncedAt: typeof old.syncedAt === "number" ? old.syncedAt : null,
    balances: old.balances,
    ollamaUsage: old.ollamaUsage ?? null,
    budgets: cleanBudgets(old.budgets),
    settings: cleanSettings(old.settings),
    rebuilding: true
  };
};
var loadStore = async (path, now) => {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptyStore();
  }
  try {
    const parsed = JSON.parse(text);
    if (isStore(parsed)) {
      if (parsed.version < STORE_VERSION)
        return await migrateStore(path, parsed);
      const store = { ...emptyStore(), ...parsed, version: STORE_VERSION, tools: cleanTools(parsed.tools), toolsPending: typeof parsed.toolsPending === "number" ? parsed.toolsPending : 0, budgets: cleanBudgets(parsed.budgets), settings: cleanSettings(parsed.settings) };
      pruneStore(store, now);
      return store;
    }
  } catch {}
  try {
    await rename2(path, `${path}.corrupt-${now}`);
  } catch {}
  return emptyStore();
};
var saveStore = async (path, store, now) => {
  pruneStore(store, now);
  capStoreSize(store);
  const dir = dirname(path);
  await mkdir2(dir, { recursive: true, mode: 448 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile2(tmp, JSON.stringify(store), { mode: 384 });
  await chmod2(tmp, 384);
  await rename2(tmp, path);
};

// service/app.ts
var STALE_AFTER_MS = 10 * 60000;
var SYNC_EVERY_MS = 2 * 60000;
var ATTEMPT_GAP_MS = 15000;
var CHAIN_GAP_MS = 1000;
var CHAIN_MAX = 10;
var BODY_MAX = 1e6;
var MISSING_OPENCODE = "OpenCode access is not available: the opencode role has not been approved for this extension.";
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var createService = async (options) => {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetchFn ?? fetch;
  const autoSync = options.autoSync ?? true;
  const reader = options.reader ?? (options.opencodeUrl ? createOpenCodeReader(options.opencodeUrl, options.token, fetchFn) : null);
  const store = await loadStore(options.storePath, now());
  let version = 1;
  let view = null;
  let syncing = false;
  let chaining = false;
  let lastAttemptAt = 0;
  let persisting = Promise.resolve();
  const persist = () => {
    persisting = persisting.then(() => saveStore(options.storePath, store, now()).catch((error) => {
      console.error(`provider-ledger: could not write the store: ${error instanceof Error ? error.message : "unknown error"}`);
    }));
    return persisting;
  };
  const ledgerView = () => {
    const at = now();
    const key = `${version}|${dateKey(at)}`;
    if (!view || view.key !== key)
      view = { key, value: deriveLedger(store, at) };
    return view.value;
  };
  const runBatch = async () => {
    if (syncing)
      return null;
    lastAttemptAt = now();
    if (!reader) {
      store.lastError = MISSING_OPENCODE;
      return { processed: 0, pending: store.pending, toolsPending: store.toolsPending, error: MISSING_OPENCODE, listed: false };
    }
    syncing = true;
    try {
      return await syncOnce(store, reader, { now: now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync failed";
      store.lastError = message;
      return { processed: 0, pending: store.pending, toolsPending: store.toolsPending, error: message, listed: false };
    } finally {
      syncing = false;
      version += 1;
      await persist();
    }
  };
  const startChain = () => {
    if (chaining)
      return;
    chaining = true;
    (async () => {
      try {
        for (let i = 0;i < CHAIN_MAX; i += 1) {
          const outcome = await runBatch();
          if (!outcome || !outcome.listed || outcome.error || outcome.pending === 0 && outcome.toolsPending === 0)
            break;
          await sleep(CHAIN_GAP_MS);
        }
      } finally {
        chaining = false;
      }
    })();
  };
  const maybeSync = () => {
    if (!autoSync || syncing || chaining)
      return;
    const at = now();
    if (at - lastAttemptAt < ATTEMPT_GAP_MS)
      return;
    if (store.syncedAt === null || at - store.syncedAt > SYNC_EVERY_MS || store.pending > 0 || store.toolsPending > 0)
      startChain();
  };
  const panelPayload = () => {
    const at = now();
    const ledger = ledgerView();
    const balances = buildBalanceCards(store.balances, ledger.providerIds);
    const budgets = buildBudgetRows(ledger, store.budgets, balances);
    const fetched = balances.map((c) => c.fetchedAt).filter((t) => t !== null);
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
      collapsedProjects: collapsedProjects(store)
    };
  };
  const handleSettings = async (body) => {
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return { ok: false, error: "The request was not valid JSON." };
    }
    const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
    const base = record.reset === true ? resetRules(store.settings) : store.settings;
    const next = record.reset === true && record.settings === undefined ? { ok: true, settings: base } : mergeSettings(base, record.settings, true);
    if (!next.ok)
      return next;
    const rootsChanged = next.settings.roots.join(`
`) !== store.settings.roots.join(`
`);
    store.settings = next.settings;
    if (rootsChanged)
      rekeySessions(store);
    version += 1;
    await persist();
    return { ok: true, settings: store.settings };
  };
  const handleBudget = async (body) => {
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return { ok: false, error: "The request was not valid JSON." };
    }
    const record = typeof input === "object" && input !== null ? input : {};
    const result = setBudget(store, record.provider, record.capUsd === undefined ? NaN : record.capUsd);
    if (result.ok) {
      version += 1;
      await persist();
    }
    return result;
  };
  const handleExport = async () => exportCsv(store, now(), options.homeDir);
  const handleQuota = async (body) => {
    const request = readQuotaProviderRequest(body);
    if (!request)
      return { status: 400, body: { error: "bad-request" } };
    try {
      const at = now();
      const refreshed = await refreshProviders(request.input.credentials, fetchFn, at);
      const byProvider = new Map;
      for (const item of refreshed) {
        const own = snapshotOf(item.provider, item.result, at);
        if (planWindowsOf(own) || store.balances[item.provider]?.hadPlan)
          own.hadPlan = true;
        byProvider.set(item.provider, own);
        if (item.result.ollamaUsage)
          store.ollamaUsage = item.result.ollamaUsage;
      }
      for (const [provider, snapshot] of byProvider)
        store.balances[provider] = snapshot;
      version += 1;
      persist();
      maybeSync();
      return { status: 200, body: { ok: true, data: buildQuotaData(ledgerView(), store, refreshed) } };
    } catch (error) {
      return { status: 200, body: { ok: false, error: { message: (error instanceof Error ? error.message : "Provider Ledger failed").slice(0, 500) } } };
    }
  };
  const handleSync = async () => {
    if (syncing)
      return { syncedAt: store.syncedAt, sessions: 0, pending: store.pending, running: true };
    const outcome = await runBatch();
    if (outcome && outcome.listed && !outcome.error && (outcome.pending > 0 || outcome.toolsPending > 0))
      startChain();
    return {
      syncedAt: store.syncedAt,
      sessions: outcome?.processed ?? 0,
      pending: store.pending,
      ...outcome?.error ? { error: outcome.error } : {}
    };
  };
  const authorised = (header) => {
    const expected = Buffer.from(`Bearer ${options.token}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const handle = async (req, res) => {
    if (!authorised(req.headers.authorization))
      return send(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const route = url.pathname;
    const only = (expected) => {
      if (method === expected)
        return true;
      send(res, 405, { error: "method-not-allowed" });
      return false;
    };
    try {
      switch (route) {
        case "/health":
          if (only("GET"))
            send(res, 200, {});
          return;
        case "/status":
          if (!only("GET"))
            return;
          maybeSync();
          send(res, 200, buildStatusView(ledgerView(), store, now()));
          return;
        case "/panel":
          if (!only("GET"))
            return;
          maybeSync();
          send(res, 200, panelPayload());
          return;
        case "/quota": {
          if (!only("POST"))
            return;
          const body = await readBody(req);
          if (body === null)
            return send(res, 413, { error: "body-too-large" });
          const result = await handleQuota(body);
          return send(res, result.status, result.body);
        }
        case "/budgets": {
          if (!only("POST"))
            return;
          const body = await readBody(req);
          if (body === null)
            return send(res, 413, { error: "body-too-large" });
          return send(res, 200, await handleBudget(body));
        }
        case "/settings": {
          if (!only("POST"))
            return;
          const body = await readBody(req);
          if (body === null)
            return send(res, 413, { error: "body-too-large" });
          return send(res, 200, await handleSettings(body));
        }
        case "/export":
          if (!only("POST"))
            return;
          await readBody(req);
          return send(res, 200, await handleExport());
        case "/sync":
          if (!only("POST"))
            return;
          await readBody(req);
          return send(res, 200, await handleSync());
        default:
          return send(res, 404, { error: "not-found" });
      }
    } catch (error) {
      if (route === "/quota")
        return send(res, 200, { ok: false, error: { message: "Provider Ledger failed to answer." } });
      send(res, 500, { error: error instanceof Error ? error.message.slice(0, 300) : "internal" });
    }
  };
  return { handle, store, panelPayload, handleSync, handleQuota, handleBudget, handleSettings, handleExport, runBatch, persist };
};

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var service = await createService({
  token,
  storePath: defaultStorePath(),
  opencodeUrl: process.env.OPENCHAMBER_OPENCODE_URL
});
var server = http.createServer((req, res) => {
  service.handle(req, res);
});
server.listen(port, "127.0.0.1");
var shutdown = () => {
  server.close();
  service.persist().finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
