import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { aggregateMessages, applySession, deriveLedger, emptyStore } from '../service/ledger.ts';
import { UNKNOWN_AGENT, categoryOf, defaultSettings, mergeSettings, resetRules, scopeOf } from '../service/spend.ts';
import { CATEGORY_LABELS, SPEND_CATEGORIES } from '../shared/types.ts';
import { msg, storeOf, switchTo } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const S = defaultSettings();
const at = (minute: number): number => Date.UTC(2026, 10, 26, 9, minute);

describe('scope', () => {
  test('the shipped local runtimes are local, everything else is cloud', () => {
    for (const id of ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'llama.cpp']) expect(scopeOf(id, 'qwen3:8b', S)).toBe('local');
    for (const id of ['anthropic', 'openai', 'opencode-go', 'deepseek', 'ollama-cloud']) expect(scopeOf(id, 'm', S)).toBe('cloud');
  });

  test('a model id ending :cloud is cloud even on a local runtime', () => {
    expect(scopeOf('ollama', 'deepseek-v4.1-flash:cloud', S)).toBe('cloud');
    expect(scopeOf('ollama', 'DeepSeek-V4:CLOUD', S)).toBe('cloud');
    expect(scopeOf('lmstudio', 'x:cloud', S)).toBe('cloud');
    expect(scopeOf('ollama', 'llama3.1:8b', S)).toBe('local');
    expect(scopeOf('ollama', 'cloud-llama:latest', S)).toBe('local');
  });

  test('the local provider ids are editable, case does not matter', () => {
    const mine = { ...S, localProviders: ['my-box'] };
    expect(scopeOf('My-Box', 'm', mine)).toBe('local');
    expect(scopeOf('ollama', 'm', mine)).toBe('cloud');
  });
});

describe('category order', () => {
  const settings = { ...S, utilityModels: ['tiny-router', 'acme/*-title'], codingAgents: ['build', 'coder'] };

  test('an image model is image whatever agent wrote the reply', () => {
    for (const model of ['gpt-image-1', 'dall-e-3', 'imagen-4', 'flux-pro', 'seedream-4', 'recraft-v3', 'ideogram-v3', 'sdxl-turbo', 'stable-diffusion-3', 'GPT-IMAGE-2']) {
      expect(categoryOf('p', model, 'build', settings)).toBe('image');
      expect(categoryOf('p', model, UNKNOWN_AGENT, settings)).toBe('image');
    }
  });

  test('image beats embedding beats utility beats the agent', () => {
    expect(categoryOf('p', 'flux-embed', 'build', settings)).toBe('image');
    expect(categoryOf('p', 'text-embedding-3-small', 'build', settings)).toBe('embedding');
    expect(categoryOf('ollama', 'nomic-embed-text', 'plan', settings)).toBe('embedding');
    expect(categoryOf('p', 'bge-m3', 'build', settings)).toBe('embedding');
    const both = { ...settings, utilityModels: ['text-embedding-3-small', 'gpt-image-1'] };
    expect(categoryOf('p', 'text-embedding-3-small', 'build', both)).toBe('embedding');
    expect(categoryOf('p', 'gpt-image-1', 'build', both)).toBe('image');
  });

  test('a listed utility model is utility, by model id, provider/model or wildcard', () => {
    expect(categoryOf('p', 'tiny-router', 'build', settings)).toBe('utility');
    expect(categoryOf('p', 'TINY-ROUTER', UNKNOWN_AGENT, settings)).toBe('utility');
    expect(categoryOf('acme', 'x-title', 'plan', settings)).toBe('utility');
    expect(categoryOf('other', 'x-title', 'plan', settings)).toBe('agentic');
  });

  test('by agent: a coding agent is coding, any other agent is agentic', () => {
    expect(categoryOf('p', 'm', 'build', settings)).toBe('coding');
    expect(categoryOf('p', 'm', 'Coder', settings)).toBe('coding');
    expect(categoryOf('p', 'm', 'plan', settings)).toBe('agentic');
    expect(categoryOf('p', 'm', 'explore', settings)).toBe('agentic');
  });

  test('an unknown agent is uncategorised, never a guess', () => {
    expect(categoryOf('p', 'm', UNKNOWN_AGENT, settings)).toBe('uncategorised');
    expect(categoryOf('p', 'm', '', settings)).toBe('uncategorised');
  });

  test('every category has a label', () => {
    for (const category of SPEND_CATEGORIES) expect(CATEGORY_LABELS[category]).not.toBe('');
  });
});

describe('the agent in force', () => {
  const keysOf = (messages: unknown[], sessionAgent: string | null = null): Record<string, number> => {
    const { buckets } = aggregateMessages(messages, 'p', sessionAgent);
    return Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k.split('|').slice(-1)[0], b.messages]));
  };

  test('a session that switches between build and plan splits its replies', () => {
    const messages = [
      switchTo(at(0), 'build'),
      msg(at(1), 'anthropic', 's', 1),
      msg(at(2), 'anthropic', 's', 1),
      switchTo(at(3), 'plan'),
      msg(at(4), 'anthropic', 's', 1),
      switchTo(at(5), 'build'),
      msg(at(6), 'anthropic', 's', 1),
    ];
    expect(keysOf(messages)).toEqual({ build: 3, plan: 1 });
    const store = storeOf([{ id: 's', directory: '/x/app', agent: 'build', messages }]);
    const types = deriveLedger(store, NOW).periods.today.types;
    expect(types.categories.map((c) => [c.category, c.messages])).toEqual([['coding', 3], ['agentic', 1]]);
    expect(types.categories.reduce((a, c) => a + c.cost, 0)).toBe(4);
    expect(types.uncategorised.messages).toBe(0);
  });

  test('replies are folded in time order even when the stream is not', () => {
    const messages = [
      msg(at(6), 'anthropic', 's', 1),
      switchTo(at(5), 'plan'),
      msg(at(4), 'anthropic', 's', 1),
      switchTo(at(3), 'build'),
      msg(at(2), 'anthropic', 's', 1),
    ];
    // sorted: a reply before any switch (unknown), then build, then plan
    expect(keysOf(messages)).toEqual({ [UNKNOWN_AGENT]: 1, build: 1, plan: 1 });
  });

  test('a stream with no times keeps the order it arrived in', () => {
    const noTime = (agent: string): unknown => ({ info: { type: 'agent-switched', agent } });
    expect(keysOf([noTime('plan'), msg(at(1), 'a', 'm', 0), noTime('build'), msg(at(2), 'a', 'm', 0)])).toEqual({ plan: 1, build: 1 });
  });

  test('with no switch at all the session\u2019s own agent is used', () => {
    expect(keysOf([msg(at(1), 'a', 'm', 0), msg(at(2), 'a', 'm', 0)], 'plan')).toEqual({ plan: 2 });
  });

  test('a reply before the first switch has no known agent, even with a session agent, rather than a guess', () => {
    expect(keysOf([msg(at(1), 'a', 'm', 0), switchTo(at(2), 'plan'), msg(at(3), 'a', 'm', 0)], 'plan')).toEqual({ [UNKNOWN_AGENT]: 1, plan: 1 });
  });

  test('neither a switch nor a session agent is uncategorised', () => {
    expect(keysOf([msg(at(1), 'a', 'm', 0)])).toEqual({ [UNKNOWN_AGENT]: 1 });
    const types = deriveLedger(storeOf([{ id: 's', directory: '/x/app', messages: [msg(NOW - 1000, 'anthropic', 's', 2), msg(NOW - 2000, 'anthropic', 's', 3)] }]), NOW).periods.today.types;
    expect(types.categories.map((c) => c.category)).toEqual(['uncategorised']);
    expect(types.uncategorised).toEqual({ messages: 2, cost: 5, replyShare: 100 });
  });

  test('a reply that names its own agent keeps it, and a switch to nothing readable is unknown', () => {
    const own = { info: { ...(msg(at(1), 'a', 'm', 0) as { info: object }).info, agent: 'explore' } };
    expect(keysOf([switchTo(at(0), 'build'), own])).toEqual({ explore: 1 });
    expect(keysOf([switchTo(at(0), 'build'), { info: { type: 'agent-switched', time: { created: at(1) } } }, msg(at(2), 'a', 'm', 0)])).toEqual({ [UNKNOWN_AGENT]: 1 });
  });

  test('a switch entry is not a reply and is not counted as a skipped message', () => {
    const { skipped } = aggregateMessages([switchTo(at(0), 'build'), msg(at(1), 'a', 'm', 0), { info: { role: 'user' } }], 'p');
    expect(skipped).toBe(1);
  });

  test('an agent id with a bar cannot break the bucket key', () => {
    expect(Object.keys(aggregateMessages([switchTo(at(0), 'a|b'), msg(at(1), 'a', 'm', 0)]).buckets)[0]?.endsWith('|a b')).toBe(true);
  });

  test('re-reading a session replaces, and the settings can change the answer without a re-read', () => {
    const store = emptyStore();
    const messages = [switchTo(at(0), 'plan'), msg(NOW - 1000, 'anthropic', 's', 1)];
    applySession(store, { id: 's', updated: 1, directory: '/x/app' }, messages);
    expect(deriveLedger(store, NOW).periods.today.types.categories[0]?.category).toBe('agentic');
    store.settings.codingAgents = ['plan'];
    expect(deriveLedger(store, NOW).periods.today.types.categories[0]?.category).toBe('coding');
  });
});

describe('the Types view', () => {
  const store = storeOf([
    { id: 'a', directory: '/x/app', agent: 'build', messages: [
      msg(NOW - 1000, 'anthropic', 'sonnet', 4, { output: 100 }),
      msg(NOW - 2000, 'ollama', 'llama3:8b', 0, { output: 50 }),
      msg(NOW - 3000, 'ollama', 'deepseek-v4.1-flash:cloud', 0.5),
    ] },
    { id: 'b', directory: '/x/app', agent: 'explore', messages: [msg(NOW - 4000, 'anthropic', 'sonnet', 1)] },
    { id: 'c', directory: '/x/app', agent: 'build', messages: [msg(NOW - 5000, 'openai', 'gpt-image-1', 2), msg(NOW - 6000, 'openai', 'text-embedding-3-small', 0.01)] },
    { id: 'd', directory: '/x/app', messages: [msg(NOW - 7000, 'ollama', 'qwen3:8b', 0)] },
  ]);
  const types = deriveLedger(store, NOW).periods.today.types;

  test('spend by category, most spend first, with shares of spend and of replies', () => {
    expect(types.categories.map((c) => [c.category, Math.round(c.cost * 100) / 100, c.messages])).toEqual([
      ['coding', 4.5, 3], ['image', 2, 1], ['agentic', 1, 1], ['embedding', 0.01, 1], ['uncategorised', 0, 1],
    ]);
    const spend = types.categories.reduce((a, c) => a + (c.share ?? 0), 0);
    const replies = types.categories.reduce((a, c) => a + (c.replyShare ?? 0), 0);
    expect(spend).toBeCloseTo(100, 9);
    expect(replies).toBeCloseTo(100, 9);
  });

  test('local counts replies and tokens and no money; :cloud on a local runtime is cloud spend', () => {
    expect(types.local).toEqual({ tokens: 1050 + 1100, messages: 2 });
    expect(types.cloud.messages).toBe(5);
    expect(types.cloud.cost).toBeCloseTo(7.51, 9);
    expect(types.local).not.toHaveProperty('cost');
  });

  test('uncategorised says how much of the period it is', () => {
    expect(types.uncategorised.messages).toBe(1);
    expect(types.uncategorised.replyShare).toBeCloseTo((1 / 7) * 100, 9);
  });

  test('each category lists its providers with their scope; one provider can be both local and cloud', () => {
    const coding = types.categories.find((c) => c.category === 'coding');
    expect(coding?.providers.map((p) => [p.provider, p.scope, p.messages])).toEqual([
      ['anthropic', 'cloud', 1], ['ollama', 'cloud', 1], ['ollama', 'local', 1],
    ]);
  });

  test('the category totals add up to the period', () => {
    const view = deriveLedger(store, NOW).periods.today;
    expect(types.categories.reduce((a, c) => a + c.cost, 0)).toBeCloseTo(view.totals.cost, 9);
    expect(types.categories.reduce((a, c) => a + c.messages, 0)).toBe(view.totals.messages);
    expect(types.cloud.messages + types.local.messages).toBe(view.totals.messages);
  });

  test('an empty period has no categories and zero shares', () => {
    const empty = deriveLedger(emptyStore(), NOW).periods.today.types;
    expect(empty).toEqual({ categories: [], cloud: { cost: 0, tokens: 0, messages: 0 }, local: { tokens: 0, messages: 0 }, uncategorised: { messages: 0, cost: 0, replyShare: null } });
  });
});

describe('settings', () => {
  test('the shipped defaults are the documented ones', () => {
    expect(S.localProviders).toEqual(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'llama.cpp']);
    expect(S.imagePatterns).toEqual(['gpt-image', 'dall-e', 'imagen', 'flux', 'seedream', 'recraft', 'ideogram', 'sdxl', 'stable-diffusion']);
    expect(S.roots).toEqual([]);
    expect(S.utilityModels).toEqual([]);
    expect(S.codingAgents).toEqual(['build']);
  });

  test('a list that is present replaces, an absent one is kept, and entries are trimmed, deduplicated and capped in length', () => {
    const next = mergeSettings(S, { codingAgents: [' build ', 'build', 'Build', '', 'code'], utilityModels: ['a/b'] }, true);
    expect(next.ok && next.settings.codingAgents).toEqual(['build', 'code']);
    expect(next.ok && next.settings.localProviders).toEqual(S.localProviders);
    expect(mergeSettings(S, { codingAgents: ['x'.repeat(201)] }, true).ok).toBe(false);
  });

  test('roots must be absolute, keep their case and lose a trailing slash', () => {
    const ok = mergeSettings(S, { roots: ['/Work/Customers/', 'C:\\Work\\'] }, true);
    expect(ok.ok && ok.settings.roots).toEqual(['/Work/Customers', 'C:\\Work']);
    const bad = mergeSettings(S, { roots: ['customers'] }, true);
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('not an absolute path') });
  });

  test('a request with a bad shape is refused with a reason; a stored file with one falls back', () => {
    expect(mergeSettings(S, { roots: 'x' }, true)).toEqual({ ok: false, error: expect.stringContaining('must be a list') });
    expect(mergeSettings(S, { imagePatterns: [3] }, true)).toEqual({ ok: false, error: expect.stringContaining('only hold text') });
    expect(mergeSettings(S, 'x', true).ok).toBe(false);
    expect(mergeSettings(S, { roots: 'x', codingAgents: ['a'] }, false)).toEqual({ ok: true, settings: { ...S, codingAgents: ['a'] } });
  });

  test('reset restores the rules and keeps the user\u2019s roots and merged folders', () => {
    const edited = { ...S, roots: ['/r'], collapsed: ['x'], localProviders: ['q'], codingAgents: ['z'], utilityModels: ['u'], imagePatterns: [] };
    expect(resetRules(edited)).toEqual({ ...S, roots: ['/r'], collapsed: ['x'] });
  });
});

describe('no trace of any one machine in what ships', () => {
  const root = join(import.meta.dir, '..');
  // Built from parts so that this file does not contain what it looks for.
  const banned = [['srv', 'vault'].join('/'), ['Clients', ''].join('/'), ['Direct', 'Launch'].join(' '), ['Grif', 'fin'].join('')];

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(path));
      else out.push(path);
    }
    return out;
  };

  test('no file in the package, built bundles included, names the vault, a client or the agency', async () => {
    const files = await walk(root);
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of files) {
      if (!/\.(ts|js|json|md|html|yml|yaml)$|LICENSE$|\.gitignore$/.test(file)) continue;
      const text = await readFile(file, 'utf8');
      for (const word of banned) if (text.includes(word)) hits.push(`${file.slice(root.length + 1)}: ${word}`);
    }
    expect(hits).toEqual([]);
  });

  test('the service source has no absolute path in it at all', async () => {
    for (const file of ['attribution.ts', 'ledger.ts', 'spend.ts', 'store.ts', 'app.ts', 'main.ts']) {
      const text = await readFile(join(root, 'service', file), 'utf8');
      expect(text.match(/['"`]\/(srv|home|Users|opt|mnt)\//g)).toBeNull();
    }
  });
});
