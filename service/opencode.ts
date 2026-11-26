// Read-only client for the OpenCode connection the host hands the service
// (`OPENCHAMBER_OPENCODE_URL`, bearer = the service token), and the sync run.
import {
  MAX_SESSIONS_PER_RUN,
  applySession,
  applySkippedSession,
  pruneStore,
  reattributeSessions,
  selectSessions,
  toEpochMs,
} from './ledger.ts';
import type { SessionRef } from './ledger.ts';
import type { Store } from '../shared/types.ts';

export class UpstreamError extends Error {
  readonly status: number | null;
  /** A failure worth retrying later (network, timeout, 5xx), as against a refusal for good. */
  readonly transient: boolean;
  constructor(message: string, status: number | null, transient: boolean) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type OpenCodeReader = {
  listSessions(): Promise<SessionRef[]>;
  listMessages(sessionId: string): Promise<unknown[]>;
};

const REQUEST_TIMEOUT_MS = 20_000;
// OpenCode 2 pages `/api/session` (newest 50 first) and a session's messages;
// the page cap only stops a cursor loop, it is not a limit on history.
const MAX_PAGES = 400;

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** A cursor string, or the `next` of OpenCode 2's `{ previous, next }` cursor object. */
const cursorOf = (raw: unknown): string | null => {
  if (typeof raw === 'string' && raw !== '') return raw;
  if (isObject(raw) && typeof raw.next === 'string' && raw.next !== '') return raw.next;
  return null;
};

/**
 * An array, or the first array under a wrapper key, plus the next-page cursor
 * if there is one. OpenCode 2 answers `{ data: [...], cursor: { previous, next } }`;
 * older shapes carry a plain string `cursor`, `nextCursor` or `next`.
 */
export const unwrapList = (body: unknown): { items: unknown[]; cursor: string | null } => {
  if (Array.isArray(body)) return { items: body, cursor: null };
  if (!isObject(body)) return { items: [], cursor: null };
  const key = ['items', 'data', 'sessions', 'messages', 'results'].find((k) => Array.isArray(body[k]));
  const items = key ? (body[key] as unknown[]) : [];
  return { items, cursor: cursorOf(body.cursor) ?? cursorOf(body.nextCursor) ?? cursorOf(body.next) };
};

/**
 * Where the session ran. OpenCode 2 carries it as `location.directory`; earlier shapes and the
 * flat list carry `directory`. Null when the listing names none, which is how `Unattributed` arises.
 */
const directoryOf = (raw: Record<string, unknown>): string | null => {
  const direct = typeof raw.directory === 'string' && raw.directory.trim() !== '' ? raw.directory : null;
  if (direct) return direct;
  const location = isObject(raw.location) ? raw.location : null;
  return location && typeof location.directory === 'string' && location.directory.trim() !== '' ? location.directory : null;
};

/** The session's own agent: a string, or an object naming it. Null when the listing carries none. */
const agentOf = (raw: Record<string, unknown>): string | null => {
  const value = raw.agent;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (isObject(value)) {
    const id = typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : '';
    return id.trim() !== '' ? id.trim() : null;
  }
  return null;
};

export const sessionRefOf = (raw: unknown): SessionRef | null => {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
  if (!id) return null;
  const time = isObject(raw.time) ? raw.time : {};
  const updated = toEpochMs(time.updated ?? raw.updatedAt ?? raw.updated ?? time.created ?? raw.createdAt);
  if (updated === null) return null;
  return { id, updated, directory: directoryOf(raw), agent: agentOf(raw) };
};

export const createOpenCodeReader = (baseUrl: string, token: string, fetchFn: FetchFn = fetch): OpenCodeReader => {
  const base = baseUrl.replace(/\/+$/, '');

  const get = async (path: string, cursor: string | null): Promise<unknown> => {
    const url = cursor ? `${base}${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : `${base}${path}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError(`OpenCode read failed: ${error instanceof Error ? error.message : 'network error'}`, null, true);
    }
    if (!response.ok) {
      throw new UpstreamError(`OpenCode answered HTTP ${response.status} for ${path.split('?')[0]}`, response.status, response.status >= 500 || response.status === 429);
    }
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(`OpenCode answered an unreadable body for ${path.split('?')[0]}`, response.status, false);
    }
  };

  const collect = async (path: string): Promise<unknown[]> => {
    const all: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { items, cursor: next }: { items: unknown[]; cursor: string | null } = unwrapList(await get(path, cursor));
      all.push(...items);
      if (!next || next === cursor) break;
      cursor = next;
    }
    return all;
  };

  return {
    async listSessions() {
      const raw = await collect('/api/session');
      return raw.flatMap((item) => {
        const ref = sessionRefOf(item);
        return ref ? [ref] : [];
      });
    },
    listMessages(sessionId) {
      return collect(`/api/session/${encodeURIComponent(sessionId)}/message`);
    },
  };
};

export type SyncOutcome = { processed: number; pending: number; error: string | null; listed: boolean };

/**
 * One bounded sync run. Reads the session list, then the messages of at most
 * `maxSessions` sessions that are unseen or changed, oldest first. A refusal for
 * good (4xx, a 404 included) skips that session until it changes; a transient
 * failure (network, 5xx, 429) ends the run with the rest pending, so the next
 * trigger retries.
 */
export const syncOnce = async (
  store: Store,
  reader: OpenCodeReader,
  options: { now: number; maxSessions?: number },
): Promise<SyncOutcome> => {
  let refs: SessionRef[];
  try {
    refs = await reader.listSessions();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenCode session list failed';
    store.lastError = message;
    return { processed: 0, pending: store.pending, error: message, listed: false };
  }

  // A session whose folder moved is re-attributed from the list alone: no extra request.
  reattributeSessions(store, refs);

  const { selected, pending } = selectSessions(refs, store.sessions, {
    max: options.maxSessions ?? MAX_SESSIONS_PER_RUN,
  });
  let processed = 0;
  let error: string | null = null;
  let left = pending;
  for (const [index, ref] of selected.entries()) {
    try {
      applySession(store, ref, await reader.listMessages(ref.id));
      processed += 1;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'OpenCode message read failed';
      if (caught instanceof UpstreamError && !caught.transient) {
        applySkippedSession(store, ref, message);
        continue;
      }
      error = message;
      left += selected.length - index;
      break;
    }
  }
  pruneStore(store, options.now);
  store.syncedAt = options.now;
  store.pending = left;
  store.lastError = error;
  // The history is whole again once a clean run leaves nothing to read.
  if (store.rebuilding && error === null && left === 0) delete store.rebuilding;
  return { processed, pending: left, error, listed: true };
};
