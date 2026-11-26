// Which project a session belongs to, from the directory it ran in.
export const UNATTRIBUTED = 'Unattributed';
/** OpenChamber gives every chat a folder of its own; one key stands for all of them. */
export const CHATS = 'Chats';

/** Longest key kept; a folder name past this is cut so one odd path cannot bloat the store. */
const KEY_MAX = 80;

/** Bucket keys are `|`-separated, so a key never carries one; control characters are noise. */
export const cleanKey = (name: string): string => (
  // eslint-disable-next-line no-control-regex
  name.replace(/[|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, KEY_MAX).trim()
);

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).map((s) => s.trim()).filter((s) => s !== '' && s !== '.');

const DRIVE = /^[A-Za-z]:$/;
const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/** Windows paths are compared without regard to case; a POSIX path is exact. */
const sameSegment = (a: string, b: string, insensitive: boolean): boolean => (insensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The root with the most segments that holds `all`, with at least one folder below it. */
const rootOf = (all: string[], directory: string, roots: string[]): number => {
  if (!isAbsolute(directory)) return 0;
  const insensitive = DRIVE.test(all[0] ?? '');
  let best = 0;
  for (const root of roots) {
    const r = segmentsOf(root);
    if (r.length === 0 || r.length <= best || all.length <= r.length) continue;
    if (r.every((segment, i) => sameSegment(segment, all[i] ?? '', insensitive))) best = r.length;
  }
  return best;
};

export type Placement = {
  /** The project key of the session. */
  project: string;
  /** The key of the folder this one sits in, when that is a sensible place to merge it; otherwise null. */
  parent: string | null;
};

/**
 * Where a session directory sits in the project tree.
 *
 * - OpenChamber's own chat folders (`…/.config/openchamber/chats/<date>/…`) are `Chats`, because each
 *   chat has a directory of its own and a key per chat would be noise;
 * - under a workspace root, the first folder below the root, whatever sits under it (no parent: the
 *   root itself is not a project);
 * - any other path is its own folder name, and its parent is the folder above it;
 * - no directory, or one that names nothing, is `Unattributed`.
 */
export const placementOf = (directory: string | null | undefined, roots: string[] = []): Placement => {
  const none: Placement = { project: UNATTRIBUTED, parent: null };
  if (typeof directory !== 'string' || directory.trim() === '') return none;
  const trimmed = directory.trim();
  const all = segmentsOf(trimmed);
  if (all.length === 0) return none;

  const chats = all.findIndex((s, i) => s === '.config' && all[i + 1] === 'openchamber' && all[i + 2] === 'chats');
  if (chats >= 0 && chats + 3 < all.length) return { project: CHATS, parent: null };

  const depth = rootOf(all, trimmed, roots);
  if (depth > 0) {
    const name = cleanKey(all[depth] ?? '');
    if (name !== '') return { project: name, parent: null };
  }

  const own = cleanKey(all[all.length - 1] ?? '');
  if (own === '') return none;
  const above = all.length >= 2 ? all[all.length - 2] ?? '' : '';
  const parent = above !== '' && !DRIVE.test(above) ? cleanKey(above) : '';
  return { project: own, parent: parent !== '' && parent !== own ? parent : null };
};

/** The project key of a session directory (see `placementOf`). */
export const projectKeyOf = (directory: string | null | undefined, roots: string[] = []): string => placementOf(directory, roots).project;
