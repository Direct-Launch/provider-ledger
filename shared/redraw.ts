// Pure helpers behind the panel's redraw: when nothing drawn has changed, and where the scroll goes afterwards.
import { ago, agoLong, resetIn } from './format.ts';
import type { PanelPayload } from './types.ts';

/**
 * A string that changes exactly when something the panel would draw changes: the whole payload, except
 * `now`, plus the relative-time texts that `now` produces ("synced 3 min ago", "resets in 2h"), so an idle
 * poll with the same data and the same wording draws nothing, and an "ago" label still advances.
 */
export const drawnSignature = (data: PanelPayload | null, loadError: string | null): string => {
  if (!data) return JSON.stringify({ loadError });
  const { now, ...rest } = data;
  const relative = [
    new Date(now).getUTCFullYear(),
    ago(data.syncedAt, now),
    agoLong(data.balancesFetchedAt, now),
    ago(data.ollamaUsage?.fetchedAt, now),
    ...data.balances.flatMap((card) => card.windows.map((w) => resetIn(w.resetAt, now))),
  ];
  return JSON.stringify({ loadError, relative, rest });
};

/** `wanted` kept inside what the new page can scroll: 0 to its height minus the viewport. */
export const clampScroll = (wanted: number, scrollHeight: number, clientHeight: number): number => (
  Math.min(Math.max(0, wanted), Math.max(0, scrollHeight - clientHeight))
);
