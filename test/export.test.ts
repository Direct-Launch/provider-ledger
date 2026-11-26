import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CSV_HEADER, buildCsv, exportCsv } from '../service/export.ts';
import { emptyStore } from '../service/ledger.ts';
import { ROOT, msg, scratch, storeOf } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

const store = () => storeOf([
  { id: 'a', directory: `${ROOT}/Acme & Co`, messages: [
    msg(Date.UTC(2026, 10, 26, 1), 'anthropic', 'claude-sonnet-5-5', 1.25, { output: 200 }),
    msg(Date.UTC(2026, 10, 26, 2), 'anthropic', 'claude-sonnet-5-5', 0.75, { output: 100 }),
    msg(Date.UTC(2026, 10, 25, 2), 'ollama', 'qwen3:480b', 0.000001),
  ] },
  { id: 'b', directory: `${ROOT}/Beta, Ltd "B"`, messages: [msg(Date.UTC(2026, 10, 26, 3), 'anthropic', 'claude-sonnet-5-5', 2)] },
  { id: 'c', directory: null, messages: [msg(Date.UTC(2026, 10, 24, 3), 'opencode-go', 'glm-5', 0)] },
], { roots: [ROOT] });

describe('buildCsv', () => {
  test('the header is exactly the agreed columns', () => {
    expect(CSV_HEADER).toBe('date,provider,model,project,category,scope,replies,tokens_input,tokens_output,tokens_reasoning,cache_read,cache_write,usd');
    expect(buildCsv(emptyStore())).toEqual({ csv: `${CSV_HEADER}\n`, rows: 0 });
  });

  test('one row per day, provider, model, project, category and scope, sorted, with thirteen fields', () => {
    const { csv, rows } = buildCsv(store());
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(rows).toBe(4);
    expect(lines).toHaveLength(5);
    expect(lines.slice(1)).toEqual([
      '2026-11-24,opencode-go,glm-5,Unattributed,uncategorised,cloud,1,1000,100,0,0,0,0',
      '2026-11-25,ollama,qwen3:480b,Acme & Co,uncategorised,local,1,1000,100,0,0,0,0.000001',
      '2026-11-26,anthropic,claude-sonnet-5-5,Acme & Co,uncategorised,cloud,2,2000,300,0,0,0,2',
      '2026-11-26,anthropic,claude-sonnet-5-5,"Beta, Ltd ""B""",uncategorised,cloud,1,1000,100,0,0,0,2',
    ]);
  });

  test('a field that starts like a formula is kept as text', () => {
    const s = storeOf([{ id: 'x', directory: '/tmp/=SUM(A1)', messages: [msg(NOW - 1000, 'p', 'm', 1)] }]);
    expect(buildCsv(s).csv.split('\n')[1]).toContain(",'=SUM(A1),");
  });

  test('the csv total equals the ledger total', () => {
    const { csv } = buildCsv(store());
    const total = csv.trimEnd().split('\n').slice(1).reduce((a, l) => a + Number(l.split(',').pop()), 0);
    expect(total).toBeCloseTo(1.25 + 0.75 + 0.000001 + 2, 6);
  });
});

describe('exportCsv', () => {
  test('writes to ~/Downloads when it exists and answers the absolute path', async () => {
    const home = await scratch();
    await mkdir(join(home, 'Downloads'));
    const result = await exportCsv(store(), NOW, home);
    expect(result).toEqual({ ok: true, path: join(home, 'Downloads', 'provider-ledger-2026-11-26.csv'), rows: 4, fellBack: false });
    if (!result.ok) throw new Error('unreachable');
    expect(result.path.startsWith('/')).toBe(true);
    const text = await readFile(result.path, 'utf8');
    expect(text.split('\n')[0]).toBe(CSV_HEADER);
    expect(text.trimEnd().split('\n')).toHaveLength(5);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(home, 'Downloads'))).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('falls back to the home directory when there is no Downloads, and says so', async () => {
    const home = await scratch();
    const result = await exportCsv(store(), NOW, home);
    expect(result).toMatchObject({ ok: true, path: join(home, 'provider-ledger-2026-11-26.csv'), fellBack: true });
    // A file called Downloads is not a folder.
    const home2 = await scratch();
    await writeFile(join(home2, 'Downloads'), 'x');
    expect(await exportCsv(store(), NOW, home2)).toMatchObject({ ok: true, fellBack: true, path: join(home2, 'provider-ledger-2026-11-26.csv') });
  });

  test('a second export the same day replaces the file', async () => {
    const home = await scratch();
    await exportCsv(store(), NOW, home);
    await exportCsv(emptyStore(), NOW, home);
    expect(await readFile(join(home, 'provider-ledger-2026-11-26.csv'), 'utf8')).toBe(`${CSV_HEADER}\n`);
  });

  test('a write failure answers ok:false with the reason, and does not throw', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'file'), 'x');
    const result = await exportCsv(store(), NOW, join(dir, 'file', 'home')); // a path under a regular file
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Could not write');
      expect(result.error).toContain('provider-ledger-2026-11-26.csv');
    }
  });
});
