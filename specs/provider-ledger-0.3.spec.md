# Provider Ledger 0.3 — specification

Status: agreed with the maintainer 2026-11-26 (feature workshop, five features selected).
Base: 0.2.0 (spend ledger, balances, six periods). All five arrive in two releases.

## 1. Overview and user value

The extension answers "what is left, what has it cost, how fast is it". It cannot yet
answer "who paid for it" or "am I about to overspend". 0.3 adds the business layer:
spend split by client and project, a monthly cap per provider that announces itself,
a CSV for the books, and an agent tool so the number can be asked for mid-session.

**Phasing.** 0.3.0 = per-client attribution, budgets and their alerts, the agent tool,
CSV export. 0.4.0 = live throughput (needs a held connection; ships separately so the
first release does not keep a process alive for it).

## 2. Functional requirements (EARS)

### Per-client attribution
- **R-1** The service shall record, for every ledger bucket, the **project key** of the
  session it came from, derived from `session.directory` — the first two path segments
  under the vault root (`Customers/Acme` → `Acme`), the folder's own name
  for a directory outside the vault, and `Unattributed` when the session carries no
  directory.
- **R-2** The panel shall offer a **By client** view listing each project key with spend,
  replies and tokens for the selected period, ranked by spend, with its share of the
  period's total.
- **R-3** Where a session's directory changes, the next sync shall re-attribute its
  buckets; no stored figure may keep a stale project key after a re-sync.
- **R-4** The By client view shall say how much of the period's spend is `Unattributed`
  rather than hiding it.

### Budgets
- **R-5** The user shall be able to set a **monthly cap** per provider, in the provider's
  currency (USD), from the panel; the cap is stored in the ledger store and survives a
  service restart.
- **R-6** The service shall compute this month's spend per provider against its cap and
  report the share used.
- **R-7** A provider at 80 % of its cap shall show as a `warning` row in Work Status; at
  100 % or above, an `error` row. A provider with no cap shall show no such row.
- **R-8** The rail icon shall carry a badge counting providers at or over 100 % of cap.
- **R-9** The panel shall show each capped provider's cap, spend, remaining and a bar.

### Agent tool
- **R-10** The extension shall contribute an OpenCode plugin tool named
  `provider_ledger` that answers `{ period, provider? }` with spend for the period, the
  top three providers by spend, and each provider's balance windows and budget state.
- **R-11** The tool shall read the ledger store read-only and shall never write it.

### CSV export
- **R-12** The panel shall offer **Export CSV**, which writes
  `~/Downloads/provider-ledger-<YYYY-MM-DD>.csv` with one row per day, provider, model
  and project, and confirms the path with a toast.
- **R-13** Where `~/Downloads` is absent, the file shall go to the home directory and the
  toast shall say where.

## 3. Non-functional requirements

- **N-1** The status section's answer shall stay under 200 ms with 3 000 sessions stored.
- **N-2** No route shall return a 500 for a provider failure; failures render as a row or
  a note.
- **N-3** The store shall stay atomic (tmp + rename, 0600) and capped at 16 MB.
- **N-4** Attribution shall add no network request: it comes from the session list the
  sync already reads.
- **N-5** The panel shall remain usable at 360 px wide.

## 4. Acceptance criteria

1. Given a store with sessions from `Customers/Acme` and an internal folder, when
   the panel opens on 30 days, then the By client view lists both with spend summing to
   the period's total, and any remainder is shown as `Unattributed`.
2. Given a cap of $10 and $8.90 spent this month, when Work Status renders, then the
   provider appears as a `warning` row naming the cap and the share used.
3. Given $10.02 spent against a $10 cap, then an `error` row and a rail badge of 1.
4. Given a session whose directory changes, when the next sync completes, then its
   spend moves to the new project key and the old key's total drops by exactly that
   amount.
5. Given `provider_ledger({period:"today"})` in an agent turn, then the tool returns
   today's spend and the top providers, and the store's mtime is unchanged.
6. Given Export CSV pressed, then a file exists at the stated path with a header row and
   one row per day/provider/model/project, and a toast names it.
7. Given a provider whose balance read failed, then its budget row still shows spend and
   cap, and its balance reads `—`.

## 5. Error handling

| Condition | Behaviour |
|---|---|
| Session list has no `directory` | buckets key `Unattributed`, R-4 line shows the share |
| Store missing a project key (pre-0.3 data) | re-synced on the next run; until then `Unattributed` |
| Cap set to 0 or negative | refused with a message; the stored cap is unchanged |
| Cap set in a currency other than USD | refused: the ledger stores USD only |
| `~/Downloads` missing | write to home, say so in the toast |
| CSV write fails (permissions) | toast `error` naming the path and the reason |
| Plugin tool called with an unknown period | answer the six known periods as a list; no exception |

## 6. Implementation checklist (0.3.0)

- [ ] `service/ledger.ts`: project key derivation, bucket key gains the project, re-attribution on re-sync
- [ ] `service/opencode.ts`: read `directory`/`projectID` from the session list; migrate old store entries
- [ ] `service/budgets.ts`: caps in the store, month-to-date per provider, state thresholds
- [ ] `service/app.ts`: `POST /budgets`, `GET /export.csv`, budget data in `/panel` and `/status`
- [ ] `panel/main.ts`: By client view, budget rows and the cap editor, Export button (background action), badge via `setBadge`
- [ ] `plugin/index.js`: `provider_ledger` tool (read-only)
- [ ] `package.json`: `opencodePlugin`, `background` entry + `actions` for the export, version 0.3.0
- [ ] tests: attribution, re-attribution, thresholds at 79/80/100 %, CSV row shape, tool answer shape
- [ ] `bun x openchamber-guest-check ./`, renders at 360/480/720 px
