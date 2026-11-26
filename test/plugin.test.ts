import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The plugin is plain JavaScript with no build step and no declaration file, by design.
// @ts-ignore TS7016
import plugin from '../plugin/index.js';
import { budgetState } from '../service/budgets.ts';
import { saveStore } from '../service/store.ts';
import type { Store } from '../shared/types.ts';
import { msg, scratch, storeOf } from './helpers.ts';

type Tool = { name: string; description: string; input: any; execute: (input: unknown, context?: unknown) => Promise<{ content: string }> };

const registered = async (): Promise<Tool> => {
  let tool: Tool | null = null;
  await plugin.setup({ tool: { transform: async (callback: (tools: { add: (t: Tool) => void }) => void) => { callback({ add: (t) => { tool = t; } }); } } });
  if (!tool) throw new Error('no tool registered');
  return tool;
};

const hoursAgo = (h: number): number => Date.now() - h * 3_600_000;
const savedEnv = process.env.PROVIDER_LEDGER_STORE;
let path = '';

const writeStore = async (store: Store): Promise<void> => {
  await saveStore(path, store, Date.now());
};

beforeEach(async () => {
  path = join(await scratch('provider-ledger-plugin-'), 'store.json');
  process.env.PROVIDER_LEDGER_STORE = path;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PROVIDER_LEDGER_STORE;
  else process.env.PROVIDER_LEDGER_STORE = savedEnv;
});

const fixture = (): Store => {
  const store = storeOf([
    { id: 'a', directory: null, messages: [
      msg(Date.now() - 2000, 'anthropic', 'sonnet', 8.9),
      msg(Date.now() - 3000, 'ollama', 'qwen', 5),
      msg(Date.now() - 4000, 'console-ollama-cloud', 'q', 0.15),
      msg(Date.now() - 5000, 'deepseek', 'chat', 0.5),
      msg(Date.now() - 6000, 'opencode-go', 'glm', 0),
    ] },
  ]);
  store.budgets = { anthropic: 10 };
  store.balances.anthropic = { provider: 'anthropic', fetchedAt: Date.now(), ok: false, configured: true, error: 'no key', windows: {} };
  store.balances.ollama = { provider: 'ollama', fetchedAt: Date.now(), ok: true, configured: true, windows: { weekly: { usedPercent: 42, windowSeconds: null, resetAt: Date.now() + 3 * 3_600_000 } } };
  store.balances['opencode-go'] = { provider: 'opencode-go', fetchedAt: Date.now(), ok: true, configured: true, windows: { monthly: { usedPercent: 10, windowSeconds: null } } };
  return store;
};

describe('the tool', () => {
  test('is a provider_ledger tool with a JSON-Schema input and no output field', async () => {
    expect(plugin.id).toBe('provider-ledger');
    const tool = await registered();
    expect(tool.name).toBe('provider_ledger');
    expect(tool.input.type).toBe('object');
    expect(tool.input.properties.period.enum).toEqual(['today', 'd7', 'd30', 'month', 'lastMonth', 'all']);
    expect(Object.keys(tool.input.properties).sort()).toEqual(['period', 'provider']);
    const answer = await tool.execute({ period: 'today' });
    expect(Object.keys(answer)).toEqual(['content']); // OpenCode rejects `output` without an output schema
  });

  test('today: the period spend, and only the top three providers', async () => {
    await writeStore(fixture());
    const { content } = await (await registered()).execute({ period: 'today' });
    expect(content).toContain('Today');
    expect(content).toContain('$14.55 spend');
    expect(content).toContain('5 replies');
    const top = content.split('\n').find((l) => l.startsWith('Top providers:')) ?? '';
    expect(top).toBe('Top providers: 1. Anthropic $8.90 (61%); 2. Ollama $5.00 (34%); 3. DeepSeek $0.50 (3%).');
    expect(top).not.toContain('Go');
  });

  test('every provider with a cap or a balance gets its windows and budget state', async () => {
    await writeStore(fixture());
    const { content } = await (await registered()).execute({ period: 'month' });
    expect(content).toContain('Anthropic (anthropic): Budget: $8.90 of $10.00 monthly cap this month (89%, warning), $1.10 left. Balance: could not be read (no key).');
    expect(content).toContain('Ollama (ollama): Budget: no monthly cap set. Balance: weekly 42% used, resets in 3h.');
    expect(content).toContain('OpenCode Go (opencode-go): Budget: no monthly cap set. Balance: monthly 10% used.');
    expect(content).not.toContain('DeepSeek (deepseek)'); // no cap, no balance: not worth a line
  });

  test('a named provider answers for it alone; ollama is one account under three ids', async () => {
    await writeStore(fixture());
    const tool = await registered();
    const one = (await tool.execute({ period: 'd7', provider: 'Anthropic' })).content;
    expect(one).toContain('Anthropic (anthropic): Budget:');
    expect(one).not.toContain('Ollama (ollama)');
    const ollama = (await tool.execute({ period: 'd7', provider: 'ollama' })).content;
    expect(ollama).toContain('Ollama (ollama)');
    expect(ollama).toContain('Ollama Cloud (Console) (console-ollama-cloud)');
    const none = (await tool.execute({ period: 'd7', provider: 'nope' })).content;
    expect(none).toContain('No provider matching "nope"');
    expect(none).toContain('anthropic');
  });

  test('the budget words follow the service thresholds at 79.9 / 80 / 99.9 / 100 %', async () => {
    const tool = await registered();
    for (const [spent, word] of [[7.99, 'within the cap'], [8, 'warning'], [9.99, 'warning'], [10, 'over the cap']] as const) {
      const store = storeOf([{ id: 'a', directory: null, messages: [msg(Date.now() - 1000, 'anthropic', 's', spent)] }]);
      store.budgets = { anthropic: 10 };
      await writeStore(store);
      const { content } = await tool.execute({ period: 'month', provider: 'anthropic' });
      expect(content).toContain(`, ${word})`);
      expect(budgetState(spent, 10)).toBe(word === 'within the cap' ? 'ok' : word === 'warning' ? 'warning' : 'error');
    }
  });

  test('an unknown period answers the six known ones, no exception', async () => {
    await writeStore(fixture());
    const { content } = await (await registered()).execute({ period: 'fortnight' });
    expect(content).toBe('Unknown period "fortnight". The periods are: today, d7, d30, month, lastMonth, all.');
  });

  test('no period means this month; "all" and "lastMonth" work', async () => {
    await writeStore(fixture());
    const tool = await registered();
    expect((await tool.execute({})).content).toContain('This month');
    expect((await tool.execute(undefined)).content).toContain('This month');
    expect((await tool.execute({ period: 'all' })).content).toContain('All time');
    expect((await tool.execute({ period: 'lastMonth' })).content).toContain('No replies in this period.');
  });

  test('a plan-included provider reads "included in plan", not $0.00', async () => {
    const store = storeOf([{ id: 'a', directory: null, messages: [msg(Date.now() - 1000, 'opencode-go', 'glm', 0)] }]);
    store.balances['opencode-go'] = { provider: 'opencode-go', fetchedAt: Date.now(), ok: true, configured: true, windows: { weekly: { usedPercent: 5, windowSeconds: null } } };
    await writeStore(store);
    const { content } = await (await registered()).execute({ period: 'today' });
    expect(content).toContain('included in plan spend');
    expect(content).toContain('1. OpenCode Go included in plan');
  });

  test('says when history is still being re-read', async () => {
    const store = fixture();
    store.rebuilding = true;
    await writeStore(store);
    expect((await (await registered()).execute({ period: 'today' })).content).toContain('being re-read');
  });
});

describe('the tool never throws and never writes', () => {
  test('a missing store is a sentence', async () => {
    const { content } = await (await registered()).execute({ period: 'today' });
    expect(content).toContain('no data yet');
  });

  test('a corrupt store, a store that is a directory, and a store that is the wrong shape are sentences', async () => {
    const tool = await registered();
    await writeFile(path, '{not json');
    expect((await tool.execute({ period: 'today' })).content).toContain('could not read its store');
    await writeFile(path, '[1,2]');
    expect((await tool.execute({ period: 'today' })).content).toContain('not a ledger');
    const dir = join(await scratch(), 'dir');
    await mkdir(dir);
    process.env.PROVIDER_LEDGER_STORE = dir;
    expect((await tool.execute({ period: 'today' })).content).toContain('could not read its store');
  });

  test('hostile arguments are tolerated', async () => {
    await writeStore(fixture());
    const tool = await registered();
    for (const input of [null, 5, 'x', [], { period: 5 }, { period: {} }, { provider: 7 }, { period: 'today', provider: {} }]) {
      const { content } = await tool.execute(input);
      expect(typeof content).toBe('string');
    }
  });

  test('the store file is byte for byte unchanged, mtime included', async () => {
    await writeStore(fixture());
    const before = { bytes: await readFile(path, 'utf8'), mtime: (await stat(path)).mtimeMs };
    const tool = await registered();
    for (const period of ['today', 'd7', 'd30', 'month', 'lastMonth', 'all', 'bogus']) await tool.execute({ period, provider: 'anthropic' });
    expect(await readFile(path, 'utf8')).toBe(before.bytes);
    expect((await stat(path)).mtimeMs).toBe(before.mtime);
  });

  test('the plugin imports nothing from the extension and has no static imports', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'plugin', 'index.js'), 'utf8');
    expect(/^\s*import\s/m.test(source)).toBe(false);
    expect(source).not.toContain('shared/');
    expect(source).not.toMatch(/writeFile|appendFile|unlink|rename|\brm\(|mkdir|createWriteStream/);
  });
});
