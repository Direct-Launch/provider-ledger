// Covers the pure half of the panel redraw: when a poll may skip drawing, and where the scroll lands.
// The panel itself (panel/main.ts) needs a DOM and this repo has none in `bun test`; the swap that keeps
// the scroll position was exercised in headless Chrome against the built panel (scratch scripts, not kept here).
import { describe, expect, test } from 'bun:test';

import { clampScroll, drawnSignature } from '../shared/redraw.ts';
import type { PanelPayload } from '../shared/types.ts';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const MIN = 60_000;

const payload = (over: Record<string, unknown> = {}, now = NOW): PanelPayload => ({
  now,
  syncedAt: NOW - 10 * MIN,
  balancesFetchedAt: NOW - 5 * MIN,
  ollamaUsage: null,
  syncing: true,
  pending: 12,
  balances: [{ account: 'a', name: 'A', windows: [{ name: 'w', title: 'W', used: 10, detail: '', resetAt: NOW + 150 * MIN }] }],
  periods: { d7: { totals: { cost: 1 } } },
  ...over,
}) as unknown as PanelPayload;

describe('drawnSignature', () => {
  test('the same data a few seconds later draws the same thing', () => {
    expect(drawnSignature(payload(), null)).toBe(drawnSignature(payload({}, NOW + 4_000), null));
    expect(drawnSignature(payload(), null)).toBe(drawnSignature(payload({}, NOW + 10_000), null));
  });

  test('a count that is drawn changes it', () => {
    expect(drawnSignature(payload({ pending: 11 }), null)).not.toBe(drawnSignature(payload(), null));
    expect(drawnSignature(payload({ syncing: false }), null)).not.toBe(drawnSignature(payload(), null));
  });

  test('an "ago" or "resets in" label that would read differently changes it', () => {
    expect(drawnSignature(payload({}, NOW + MIN), null)).not.toBe(drawnSignature(payload(), null));
  });

  test('a load error changes it, and no payload is its own state', () => {
    expect(drawnSignature(payload(), 'The service answered HTTP 500.')).not.toBe(drawnSignature(payload(), null));
    expect(drawnSignature(null, 'x')).not.toBe(drawnSignature(null, null));
  });
});

describe('clampScroll', () => {
  test('keeps a position that still fits', () => expect(clampScroll(700, 2166, 800)).toBe(700));
  test('a shorter page stops at its own bottom', () => expect(clampScroll(1362, 1591, 800)).toBe(791));
  test('a page that fits the viewport goes to the top', () => expect(clampScroll(700, 700, 800)).toBe(0));
  test('a taller page does not move it', () => expect(clampScroll(1362, 2716, 800)).toBe(1362));
  test('never negative', () => expect(clampScroll(-5, 2000, 800)).toBe(0));
});
