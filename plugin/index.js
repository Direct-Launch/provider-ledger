// Provider Ledger's agent tool: `provider_ledger`.
//
// This file runs inside OpenCode with the user's full access, so it keeps to one job: read
// the ledger store and answer in words. It never writes, never throws into the session, and
// imports nothing from the extension (OpenCode loads it with a bare import() from a folder
// where nothing is installed), so the few rules it shares with the service are written out
// here and a test holds the two to the same answers.

const PERIODS = ['today', 'd7', 'd30', 'month', 'lastMonth', 'all'];
const LABELS = { today: 'Today', d7: 'Last 7 days', d30: 'Last 30 days', month: 'This month', lastMonth: 'Last month', all: 'All time' };
const DEFAULT_PERIOD = 'month';
const DAY_MS = 86_400_000;
const WARN_PERCENT = 80;
const OVER_PERCENT = 100;
const NAMES = {
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

const nameOf = (id) => NAMES[id] ?? (id.split(/[-_.]/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ') || id);
// Ollama's key is stored under three ids; they are one account.
const accountOf = (id) => (id === 'ollama' || id === 'console-ollama-cloud' ? 'ollama-cloud' : id);

const money = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toFixed(2)}`;
};
const compact = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(v));
};
const pct = (v) => `${Math.round(v)}%`;

const dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => dateKey(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS);
const monthStart = (date, shift) => dateKey(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + shift, 1));

const rangeOf = (id, today, first) => {
  switch (id) {
    case 'today': return { from: today, to: today };
    case 'd7': return { from: addDays(today, -6), to: today };
    case 'd30': return { from: addDays(today, -29), to: today };
    case 'month': return { from: monthStart(today, 0), to: today };
    case 'lastMonth': return { from: monthStart(today, -1), to: addDays(monthStart(today, 0), -1) };
    default: return { from: first ?? today, to: today };
  }
};

// Whole cents, like the service: $8.00 of $10.00 is exactly 80 %.
const cents = (usd) => Math.round(usd * 100);
const stateOf = (spent, cap) => {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return 'none';
  const s = cents(Math.max(0, spent)) * 100;
  const c = cents(cap);
  if (s >= c * OVER_PERCENT) return 'error';
  if (s >= c * WARN_PERCENT) return 'warning';
  return 'ok';
};

const sum = (acc, b) => {
  const t = b.tokens ?? {};
  acc.cost += Number(b.cost) || 0;
  acc.messages += Number(b.messages) || 0;
  acc.tokens += (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0) + (Number(t.cacheRead) || 0) + (Number(t.cacheWrite) || 0);
};
const zero = () => ({ cost: 0, messages: 0, tokens: 0 });

/** Fold the store into per-provider totals for the asked range, this month, and all time. */
const summarise = (store, range, today) => {
  const period = new Map();
  const month = new Map();
  const all = new Map();
  const monthFrom = monthStart(today, 0);
  let first = null;
  for (const entry of Object.values(store.sessions ?? {})) {
    for (const [key, bucket] of Object.entries(entry?.buckets ?? {})) {
      const a = key.indexOf('|');
      const b = a < 0 ? -1 : key.indexOf('|', a + 1);
      if (b < 0) continue;
      const date = key.slice(0, a);
      const provider = key.slice(a + 1, b);
      if (date > today) continue;
      if (first === null || date < first) first = date;
      const into = (map) => { const t = map.get(provider) ?? zero(); map.set(provider, t); sum(t, bucket); };
      into(all);
      if (date >= monthFrom) into(month);
      if (date >= range.from && date <= range.to) into(period);
    }
  }
  return { period, month, all, first };
};

// ---- Surfaces: what the tools called in the period put into the conversation ----
// The same rules as the service (`service/tools.ts`, `buildSurfaces`); a test holds the two to one answer.

const TOOL_CLASSES = ['skill', 'mcp', 'agent', 'tool'];
const SURFACE_TOP = 3;

/** `date|provider|model|class|name`: the class and the name carry no bar, a model id may. */
const parseToolKey = (key) => {
  const first = key.indexOf('|');
  const second = first < 0 ? -1 : key.indexOf('|', first + 1);
  const last = key.lastIndexOf('|');
  const before = last < 0 ? -1 : key.lastIndexOf('|', last - 1);
  if (first < 0 || second < 0 || before <= second || last <= before) return null;
  const cls = key.slice(before + 1, last);
  const name = key.slice(last + 1);
  if (!TOOL_CLASSES.includes(cls) || name === '') return null;
  return { date: key.slice(0, first), cls, name };
};

const bySurface = (a, b) => b.contextChars - a.contextChars || b.generated - a.generated || b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Skills, MCP servers and the subagent share for a range; null when no tool call was ever read. */
const surfacesOf = (store, range, today, totals) => {
  const sessions = Object.values(store.sessions ?? {});
  const toolSessions = Object.values(store.tools ?? {}).filter((t) => t && typeof t === 'object' && t.rows && typeof t.rows === 'object');
  if (toolSessions.length === 0) return null;
  const groups = { skill: new Map(), mcp: new Map(), agent: new Map(), tool: new Map() };
  let calls = 0;
  for (const entry of toolSessions) {
    for (const [key, row] of Object.entries(entry.rows)) {
      const parsed = parseToolKey(key);
      if (!parsed || parsed.date > today || parsed.date < range.from || parsed.date > range.to) continue;
      const into = groups[parsed.cls].get(parsed.name) ?? { name: parsed.name, calls: 0, generated: 0, contextChars: 0 };
      groups[parsed.cls].set(parsed.name, into);
      into.calls += Number(row.calls) || 0;
      into.generated += Number(row.generated) || 0;
      into.contextChars += Number(row.contextChars) || 0;
      calls += Number(row.calls) || 0;
    }
  }
  const sub = { cost: 0, messages: 0, sessions: 0 };
  for (const entry of sessions) {
    if (typeof entry?.parent !== 'string' || entry.parent === '') continue;
    let touched = false;
    for (const [key, bucket] of Object.entries(entry.buckets ?? {})) {
      const a = key.indexOf('|');
      const date = a < 0 ? '' : key.slice(0, a);
      if (date < range.from || date > range.to || date > today) continue;
      sub.cost += Number(bucket.cost) || 0;
      sub.messages += Number(bucket.messages) || 0;
      touched = true;
    }
    if (touched) sub.sessions += 1;
  }
  const top = (map) => [...map.values()].sort(bySurface).slice(0, SURFACE_TOP);
  const dispatches = [...groups.agent.values()].reduce((n, r) => n + r.calls, 0);
  return {
    calls,
    skills: top(groups.skill),
    mcp: top(groups.mcp),
    dispatches,
    sub,
    share: totals.cost > 0 ? (sub.cost / totals.cost) * 100 : null,
    replyShare: totals.messages > 0 ? (sub.messages / totals.messages) * 100 : null,
  };
};

const surfaceLines = (store, range, today, totals) => {
  const s = surfacesOf(store, range, today, totals);
  if (s === null) return ['Surfaces: tool calls have not been read yet (the first sync reads recent sessions first).'];
  if (s.calls === 0 && s.sub.sessions === 0) return ['Surfaces: no tool calls in this period.'];
  const list = (rows) => rows.map((r) => `${r.name} ${r.calls} ${r.calls === 1 ? 'call' : 'calls'}, ${compact(r.contextChars)} chars`).join('; ');
  const lines = [];
  lines.push(`Surfaces, top skills: ${s.skills.length > 0 ? list(s.skills) : 'none'}. Top MCP servers: ${s.mcp.length > 0 ? list(s.mcp) : 'none'}.`);
  const share = s.share !== null ? `${pct(s.share)} of spend (${money(s.sub.cost)})` : s.replyShare !== null ? `${pct(s.replyShare)} of replies` : 'no replies';
  lines.push(`Subagents: ${s.dispatches} ${s.dispatches === 1 ? 'dispatch' : 'dispatches'}, ${s.sub.sessions} ${s.sub.sessions === 1 ? 'session' : 'sessions'} with ${share}, already inside the totals above. Chars are what a tool put into the conversation; no provider bills per tool.`);
  const pending = Number(store.toolsPending) || 0;
  if (pending > 0) lines.push(`Surfaces are partial: ${pending} sessions are still being read for tool calls.`);
  return lines;
};

const bestBalance = (balances, provider) => {
  const account = accountOf(provider);
  let best = null;
  const rank = (s) => (s.ok ? (Object.keys(s.windows ?? {}).length > 0 ? 3 : 2) : 1);
  for (const s of Object.values(balances ?? {})) {
    if (!s || accountOf(s.provider) !== account) continue;
    if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && s.fetchedAt > best.fetchedAt)) best = s;
  }
  return best;
};

const hasPlan = (snap) => snap !== null && (snap.hadPlan === true
  || (snap.ok && Object.entries(snap.windows ?? {}).some(([n, w]) => w && w.usedPercent !== null && w.usedPercent !== undefined && !n.startsWith('credits_balance'))));

const windowText = (name, w) => {
  const label = name === 'credits_balance' ? 'balance' : name.replace(/_/g, ' ');
  const used = typeof w.usedPercent === 'number' ? `${pct(w.usedPercent)} used` : null;
  const detail = [w.valueLabel, used].filter(Boolean).join(', ');
  return detail ? `${label} ${detail}` : label;
};

const balanceLine = (snap, now) => {
  if (!snap) return 'Balance: not read yet.';
  if (!snap.ok) return snap.needsSignIn ? 'Balance: sign in again.' : `Balance: could not be read${snap.error ? ` (${String(snap.error).slice(0, 80)})` : ''}.`;
  const windows = Object.entries(snap.windows ?? {}).filter(([, w]) => w && typeof w === 'object');
  if (windows.length === 0) return 'Balance: this provider has no balance API.';
  const parts = windows.slice(0, 5).map(([n, w]) => {
    const reset = typeof w.resetAt === 'number' && w.resetAt > now ? `, resets in ${resetIn(w.resetAt - now)}` : '';
    return `${windowText(n, w)}${reset}`;
  });
  return `Balance: ${parts.join('; ')}.`;
};

const resetIn = (ms) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)} days`;
};

const budgetLine = (spent, cap) => {
  const state = stateOf(spent, cap);
  if (state === 'none') return 'Budget: no monthly cap set.';
  const share = (spent / cap) * 100;
  const tail = state === 'error' ? 'over the cap' : state === 'warning' ? 'warning' : 'within the cap';
  return `Budget: ${money(spent)} of ${money(cap)} monthly cap this month (${pct(share)}, ${tail}), ${money(Math.max(0, cap - spent))} left.`;
};

const storePath = async () => {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  return process.env.PROVIDER_LEDGER_STORE || join(homedir(), '.local', 'share', 'openchamber-provider-ledger', 'store.json');
};

/** The answer, as text. Pure but for the one read; the caller turns any failure into a sentence. */
const answer = async (input, now) => {
  const asked = typeof input?.period === 'string' && input.period.trim() !== '' ? input.period.trim() : DEFAULT_PERIOD;
  if (!PERIODS.includes(asked)) {
    return `Unknown period "${asked.slice(0, 40)}". The periods are: ${PERIODS.join(', ')}.`;
  }
  const wanted = typeof input?.provider === 'string' ? input.provider.trim().toLowerCase() : '';

  const { readFile } = await import('node:fs/promises');
  const path = await storePath();
  let store;
  try {
    store = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'Provider Ledger has no data yet: its store does not exist. Open the Provider Ledger panel once so the service can read the sessions.';
    return `Provider Ledger could not read its store: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}.`;
  }
  if (typeof store !== 'object' || store === null || typeof store.sessions !== 'object' || store.sessions === null) {
    return 'Provider Ledger could not read its store: the file is not a ledger.';
  }

  const today = dateKey(now);
  // "All time" starts on the first day the ledger holds, which takes a pass of its own to find.
  const first = asked === 'all' ? summarise(store, { from: today, to: today }, today).first : null;
  const range = rangeOf(asked, today, first);
  const { period, month, all } = summarise(store, range, today);
  const caps = typeof store.budgets === 'object' && store.budgets !== null ? store.budgets : {};
  const balances = store.balances ?? {};

  const total = zero();
  for (const t of period.values()) { total.cost += t.cost; total.messages += t.messages; total.tokens += t.tokens; }
  const included = (provider) => {
    const t = all.get(provider);
    return t !== undefined && t.messages > 0 && t.cost === 0 && hasPlan(bestBalance(balances, provider));
  };

  const lines = [];
  const span = asked === 'today' ? `${range.from} UTC` : `${range.from} to ${range.to} UTC`;
  const everyIncluded = period.size > 0 && [...period.keys()].every(included);
  lines.push(`Provider Ledger, ${LABELS[asked]} (${span}): ${everyIncluded ? 'included in plan' : money(total.cost)} spend, ${compact(total.messages)} replies, ${compact(total.tokens)} tokens.`);

  const ranked = [...period.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].messages - a[1].messages || (a[0] < b[0] ? -1 : 1));
  if (ranked.length === 0) {
    lines.push('No replies in this period.');
  } else {
    const top = ranked.slice(0, 3).map(([provider, t], i) => {
      const what = included(provider) ? 'included in plan' : `${money(t.cost)}${total.cost > 0 ? ` (${pct((t.cost / total.cost) * 100)})` : ''}`;
      return `${i + 1}. ${nameOf(provider)} ${what}`;
    });
    lines.push(`Top providers: ${top.join('; ')}.`);
  }

  // Detail: the named provider, or every provider that has a cap or a readable balance.
  const ids = new Set([...all.keys(), ...Object.keys(caps)]);
  let detail;
  if (wanted !== '') {
    detail = [...ids].filter((id) => id.toLowerCase() === wanted || nameOf(id).toLowerCase().includes(wanted) || accountOf(id) === accountOf(wanted));
    if (detail.length === 0) {
      return `${lines.join('\n')}\nNo provider matching "${wanted.slice(0, 40)}" in the ledger. Known providers: ${[...ids].sort().join(', ') || 'none yet'}.`;
    }
  } else {
    detail = [...ids].filter((id) => caps[id] !== undefined || (bestBalance(balances, id)?.ok && Object.keys(bestBalance(balances, id).windows ?? {}).length > 0));
  }
  detail.sort((a, b) => ((month.get(b)?.cost ?? 0) - (month.get(a)?.cost ?? 0)) || (a < b ? -1 : 1));
  for (const id of detail.slice(0, 6)) {
    const spent = month.get(id)?.cost ?? 0;
    lines.push(`${nameOf(id)} (${id}): ${budgetLine(spent, caps[id])} ${balanceLine(bestBalance(balances, id), now)}`);
  }
  lines.push(...surfaceLines(store, range, today, total));
  if (store.rebuilding === true) lines.push('Note: the history is being re-read after an upgrade, so these figures are partial until it finishes.');
  return lines.join('\n');
};

export default {
  id: 'provider-ledger',
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'provider_ledger',
        description: 'What the model providers cost and what is left on them, from the Provider Ledger extension. Answers a short text: spend, replies and tokens for a period, the top three providers by spend, a Surfaces line (the top three skills and MCP servers by what they put into the conversation, and the subagent share of spend), and for the named provider (or every one that has a monthly cap or a readable balance) its balance windows and its budget state this UTC month. Read-only. Use it to check a budget or a balance before a long or expensive run, or to answer "what has this cost".',
        input: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: PERIODS, description: `Which days to total (UTC): ${PERIODS.join(', ')}. Default ${DEFAULT_PERIOD}.` },
            provider: { type: 'string', description: 'A provider id or name, such as anthropic or Ollama. Omit for the providers that have a cap or a balance.' },
          },
          additionalProperties: false,
        },
        async execute(input) {
          try {
            return { content: await answer(input, Date.now()) };
          } catch (error) {
            return { content: `Provider Ledger could not answer: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}.` };
          }
        },
      });
    });
  },
};
