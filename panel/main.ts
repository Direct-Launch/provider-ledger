// Provider Ledger panel. Sandboxed frame: everything comes from the service
// through `host.serviceRequest`, nothing leaves the machine.
import { HostRequestError, connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountSpinner,
  mountTabs,
} from '@openchamber/sdk/ui';
import type { Handle } from '@openchamber/sdk/ui';

import { DASH, ago, agoLong, compact, money, monthName, parseCap, percent, pricePerMillion, providerName, resetIn, shareText, shortDate, tokensPerSecond } from '../shared/format.ts';
import { CATEGORY_HINTS, CATEGORY_LABELS, PERIOD_IDS, PERIOD_LABELS } from '../shared/types.ts';
import type { BalanceCard, BudgetResult, BudgetRow, ExportResult, LedgerSettings, MonthRow, PanelPayload, PeriodId, PeriodProject, PeriodView, SettingsResult, SurfaceRow, SyncResult, TypeCategoryRow } from '../shared/types.ts';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Provider Ledger: #root is missing');

const REFRESH_MS = 30_000;
const BUSY_REFRESH_MS = 4_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Join the last two words with a no-break space, so a wrapped line never ends on one word alone. */
const tidy = (text: string): string => {
  const i = text.lastIndexOf(' ');
  return i > 0 && text.indexOf(' ') !== i ? `${text.slice(0, i)}\u00A0${text.slice(i + 1)}` : text;
};

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = tidy(text);
  return node;
};

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// ---- Frame ----------------------------------------------------------------

const head = h('div', 'pl-head');
head.appendChild(h('h1', 'pl-title', 'Provider Ledger'));
const badgeSlot = h('div');
head.appendChild(badgeSlot);
const bannerSlot = h('div');
bannerSlot.style.display = 'flex';
bannerSlot.style.flexDirection = 'column';
bannerSlot.style.gap = '8px';
const stateSlot = h('div');
const bodySlot = h('div');
bodySlot.style.display = 'flex';
bodySlot.style.flexDirection = 'column';
bodySlot.style.gap = '14px';
const footSlot = h('div', 'pl-foot');
root.append(head, bannerSlot, stateSlot, bodySlot, footSlot);

let payload: PanelPayload | null = null;
let period: PeriodId = 'd7';
type View = 'spend' | 'clients' | 'types' | 'surfaces' | 'settings';
let activeView: View = 'spend';
/** The settings fields as typed, one entry per line, kept across refreshes until saved or reset; null means "as stored". */
let settingsDraft: Record<SettingsField, string> | null = null;
let refocusPeriod = false;
let refocusView = false;
/** A result worth keeping on screen until dismissed: an export, or a cap that was refused. */
let notice: { tone: 'success' | 'error'; title: string; body: string } | null = null;
let exporting = false;
/** A cap or settings field has focus: a refresh must not rebuild the page under the cursor. */
let editingCap = false;
let renderDeferred = false;
let loadError: string | null = null;
let loading = false;
let syncingNow = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let disposers: Array<() => void> = [];

const track = <T extends Handle<never>>(handle: T): T => {
  disposers.push(() => handle.dispose());
  return handle;
};
const clearDynamic = (): void => {
  for (const dispose of disposers) dispose();
  disposers = [];
  for (const slot of [bannerSlot, stateSlot, bodySlot, footSlot, badgeSlot]) slot.replaceChildren();
};

// ---- Data -----------------------------------------------------------------

const describe = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE') return 'The local service is not running. Allow it in Settings → Extensions, then reopen this panel.';
    if (error.code === 'SERVICE_FAILED') return 'The local service failed to start. Check Settings → Extensions.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Unknown error';
};

const load = async (): Promise<void> => {
  if (loading) return;
  loading = true;
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/panel' });
    if (result.status >= 400) throw new Error(`The service answered HTTP ${result.status}.`);
    payload = JSON.parse(result.body) as PanelPayload;
    loadError = null;
  } catch (error) {
    loadError = describe(error);
  } finally {
    loading = false;
    renderUnlessEditing();
    schedule();
  }
};

const schedule = (): void => {
  if (timer) clearTimeout(timer);
  const busy = payload ? payload.syncing || payload.pending > 0 : false;
  timer = setTimeout(() => { void load(); }, busy ? BUSY_REFRESH_MS : REFRESH_MS);
};

const syncNow = async (): Promise<void> => {
  if (syncingNow) return;
  syncingNow = true;
  render();
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/sync', body: '{}' });
    if (result.status >= 400) throw new Error(`The service answered HTTP ${result.status}.`);
    const sync = JSON.parse(result.body) as SyncResult;
    if (sync.error) loadError = `Sync: ${sync.error}`;
  } catch (error) {
    loadError = describe(error);
  } finally {
    syncingNow = false;
  }
  await load();
};

const renderUnlessEditing = (): void => {
  if (editingCap) {
    renderDeferred = true;
    return;
  }
  render();
};

const exportCsv = async (): Promise<void> => {
  if (exporting) return;
  exporting = true;
  render();
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/export', body: '{}' });
    if (result.status >= 400) throw new Error(`The service answered HTTP ${result.status}.`);
    const done = JSON.parse(result.body) as ExportResult;
    notice = done.ok
      ? {
        tone: 'success',
        title: `Exported ${done.rows} row${done.rows === 1 ? '' : 's'}`,
        body: `${done.path}${done.fellBack ? ' (there is no Downloads folder, so it went to the home directory)' : ''}. The file is on the machine that runs OpenChamber.`,
      }
      : { tone: 'error', title: 'Export failed', body: done.error };
  } catch (error) {
    notice = { tone: 'error', title: 'Export failed', body: describe(error) };
  } finally {
    exporting = false;
  }
  render();
};

const saveCap = async (row: BudgetRow, text: string): Promise<void> => {
  const parsed = parseCap(text);
  if (!parsed.ok) {
    notice = { tone: 'error', title: `${row.name} cap not saved`, body: parsed.error };
    return;
  }
  if (parsed.value === row.capUsd) return;
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/budgets', body: JSON.stringify({ provider: row.provider, capUsd: parsed.value }) });
    if (result.status >= 400) throw new Error(`The service answered HTTP ${result.status}.`);
    const saved = JSON.parse(result.body) as BudgetResult;
    notice = saved.ok ? null : { tone: 'error', title: `${row.name} cap not saved`, body: saved.error };
  } catch (error) {
    notice = { tone: 'error', title: `${row.name} cap not saved`, body: describe(error) };
  }
  await load();
};

type SettingsField = 'roots' | 'localProviders' | 'utilityModels' | 'codingAgents' | 'imagePatterns';
const SETTINGS_FIELDS: SettingsField[] = ['roots', 'localProviders', 'utilityModels', 'codingAgents', 'imagePatterns'];

const linesOf = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

/** Send settings (or a reset) and show what the service said; a refusal keeps what was typed. */
const postSettings = async (body: unknown, done: string, clearDraft = false): Promise<boolean> => {
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/settings', body: JSON.stringify(body) });
    if (result.status >= 400) throw new Error(`The service answered HTTP ${result.status}.`);
    const saved = JSON.parse(result.body) as SettingsResult;
    if (!saved.ok) {
      notice = { tone: 'error', title: 'Settings not saved', body: saved.error };
      render();
      return false;
    }
    notice = { tone: 'success', title: done, body: 'The ledger has been re-sorted with the new rules; nothing was read again.' };
    if (clearDraft) settingsDraft = null;
  } catch (error) {
    notice = { tone: 'error', title: 'Settings not saved', body: describe(error) };
    render();
    return false;
  }
  await load();
  return true;
};

const saveSettings = (): Promise<boolean> => {
  const draft = settingsDraft;
  if (!draft) return Promise.resolve(true);
  const settings: Partial<LedgerSettings> = {};
  for (const field of SETTINGS_FIELDS) settings[field] = linesOf(draft[field]);
  return postSettings({ settings }, 'Settings saved', true);
};

const setCollapsed = (project: string, merge: boolean): Promise<boolean> => {
  const current = payload?.settings.collapsed ?? [];
  const next = merge ? [...current.filter((p) => p !== project), project] : current.filter((p) => p !== project);
  return postSettings({ settings: { collapsed: next } }, merge ? `${project} merged into its parent` : `${project} restored`);
};

// ---- Pieces ---------------------------------------------------------------

const thisYear = (data: PanelPayload): number => new Date(data.now).getUTCFullYear();

const barClass = (used: number): string => `pl-bar${used >= 85 ? ' bad' : used >= 60 ? ' warn' : ''}`;

const balanceCard = (card: BalanceCard, now: number): HTMLElement => {
  const box = h('div', 'pl-bcard');
  const top = h('div', 'pl-bhead');
  top.appendChild(h('span', 'pl-bname', card.name));
  if (card.planLabel) top.appendChild(h('span', 'pl-plan', card.planLabel));
  box.appendChild(top);

  if (card.headline) {
    const line = h('div', 'pl-bmoney');
    line.appendChild(h('span', 'v', card.headline));
    if (card.headlineNote) line.appendChild(h('span', 's', card.headlineNote));
    box.appendChild(line);
  }
  for (const w of card.windows) {
    const row = h('div', 'pl-win');
    const label = h('div', 'pl-win-top');
    label.append(h('span', 'n', w.title), h('span', 'd', w.detail));
    const bar = h('span', barClass(w.used));
    const fill = h('i');
    fill.style.width = `${w.used}%`;
    bar.appendChild(fill);
    row.append(label, bar);
    const reset = resetIn(w.resetAt, now);
    if (reset) row.appendChild(h('div', 'pl-win-reset', reset));
    box.appendChild(row);
  }
  if (card.note) {
    box.appendChild(h('div', `pl-bnote${card.state === 'signin' || card.state === 'failed' ? ' bad' : ''}`, card.note));
    if (card.state === 'signin' && card.headlineNote) box.appendChild(h('div', 'pl-bnote', card.headlineNote));
  }
  return box;
};

const balanceBlock = (data: PanelPayload): HTMLElement => {
  const section = h('div', 'pl-section');
  const head2 = h('div', 'pl-subhead');
  head2.appendChild(h('h2', 'pl-h', 'Balance'));
  head2.appendChild(h('span', 'pl-cap', data.balancesFetchedAt === null
    ? 'not read yet'
    : `read ${agoLong(data.balancesFetchedAt, data.now)}`));
  section.appendChild(head2);
  if (data.balances.length === 0) {
    section.appendChild(h('p', 'pl-cap', data.balancesFetchedAt === null
      ? 'Balances are read when OpenChamber refreshes its Usage card.'
      : 'No provider has a balance to show.'));
    return section;
  }
  const grid = h('div', 'pl-balances');
  for (const card of data.balances) grid.appendChild(balanceCard(card, data.now));
  section.appendChild(grid);
  return section;
};

const capText = (cap: number | null): string => (cap === null ? '' : Number.isInteger(cap) ? String(cap) : cap.toFixed(2));

const budgetCard = (row: BudgetRow): HTMLElement => {
  const box = h('div', `pl-bcard pl-budget${row.state === 'error' ? ' over' : ''}`);
  const top = h('div', 'pl-bhead');
  top.appendChild(h('span', 'pl-bname', row.name));
  if (row.state === 'warning' || row.state === 'error') {
    top.appendChild(h('span', `pl-flag ${row.state}`, row.state === 'error' ? 'Over cap' : 'Near cap'));
  }
  box.appendChild(top);

  const field = h('label', 'pl-capfield');
  field.appendChild(h('span', 'pl-capfield-l', 'Monthly cap'));
  const wrap = h('span', 'pl-capwrap');
  wrap.appendChild(h('span', 'pl-capsign', '$'));
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pl-capinput';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.placeholder = 'No cap';
  input.value = capText(row.capUsd);
  input.setAttribute('aria-label', `Monthly cap for ${row.name}, in US dollars. Empty removes the cap.`);
  input.addEventListener('focus', () => { editingCap = true; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    else if (event.key === 'Escape') {
      input.value = capText(row.capUsd);
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    editingCap = false;
    const wasDeferred = renderDeferred;
    renderDeferred = false;
    void saveCap(row, input.value).finally(() => {
      if (wasDeferred || notice) render();
    });
  });
  wrap.appendChild(input);
  field.appendChild(wrap);
  box.appendChild(field);

  if (row.capUsd !== null && row.share !== null) {
    const used = Math.min(100, row.share);
    const bar = h('span', `pl-bar${row.state === 'error' ? ' bad' : row.state === 'warning' ? ' warn' : ''}`);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${percent(row.share)} of the cap used`);
    const fill = h('i');
    fill.style.width = `${used}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
  }
  const stats = h('div', 'pl-bstats');
  const stat = (k: string, v: string): void => {
    const item = h('span');
    item.append(h('span', 'k', k), h('span', 'v', v));
    stats.appendChild(item);
  };
  stat('Spent', money(row.spentUsd));
  if (row.capUsd !== null) {
    stat('Left', row.remainingUsd === null ? DASH : money(row.remainingUsd));
    stat('Used', row.share === null ? DASH : percent(row.share));
  }
  stat('Balance', row.balance ?? DASH);
  box.appendChild(stats);
  return box;
};

const budgetBlock = (data: PanelPayload): HTMLElement | null => {
  if (data.budgets.length === 0) return null;
  const section = h('div', 'pl-section');
  const head2 = h('div', 'pl-subhead');
  head2.appendChild(h('h2', 'pl-h', 'Monthly caps'));
  head2.appendChild(h('span', 'pl-cap', 'this UTC month · USD'));
  section.appendChild(head2);
  section.appendChild(h('p', 'pl-cap', data.rebuilding
    ? 'History is still being re-read, so spend may read low. Type a cap and press Enter; empty removes it.'
    : 'Type a cap and press Enter; empty removes it. 80% shows a warning, 100% a badge on the rail icon.'));
  const grid = h('div', 'pl-balances');
  for (const row of data.budgets) grid.appendChild(budgetCard(row));
  section.appendChild(grid);
  return section;
};

const replies = (count: number): string => `${compact(count)} ${count === 1 ? 'reply' : 'replies'}`;

const linkButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const button = h('button', 'pl-link', label);
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
};

const clientRow = (p: PeriodProject, index: number): HTMLElement => {
  const tr = h('tr', 'main');
  const first = h('td');
  const nameLine = h('div', 'pl-pname');
  nameLine.append(h('span', 'pl-rank', String(index + 1)), document.createTextNode(p.project));
  first.appendChild(nameLine);
  if (p.project === 'Unattributed') first.appendChild(h('div', 'pl-sub', 'no folder on the session'));
  if (p.merged > 0) first.appendChild(h('div', 'pl-sub', `includes ${p.merged} merged folder${p.merged === 1 ? '' : 's'}`));
  if (p.parent !== null) {
    const parent = p.parent;
    const line = h('div', 'pl-sub');
    line.appendChild(linkButton(`Merge into ${parent}`, `Count ${p.project} under ${parent}, the folder it sits in`, () => { void setCollapsed(p.project, true); }));
    first.appendChild(line);
  }
  if (p.share !== null) {
    const bar = h('span', 'pl-bar mini');
    const fill = h('i');
    fill.style.width = `${Math.min(100, Math.max(0, p.share))}%`;
    bar.appendChild(fill);
    first.appendChild(bar);
  }
  first.title = `${p.project}: ${p.messages} replies, ${compact(p.tokens)} tokens.`;
  tr.append(
    first,
    h('td', undefined, money(p.cost)),
    h('td', undefined, shareText(p.share)),
    h('td', undefined, compact(p.messages)),
    h('td', 'col-tokens', compact(p.tokens)),
  );
  return tr;
};

const clientsBlock = (view2: PeriodView, data: PanelPayload): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Clients · ${view2.label}`));
  if (view2.projects.length === 0) {
    section.appendChild(h('p', 'pl-cap', 'No replies in this period.'));
    return section;
  }
  section.appendChild(h('p', 'pl-cap', 'Each session is counted under the folder it ran in, ranked by spend. Share is of the period\u2019s spend.'));
  if (data.settings.roots.length === 0) {
    section.appendChild(h('p', 'pl-cap', 'To group folders under a parent (one folder per customer, say), add that parent as a workspace root in Settings.'));
  }
  const table = h('table', 'pl-table');
  const headRow = h('tr');
  headRow.append(
    headerCell('Client', 'The folder the session ran in, or the first folder below a workspace root'),
    headerCell('Spend\u00A0↓', `Spend in ${view2.label}, highest first`),
    headerCell('Share', 'Share of the period\u2019s total spend'),
    headerCell('Replies', 'Model replies in the period'),
    headerCell('Tokens', 'All tokens in the period: input, output, reasoning and cache', 'col-tokens'),
  );
  const thead = h('thead');
  thead.appendChild(headRow);
  const tbody = h('tbody');
  view2.projects.forEach((p, i) => tbody.appendChild(clientRow(p, i)));
  table.append(thead, tbody);
  const wrap = h('div', 'pl-scroll');
  wrap.appendChild(table);
  section.appendChild(wrap);

  const un = view2.unattributed;
  const line = h('p', `pl-cap pl-unattr${un.cost > 0 ? ' has' : ''}`, un.share === null
    ? `Unattributed: ${money(un.cost)} · ${replies(un.messages)}.`
    : `Unattributed: ${money(un.cost)} · ${shareText(un.share)} of this period\u2019s spend · ${replies(un.messages)}.`);
  section.appendChild(line);
  return section;
};

// ---- Types ----------------------------------------------------------------

const typeRow = (row: TypeCategoryRow): HTMLElement => {
  const tr = h('tr', 'main');
  const first = h('td');
  first.appendChild(h('div', 'pl-pname', CATEGORY_LABELS[row.category]));
  if (row.share !== null) {
    const bar = h('span', 'pl-bar mini flat');
    const fill = h('i');
    fill.style.width = `${Math.min(100, Math.max(0, row.share))}%`;
    bar.appendChild(fill);
    first.appendChild(bar);
  }
  first.title = `${CATEGORY_LABELS[row.category]}: ${CATEGORY_HINTS[row.category]}.`;
  tr.append(
    first,
    h('td', undefined, money(row.cost)),
    h('td', undefined, shareText(row.share)),
    h('td', undefined, compact(row.messages)),
    h('td', 'col-tokens', compact(row.tokens)),
  );
  return tr;
};

const typesBlock = (view3: PeriodView): HTMLElement => {
  const types = view3.types;
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Spend by type · ${view3.label}`));
  if (types.categories.length === 0) {
    section.appendChild(h('p', 'pl-cap', 'No replies in this period.'));
    return section;
  }
  section.appendChild(h('p', 'pl-cap', 'What each reply was for: the model decides image, embedding and utility; otherwise the agent that wrote it does.'));
  const table = h('table', 'pl-table');
  const headRow = h('tr');
  headRow.append(
    headerCell('Type', 'Hover a type for what it covers'),
    headerCell('Spend\u00A0↓', `Spend in ${view3.label}, highest first`),
    headerCell('Share', 'Share of the period\u2019s total spend'),
    headerCell('Replies', 'Model replies in the period'),
    headerCell('Tokens', 'All tokens in the period', 'col-tokens'),
  );
  const thead = h('thead');
  thead.appendChild(headRow);
  const tbody = h('tbody');
  for (const row of types.categories) tbody.appendChild(typeRow(row));
  table.append(thead, tbody);
  const wrap = h('div', 'pl-scroll');
  wrap.appendChild(table);
  section.appendChild(wrap);

  const un = types.uncategorised;
  if (un.messages > 0) {
    section.appendChild(h('p', 'pl-cap pl-unattr has', un.replyShare === null
      ? `Uncategorised: ${replies(un.messages)}.`
      : `Uncategorised: ${replies(un.messages)}, ${shareText(un.replyShare)} of the period\u2019s replies. The agent behind them could not be read, so they are not guessed.`));
  }
  const sub = view3.surfaces.subagents;
  if (sub.sessions > 0) {
    section.appendChild(h('p', 'pl-cap', `Subagent sessions: ${sub.share === null ? replies(sub.messages) : `${money(sub.cost)} · ${shareText(sub.share)} of the period\u2019s spend`}. Already counted in the rows above, not added to them.`));
  }
  return section;
};

const scopeBlock = (view3: PeriodView): HTMLElement => {
  const { cloud, local } = view3.types;
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Local and cloud · ${view3.label}`));
  const grid = h('div', 'pl-totals two');
  const cloudCard = h('div', 'pl-card');
  cloudCard.append(h('div', 'k', 'Cloud'), h('div', 'v', money(cloud.cost)), h('div', 's', `${compact(cloud.messages)} replies · ${compact(cloud.tokens)} tokens`));
  const localCard = h('div', 'pl-card');
  localCard.append(h('div', 'k', 'Local'), h('div', 'v', money(0)), h('div', 's', `${compact(local.messages)} replies · ${compact(local.tokens)} tokens`), h('div', 's', 'no per-token cost'));
  grid.append(cloudCard, localCard);
  section.appendChild(grid);
  return section;
};

const categoryProviders = (view3: PeriodView): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Providers by type · ${view3.label}`));
  for (const row of view3.types.categories) {
    const block = h('div', 'pl-section');
    block.appendChild(h('div', 'pl-subtitle', CATEGORY_LABELS[row.category]));
    const table = h('table', 'pl-table pl-fixed');
    const tbody = h('tbody');
    for (const p of row.providers) {
      const tr = h('tr', 'main');
      const first = h('td');
      const line = h('div', 'pl-pname');
      line.appendChild(document.createTextNode(p.name));
      if (p.scope === 'local') line.appendChild(h('span', 'pl-tag', 'local'));
      first.appendChild(line);
      tr.append(
        first,
        h('td', undefined, p.scope === 'local' ? money(0) : money(p.cost)),
        h('td', undefined, replies(p.messages)),
        h('td', 'col-tokens', compact(p.tokens)),
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const wrap = h('div', 'pl-scroll');
    wrap.appendChild(table);
    block.appendChild(wrap);
    section.appendChild(block);
  }
  return section;
};

// ---- Surfaces -------------------------------------------------------------

const GENERATED_HINT = 'Tokens written while calling it';
const CONTEXT_HINT = 'Characters it put into the conversation, re-read on later steps';
const NO_BILL = 'No provider bills per tool: these are the tokens written while calling a tool and the context it added.';

const chars = (n: number): string => `${n.toLocaleString('en-US')} characters`;

const surfaceTable = (rows: SurfaceRow[], nameLabel: string, callsLabel: string): HTMLElement => {
  const table = h('table', 'pl-table pl-surface');
  const headRow = h('tr');
  headRow.append(
    headerCell(nameLabel, `${nameLabel}, most context added first`),
    headerCell(callsLabel, `${callsLabel} in the period`),
    headerCell('Generated', GENERATED_HINT),
    headerCell('Context added', CONTEXT_HINT),
  );
  const thead = h('thead');
  thead.appendChild(headRow);
  const tbody = h('tbody');
  rows.forEach((row, index) => {
    const tr = h('tr', 'main');
    const first = h('td');
    const line = h('div', 'pl-pname');
    line.append(h('span', 'pl-rank', String(index + 1)), document.createTextNode(row.name));
    first.appendChild(line);
    first.title = `${row.name}: ${row.calls} ${row.calls === 1 ? 'call' : 'calls'}, ${compact(row.generated)} tokens written while calling it, ${chars(row.contextChars)} added.`;
    const context = h('td', undefined, row.contextChars > 0 ? compact(row.contextChars) : DASH);
    context.title = row.contextChars > 0 ? chars(row.contextChars) : 'It returned no text';
    const generated = h('td', undefined, row.generated > 0 ? compact(row.generated) : DASH);
    generated.title = `${row.generated.toLocaleString('en-US')} tokens`;
    tr.append(first, h('td', undefined, compact(row.calls)), generated, context);
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  const wrap = h('div', 'pl-scroll');
  wrap.appendChild(table);
  return wrap;
};

const surfaceSection = (title: string, rows: SurfaceRow[], empty: string, nameLabel: string, callsLabel = 'Calls'): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', title));
  section.appendChild(rows.length === 0 ? h('p', 'pl-cap', empty) : surfaceTable(rows, nameLabel, callsLabel));
  return section;
};

const surfaceTotals = (view4: PeriodView): HTMLElement => {
  const { surfaces } = view4;
  const sub = surfaces.subagents;
  const grid = h('div', 'pl-totals');
  const calls = h('div', 'pl-card');
  calls.append(h('div', 'k', 'Tool calls'), h('div', 'v', compact(surfaces.calls)), h('div', 's', view4.label.toLowerCase()));
  const context = h('div', 'pl-card');
  context.append(h('div', 'k', 'Context added'), h('div', 'v', compact(surfaces.contextChars)), h('div', 's', 'characters'));
  const share = h('div', 'pl-card');
  share.append(
    h('div', 'k', 'Subagent share'),
    h('div', 'v', sub.share === null ? DASH : shareText(sub.share)),
    h('div', 's', sub.sessions === 0 ? 'no subagent sessions' : sub.share === null ? `${replies(sub.messages)}` : `${money(sub.cost)} of spend`),
  );
  grid.append(calls, context, share);
  return grid;
};

const subagentBlock = (view4: PeriodView): HTMLElement => {
  const sub = view4.surfaces.subagents;
  if (sub.dispatches === 0 && sub.sessions === 0) {
    const section = h('div', 'pl-section');
    section.appendChild(h('h2', 'pl-h', `Subagents · ${view4.label}`));
    section.appendChild(h('p', 'pl-cap', 'No subagents were dispatched in this period.'));
    return section;
  }
  const section = surfaceSection(`Subagents · ${view4.label}`, sub.types, 'No dispatch was recorded, though subagent sessions ran.', 'Type', 'Dispatches');
  const spent = sub.share === null
    ? `${replies(sub.messages)} (no spend in this period)`
    : `${money(sub.cost)} · ${shareText(sub.share)} of the period\u2019s spend · ${replies(sub.messages)}`;
  section.appendChild(h('p', 'pl-cap', `${sub.dispatches} ${sub.dispatches === 1 ? 'dispatch' : 'dispatches'} started ${sub.sessions} ${sub.sessions === 1 ? 'session' : 'sessions'} with replies in this period: ${spent}. Already counted in the totals, not added to them.`));
  return section;
};

const surfacesView = (data: PanelPayload, view4: PeriodView): HTMLElement[] => {
  const head3 = h('div', 'pl-section');
  head3.appendChild(h('h2', 'pl-h', data.toolsRead === 0 ? 'Surfaces' : `Surfaces · ${view4.label}`));
  head3.appendChild(h('p', 'pl-standing', NO_BILL));
  if (data.toolsRead === 0) {
    head3.appendChild(h('p', 'pl-cap', data.toolsPending > 0
      ? `Tool calls appear after the first sync of recent sessions. Reading now: ${compact(data.toolsPending)} sessions to go, newest first.`
      : 'Tool calls appear after the first sync of recent sessions.'));
    return [head3];
  }
  head3.appendChild(h('p', 'pl-cap', `Generated: ${GENERATED_HINT.charAt(0).toLowerCase()}${GENERATED_HINT.slice(1)}. Context added: ${CONTEXT_HINT.charAt(0).toLowerCase()}${CONTEXT_HINT.slice(1)}. A reply that calls several tools counts its tokens under each.`));
  const parts: HTMLElement[] = [head3, periodControl(data, view4)];
  if (data.toolsPending > 0) {
    const note = h('div');
    parts.push(note);
    track(mountBanner(note, {
      tone: 'info',
      title: 'Reading tool calls',
      body: `${compact(data.toolsPending)} sessions to go, newest first, so older periods are partial.`,
    }));
  }
  const s = view4.surfaces;
  if (s.calls === 0 && s.subagents.sessions === 0) {
    parts.push(h('p', 'pl-cap', 'No tool calls in this period.'));
    return parts;
  }
  parts.push(
    surfaceTotals(view4),
    surfaceSection(`Skills · ${view4.label}`, s.skills, 'No skill was loaded in this period.', 'Skill'),
    surfaceSection(`MCP servers · ${view4.label}`, s.mcp, s.mcpViaCodeMode
      ? 'No tool ran under an mcp_ name. MCP calls made through a code-mode tool are counted under Other tools, as execute.'
      : 'No MCP server was called in this period, or its tools do not use the mcp_<server>_<tool> names.', 'Server'),
    subagentBlock(view4),
    surfaceSection(`Other tools · ${view4.label}`, s.other, 'No other tool was called in this period.', 'Tool'),
  );
  return parts;
};

// ---- Settings -------------------------------------------------------------

const FIELD_COPY: Record<SettingsField, { label: string; help: string; placeholder: string }> = {
  roots: {
    label: 'Workspace roots',
    help: 'Absolute folders, one per line. A session under one is counted under the first folder below it: with /work/customers as a root, /work/customers/Acme/site is Acme. Without any root a session is counted under its own folder.',
    placeholder: '/work/customers',
  },
  localProviders: {
    label: 'Local provider ids',
    help: 'Providers that run on this machine, one id per line. Their replies cost no per-token money. A model id ending :cloud is cloud even on these.',
    placeholder: 'ollama',
  },
  utilityModels: {
    label: 'Utility models',
    help: 'Models used for classification, routing or titling, one per line: a model id, or provider/model, with * as a wildcard.',
    placeholder: 'provider/small-model',
  },
  codingAgents: {
    label: 'Coding agents',
    help: 'Agent ids whose replies count as coding. Replies from every other agent count as agentic.',
    placeholder: 'build',
  },
  imagePatterns: {
    label: 'Image model patterns',
    help: 'Fragments of a model id that mark an image-generation model, one per line.',
    placeholder: 'gpt-image',
  },
};

const settingsBlock = (data: PanelPayload): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', 'Settings'));
  section.appendChild(h('p', 'pl-cap', 'Nothing here is required: the ledger already names projects after their folders and sorts replies by the shipped rules. Changes re-sort the history that is already stored; nothing is read again.'));

  const draft = settingsDraft ?? Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, data.settings[f].join('\n')])) as Record<SettingsField, string>;
  const form = h('div', 'pl-form');
  for (const field of SETTINGS_FIELDS) {
    const copy = FIELD_COPY[field];
    const label = h('label', 'pl-field');
    label.appendChild(h('span', 'pl-field-l', copy.label));
    label.appendChild(h('span', 'pl-cap', copy.help));
    const area = document.createElement('textarea');
    area.className = 'pl-area';
    area.rows = Math.min(8, Math.max(3, draft[field].split('\n').length + 1));
    area.spellcheck = false;
    area.autocomplete = 'off';
    area.placeholder = copy.placeholder;
    area.value = draft[field];
    area.addEventListener('focus', () => { editingCap = true; });
    area.addEventListener('blur', () => { editingCap = false; });
    area.addEventListener('input', () => {
      settingsDraft ??= { ...draft };
      settingsDraft[field] = area.value;
    });
    label.appendChild(area);
    form.appendChild(label);
  }
  section.appendChild(form);

  const buttons = h('div', 'pl-buttons');
  const saveSlot = h('div');
  const resetSlot = h('div');
  buttons.append(saveSlot, resetSlot);
  section.appendChild(buttons);
  track(mountButton(saveSlot, { label: 'Save settings', size: 'sm', onClick: () => { void saveSettings(); } }));
  track(mountButton(resetSlot, {
    label: 'Reset rules to defaults',
    size: 'sm',
    variant: 'outline',
    onClick: () => { void postSettings({ reset: true }, 'Rules reset to the shipped defaults', true); },
  }));
  section.appendChild(h('p', 'pl-cap', 'Reset restores local providers, utility models, coding agents and image patterns. Workspace roots and merged folders are kept.'));

  if (data.collapsedProjects.length > 0) {
    const merged = h('div', 'pl-section');
    merged.appendChild(h('h2', 'pl-h', 'Merged folders'));
    merged.appendChild(h('p', 'pl-cap', 'These are counted under the folder they sit in, in the Clients view.'));
    for (const c of data.collapsedProjects) {
      const row = h('div', 'pl-mergedrow');
      row.appendChild(h('span', 'pl-mergedname', c.parent ? `${c.project} → ${c.parent}` : c.project));
      row.appendChild(linkButton('Restore', `Count ${c.project} on its own again`, () => { void setCollapsed(c.project, false); }));
      merged.appendChild(row);
    }
    section.appendChild(merged);
  }
  return section;
};

const viewTabs = (): HTMLElement => {
  const wrap = h('div', 'pl-views');
  const slot = h('div');
  wrap.appendChild(slot);
  track(mountTabs(slot, {
    items: [{ id: 'spend', label: 'Spend' }, { id: 'clients', label: 'Clients' }, { id: 'types', label: 'Types' }, { id: 'surfaces', label: 'Surfaces' }, { id: 'settings', label: 'Settings' }],
    activeId: activeView,
    trackBackground: true,
    onChange: (id) => {
      activeView = id as View;
      refocusView = true;
      render();
    },
  }));
  return wrap;
};

const periodCaption = (data: PanelPayload, view: PeriodView): string => {
  const year = thisYear(data);
  if (view.id === 'all') return data.firstDate ? `All time · since ${shortDate(data.firstDate, year)}` : 'All time · nothing in the ledger yet';
  if (view.id === 'today') return `Today · ${shortDate(view.to, year)} (UTC day)`;
  return `${view.label} · ${view.from ? shortDate(view.from, year) : DASH} to ${shortDate(view.to, year)} (UTC days)`;
};

const periodControl = (data: PanelPayload, view: PeriodView): HTMLElement => {
  const wrap = h('div', 'pl-period');
  const slot = h('div');
  wrap.appendChild(slot);
  track(mountTabs(slot, {
    items: PERIOD_IDS.map((id) => ({ id, label: PERIOD_LABELS[id] })),
    activeId: period,
    trackBackground: true,
    onChange: (id) => {
      period = id as PeriodId;
      refocusPeriod = true;
      render();
    },
  }));
  wrap.appendChild(h('p', 'pl-cap', periodCaption(data, view)));
  return wrap;
};

const totalsRow = (view: PeriodView): HTMLElement => {
  const grid = h('div', 'pl-totals');
  const withReplies = view.providers.filter((p) => p.messages > 0);
  const included = withReplies.filter((p) => p.subscription);
  const allIncluded = withReplies.length > 0 && included.length === withReplies.length;
  const spend = h('div', 'pl-card');
  spend.append(
    h('div', 'k', 'Spend'),
    h('div', 'v', allIncluded ? DASH : money(view.totals.cost)),
    h('div', 's', allIncluded ? 'included in plan' : included.length > 0 ? 'excl. plan usage' : `${compact(view.totals.messages)} replies`),
  );
  const tokens = h('div', 'pl-card');
  tokens.append(h('div', 'k', 'Tokens'), h('div', 'v', compact(view.totals.tokens)), h('div', 's', 'incl. cache'));
  const replies = h('div', 'pl-card');
  replies.append(h('div', 'k', 'Replies'), h('div', 'v', compact(view.totals.messages)), h('div', 's', view.label.toLowerCase()));
  grid.append(spend, tokens, replies);
  return grid;
};

const headerCell = (text: string, title: string, className?: string): HTMLTableCellElement => {
  const th = h('th', className, text);
  th.title = title;
  return th;
};

const providerTable = (view: PeriodView): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Providers · ${view.label}`));
  if (view.providers.length === 0) {
    section.appendChild(h('p', 'pl-cap', 'No replies in this period.'));
    return section;
  }
  section.appendChild(h('p', 'pl-cap', 'Ranked by spend, most first.'));

  const table = h('table', 'pl-table');
  const headRow = h('tr');
  headRow.append(
    headerCell('Provider', 'Provider id as OpenCode reports it'),
    headerCell('Spend\u00A0↓', `Spend in ${view.label}. Ranked by this column, highest first. A dash is a plan-included provider: it reports no per-reply cost`),
    headerCell('Tokens', `All tokens in ${view.label}: input, output, reasoning and cache`, 'col-tokens'),
    headerCell('$/1M', 'Spend divided by all tokens, per million. A blended price, cache included'),
    headerCell('p50 tok/s', 'Median generated tokens per second, reply time included'),
  );
  const thead = h('thead');
  thead.appendChild(headRow);
  const tbody = h('tbody');

  view.providers.forEach((p, index) => {
    const tr = h('tr', 'main');
    const first = h('td');
    const nameLine = h('div', 'pl-pname');
    nameLine.append(h('span', 'pl-rank', String(index + 1)), document.createTextNode(p.name));
    first.appendChild(nameLine);
    if (p.subscription) first.appendChild(h('div', 'pl-sub', 'included in plan'));
    first.title = `${p.provider}: ${p.messages} replies, p90 ${tokensPerSecond(p.p90)} tok/s over ${p.samples} timed replies.`;
    tr.append(
      first,
      h('td', undefined, p.subscription ? DASH : money(p.cost)),
      h('td', 'col-tokens', compact(p.tokens)),
      h('td', undefined, p.subscription ? DASH : pricePerMillion(p.perMillion)),
      h('td', undefined, tokensPerSecond(p.p50)),
    );
    tbody.appendChild(tr);
  });

  table.append(thead, tbody);
  const wrap = h('div', 'pl-scroll');
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
};

// Distinct hues first; warning last because many themes draw it close to primary.
const PALETTE = ['var(--oc-primary)', 'var(--oc-info)', 'var(--oc-success)', 'var(--oc-error)', 'var(--oc-warning)'];
const OTHER = 'var(--oc-muted)';

const chart = (data: PanelPayload, view: PeriodView): HTMLElement => {
  const section = h('div', 'pl-section');
  const monthly = view.granularity === 'month';
  section.appendChild(h('h2', 'pl-h', `${monthly ? 'Monthly' : 'Daily'} spend · ${view.label}`));
  const series = view.series;
  const max = Math.max(...series.map((d) => d.cost), 0);
  if (series.length === 0 || max <= 0) {
    const includedOnly = view.providers.length > 0 && view.providers.every((p) => p.subscription);
    section.appendChild(h('p', 'pl-cap', view.totals.messages === 0
      ? 'No replies in this period.'
      : includedOnly ? 'Everything here is included in a plan, so there is no spend to chart.' : 'No spend recorded in this period.'));
    return section;
  }
  section.appendChild(h('p', 'pl-cap', `${monthly ? 'Months' : 'Days'} are UTC. Hover a bar for the detail.`));

  const totalsByProvider = new Map<string, number>();
  for (const d of series) for (const [p, c] of Object.entries(d.byProvider)) totalsByProvider.set(p, (totalsByProvider.get(p) ?? 0) + c);
  const ranked = [...totalsByProvider.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const shown = ranked.slice(0, PALETTE.length);
  const colorOf = (provider: string): string => {
    const index = shown.indexOf(provider);
    return index >= 0 ? (PALETTE[index] ?? OTHER) : OTHER;
  };

  // Drawn at the real pixel width, so the axis text is never scaled down on a phone.
  const W = Math.max(280, Math.min(720, Math.round(root.clientWidth) || 320));
  const H = 150;
  const left = 40;
  const bottom = 18;
  const plotW = W - left - 4;
  const plotH = H - bottom - 6;
  const slot = plotW / series.length;
  const barW = Math.min(36, Math.max(2, slot - 3));
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${monthly ? 'Monthly' : 'Daily'} spend, ${view.label}` });
  el.setAttribute('class', 'pl-chart');

  el.appendChild(svg('line', { x1: left, x2: W - 4, y1: 6 + plotH, y2: 6 + plotH, stroke: 'currentColor', 'stroke-opacity': 0.35 }));
  const topLabel = svg('text', { x: left - 4, y: 12, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' });
  topLabel.textContent = money(max);
  const zeroLabel = svg('text', { x: left - 4, y: 6 + plotH, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' });
  zeroLabel.textContent = '$0';
  el.append(topLabel, zeroLabel);

  const year = thisYear(data);
  const nameOf = (key: string): string => (monthly ? monthName(key, year) : shortDate(key, year));

  series.forEach((d, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    const group = svg('g');
    const tip = svg('title');
    tip.textContent = `${nameOf(d.key)}: ${money(d.cost)}, ${compact(d.tokens)} tokens, ${d.messages} replies`;
    group.appendChild(tip);
    // Invisible full-height hit area so thin bars are easy to hover or tap.
    group.appendChild(svg('rect', { x: left + i * slot, y: 6, width: slot, height: plotH, fill: 'transparent' }));
    let y = 6 + plotH;
    const parts = Object.entries(d.byProvider).sort((a, b) => ranked.indexOf(a[0]) - ranked.indexOf(b[0]));
    for (const [provider, cost] of parts) {
      const height = (cost / max) * plotH;
      if (height <= 0) continue;
      y -= height;
      group.appendChild(svg('rect', { x, y, width: barW, height, fill: colorOf(provider), rx: 1 }));
    }
    el.appendChild(group);
  });

  // Axis labels: every month while they fit, else a thinned set that always ends on the last bar.
  const labelWidth = monthly ? 44 : 38;
  const every = Math.max(1, Math.ceil(labelWidth / slot));
  const labelAt = (index: number): void => {
    const d = series[index];
    if (!d) return;
    const cx = left + index * slot + slot / 2;
    const anchor = index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle';
    const x = anchor === 'start' ? Math.max(left, cx - slot / 2) : anchor === 'end' ? Math.min(W - 2, cx + slot / 2) : cx;
    const t = svg('text', { x, y: H - 4, 'text-anchor': anchor, 'font-size': 10, fill: 'currentColor' });
    t.textContent = nameOf(d.key);
    el.appendChild(t);
  };
  if (monthly) {
    for (let i = series.length - 1; i >= 0; i -= every) labelAt(i);
  } else {
    // Days: first, middle and last, spaced so no two collide.
    labelAt(0);
    if (series.length > 4) labelAt(Math.floor(series.length / 2));
    if (series.length > 1) labelAt(series.length - 1);
  }
  section.appendChild(el);

  const legend = h('div', 'pl-legend');
  for (const provider of shown) {
    const item = h('span', undefined, providerName(provider));
    item.style.setProperty('--c', colorOf(provider));
    legend.appendChild(item);
  }
  if (ranked.length > shown.length) {
    const other = h('span', undefined, 'Other');
    other.style.setProperty('--c', OTHER);
    legend.appendChild(other);
  }
  section.appendChild(legend);
  return section;
};

const monthsBlock = (data: PanelPayload): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', 'Months'));
  const year = thisYear(data);
  const table = h('table', 'pl-table');
  const headRow = h('tr');
  headRow.append(
    headerCell('Month', 'UTC calendar month'),
    headerCell('Spend', 'Spend in the month; a dash means everything was included in a plan'),
    headerCell('Replies', 'Model replies in the month'),
    headerCell('Tokens', 'All tokens in the month', 'col-tokens'),
    headerCell('Top provider', 'The provider with the most spend that month; with no spend, the one with the most replies'),
  );
  const thead = h('thead');
  thead.appendChild(headRow);
  const tbody = h('tbody');
  const rows: MonthRow[] = data.months;
  for (const m of rows) {
    const tr = h('tr', 'main');
    const empty = m.messages === 0;
    const top = m.top;
    const topDetail = !top ? '' : top.by === 'spend' ? money(top.cost) : `${compact(top.messages)} replies`;
    const topCell = h('td', 'col-top');
    topCell.appendChild(h('div', undefined, top ? top.name : DASH));
    if (topDetail) topCell.appendChild(h('div', 'pl-sub', topDetail));
    topCell.title = top ? `${top.name} · ${topDetail}` : '';
    tr.append(
      h('td', undefined, monthName(m.month, year)),
      h('td', undefined, empty ? DASH : m.subscriptionOnly ? DASH : money(m.cost)),
      h('td', undefined, empty ? DASH : compact(m.messages)),
      h('td', 'col-tokens', empty ? DASH : compact(m.tokens)),
      topCell,
    );
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  const wrap = h('div', 'pl-scroll');
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
};

const modelList = (view: PeriodView): HTMLElement => {
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Top models · ${view.label}`));
  const slot = h('div');
  section.appendChild(slot);
  track(mountList(slot, {
    ariaLabel: `Top models by spend, ${view.label}`,
    emptyText: 'No model replies in this period.',
    onSelect: () => undefined,
    items: view.models.map((m, i) => ({
      id: `${m.provider}|${m.model}|${i}`,
      title: m.model,
      subtitle: m.subscription
        ? `${m.providerName} · included in plan · ${compact(m.tokens)} tokens · ${tokensPerSecond(m.p50)} tok/s`
        : `${m.providerName} · ${compact(m.tokens)} tokens · ${pricePerMillion(m.perMillion)}/1M · ${tokensPerSecond(m.p50)} tok/s`,
      meta: m.subscription ? DASH : money(m.cost),
    })),
  }));
  return section;
};

const ollamaSection = (data: PanelPayload): HTMLElement | null => {
  const usage = data.ollamaUsage;
  if (!usage || usage.models.length === 0) return null;
  const section = h('div', 'pl-section');
  section.appendChild(h('h2', 'pl-h', `Ollama reported, ${usage.range}`));
  section.appendChild(h('p', 'pl-cap', `Read from Ollama itself ${ago(usage.fetchedAt, data.now)}; may differ from the ledger.`));
  const slot = h('div');
  section.appendChild(slot);
  track(mountList(slot, {
    onSelect: () => undefined,
    items: usage.models.slice(0, 8).map((m, i) => ({
      id: `ollama|${m.model}|${i}`,
      title: m.model,
      subtitle: `${m.requests === null ? DASH : `${compact(m.requests)} requests`} · ${compact(m.tokens)} tokens`,
      meta: money(m.usageUsd),
    })),
  }));
  return section;
};

const footer = (data: PanelPayload): void => {
  const lines = h('div', 'lines');
  const synced = data.syncedAt === null ? 'never' : ago(data.syncedAt, data.now);
  lines.appendChild(h('span', undefined, `Ledger synced: ${synced}${data.stale && data.syncedAt !== null ? ' (stale)' : ''}`));
  lines.appendChild(h('span', undefined, `${compact(data.sessionsTracked)} sessions read`));
  if (data.pending > 0) lines.appendChild(h('span', undefined, `${compact(data.pending)} sessions still to read`));
  const buttons = h('div', 'pl-buttons');
  const exportSlot = h('div');
  const buttonSlot = h('div');
  buttons.append(exportSlot, buttonSlot);
  footSlot.append(lines, buttons);
  track(mountButton(exportSlot, { label: 'Export CSV', size: 'sm', variant: 'outline', loading: exporting, disabled: exporting || !data.hasData, onClick: () => { void exportCsv(); } }));
  track(mountButton(buttonSlot, { label: 'Refresh', size: 'sm', variant: 'outline', loading: syncingNow || data.syncing, disabled: syncingNow, onClick: () => { void syncNow(); } }));
};

// ---- Render ---------------------------------------------------------------

const render = (): void => {
  clearDynamic();

  if (loadError) {
    track(mountBanner(bannerSlot, { tone: 'error', title: 'Could not read the ledger', body: loadError }));
  }
  if (!payload) {
    if (!loadError) track(mountSpinner(stateSlot, { label: 'Reading the ledger…' }));
    return;
  }
  const data = payload;

  const badge = data.syncing || syncingNow ? { label: 'Syncing', tone: 'info' as const } : data.stale ? { label: 'Stale', tone: 'warning' as const } : { label: 'Live', tone: 'success' as const };
  track(mountBadge(badgeSlot, badge));

  // The rail icon counts providers at or over their cap; null clears it. Never fails the render.
  void host.setBadge(data.overCap > 0 ? data.overCap : null).catch(() => undefined);

  if (notice) {
    track(mountBanner(bannerSlot, { ...notice, action: { label: 'Dismiss', onClick: () => { notice = null; render(); } } }));
  }
  if (data.rebuilding) {
    track(mountBanner(bannerSlot, {
      tone: 'info',
      title: 'Re-reading history',
      body: data.pending > 0
        ? `The history is being sorted by project and type, so figures are partial. ${compact(data.pending)} sessions to go.`
        : 'The history is being sorted by project and type, so figures are partial until the first pass finishes.',
    }));
  }
  if (data.lastError && !loadError) {
    track(mountBanner(bannerSlot, { tone: 'warning', title: 'Last sync had a problem', body: data.lastError }));
  }

  if (data.syncedAt !== null && data.hasData) bodySlot.appendChild(viewTabs());
  const tabbed = data.syncedAt !== null && data.hasData;
  const view: View = tabbed ? activeView : 'spend';

  // Balances lead the Spend view: they answer "what is left", which is why it is opened.
  if (view === 'spend') {
    bodySlot.appendChild(balanceBlock(data));
    const budgets = budgetBlock(data);
    if (budgets) bodySlot.appendChild(budgets);
  }

  if (data.syncedAt === null) {
    const empty = h('div');
    bodySlot.appendChild(empty);
    track(mountEmpty(empty, {
      title: 'Nothing in the ledger yet',
      body: 'Nothing needs setting up. The first sync reads your OpenCode sessions 40 at a time, oldest first, so it takes a few runs; it runs by itself while this panel is open. Projects are named after their folders and spend is sorted by type automatically. Nothing leaves this machine.',
      action: { label: 'Sync now', onClick: () => { void syncNow(); } },
    }));
    footer(data);
    return;
  }

  if (!data.hasData) {
    const empty = h('div');
    bodySlot.appendChild(empty);
    track(mountEmpty(empty, data.rebuilding ? {
      title: 'Reading your history again',
      body: 'This version sorts spend by project and type, so the ledger reads every session once more. Figures appear as they are read.',
    } : {
      title: 'No model replies in the ledger',
      body: `The ledger synced ${ago(data.syncedAt, data.now)} and read ${data.sessionsTracked} sessions, but found no assistant replies.`,
    }));
    footer(data);
    return;
  }

  const periodView = data.periods[period];
  if (view === 'clients') {
    bodySlot.append(periodControl(data, periodView), totalsRow(periodView), clientsBlock(periodView, data));
  } else if (view === 'types') {
    bodySlot.append(periodControl(data, periodView), totalsRow(periodView), typesBlock(periodView), scopeBlock(periodView), categoryProviders(periodView));
  } else if (view === 'surfaces') {
    bodySlot.append(...surfacesView(data, periodView));
  } else if (view === 'settings') {
    bodySlot.appendChild(settingsBlock(data));
  } else {
    bodySlot.append(periodControl(data, periodView), totalsRow(periodView), providerTable(periodView), chart(data, periodView), monthsBlock(data), modelList(periodView));
    const ollama = ollamaSection(data);
    if (ollama) bodySlot.appendChild(ollama);
  }
  footer(data);

  if (refocusPeriod) {
    refocusPeriod = false;
    const tab = bodySlot.querySelector<HTMLElement>(`[role="tab"][data-id="${period}"]`);
    tab?.focus();
  }
  if (refocusView) {
    refocusView = false;
    bodySlot.querySelector<HTMLElement>(`[role="tab"][data-id="${activeView}"]`)?.focus();
  }
};

// The chart is drawn at pixel width; redraw when the panel is resized.
let lastWidth = 0;
new ResizeObserver(() => {
  const width = Math.round(root.clientWidth);
  if (Math.abs(width - lastWidth) < 8) return;
  lastWidth = width;
  if (payload) renderUnlessEditing();
}).observe(root);

let mounted = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  render();
  void load();
});
