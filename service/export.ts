// CSV export of the ledger: one row per day, provider, model, project, category and scope.
import { constants } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ExportResult, Store } from '../shared/types.ts';
import { dateKey, mergeSessions, parseBucketKey } from './ledger.ts';
import { categoryOf, scopeOf } from './spend.ts';

export const CSV_HEADER = 'date,provider,model,project,category,scope,replies,tokens_input,tokens_output,tokens_reasoning,cache_read,cache_write,usd';

/** A field that starts like a formula is read as one by a spreadsheet; a leading `'` keeps it text. */
const field = (value: string): string => {
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Dollars as a plain decimal: up to six places, no exponent, no trailing zeros. */
const usd = (cost: number): string => {
  const rounded = Math.round(cost * 1e6) / 1e6;
  return rounded.toFixed(6).replace(/\.?0+$/, '') || '0';
};

/**
 * The whole ledger as CSV text (rows sorted by date, provider, model, project, category, scope) and
 * its row count. Buckets that differ only by agent but land in the same category are one row.
 */
export const buildCsv = (store: Store): { csv: string; rows: number } => {
  type Row = { date: string; provider: string; model: string; project: string; category: string; scope: string; replies: number; input: number; output: number; reasoning: number; read: number; write: number; cost: number };
  const byRow = new Map<string, Row>();
  for (const [key, bucket] of mergeSessions(store)) {
    const parsed = parseBucketKey(key);
    if (!parsed) continue;
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
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...byRow.values()].sort((a, b) => (
    order(a.date, b.date) || order(a.provider, b.provider) || order(a.model, b.model)
    || order(a.project, b.project) || order(a.category, b.category) || order(a.scope, b.scope)
  ));
  const lines = rows.map((r) => [
    field(r.date), field(r.provider), field(r.model), field(r.project), field(r.category), field(r.scope),
    String(r.replies), String(r.input), String(r.output), String(r.reasoning), String(r.read), String(r.write), usd(r.cost),
  ].join(','));
  return { csv: `${[CSV_HEADER, ...lines].join('\n')}\n`, rows: rows.length };
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Write `provider-ledger-<YYYY-MM-DD>.csv` (the UTC date, like every date in the ledger) to
 * `~/Downloads`, or to the home directory when there is no such folder, and answer the absolute
 * path. A failure answers `{ ok: false, error }` with the reason; nothing throws.
 */
export const exportCsv = async (store: Store, now: number, home: string = homedir()): Promise<ExportResult> => {
  const downloads = join(home, 'Downloads');
  const fellBack = !(await isDirectory(downloads));
  const dir = fellBack ? home : downloads;
  const path = join(dir, `provider-ledger-${dateKey(now)}.csv`);
  const { csv, rows } = buildCsv(store);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, csv, { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    return { ok: true, path, rows, fellBack };
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    const reason = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, error: `Could not write ${path}: ${reason}`.slice(0, 400) };
  }
};
