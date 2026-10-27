/**
 * List membership by reference, the one path the CLI (`list add`, `list
 * remove`) and the MCP tools (`list_add`, `list_remove`) share.
 *
 * Each ref resolves with resolveRef (`#12` for an id, a tconst, or a title).
 * Every ref must resolve to exactly one library item, or nothing is written
 * and every problem is reported: a ref that fits several items (two editions)
 * lists them, as every write does. With `addMissing`, a tconst that is not in
 * the library but is in the catalog is added first, as a queue item you do
 * not own.
 */
import { catalogReady, type Db } from './db.js';
import { LibraryError } from './errors.js';
import { addFromCatalog, resolveRef } from './library.js';
import { addToList, removeFromList, requireList, type List } from './lists.js';
import type { LibraryItem } from './types.js';
import { atomic } from './viewings.js';

const TCONST_RE = /^tt\d{7,}$/i;

export interface RefProblem {
  ref: string;
  /** ambiguous: fits several items. not-found: no item fits. not-in-library: a tconst you do not have. not-in-catalog: addMissing, but the catalog has no such movie. */
  reason: 'ambiguous' | 'not-found' | 'not-in-library' | 'not-in-catalog';
  candidates?: LibraryItem[];
}

/** Some refs did not resolve to one item; nothing was written. */
export class ListRefError extends LibraryError {
  constructor(
    readonly list: string,
    readonly problems: RefProblem[],
  ) {
    super(`Nothing changed in "${list}": ${problems.map((p) => `"${p.ref}" ${PROBLEM_TEXT[p.reason]}`).join('; ')}`);
    this.name = 'ListRefError';
  }
}

const PROBLEM_TEXT: Record<RefProblem['reason'], string> = {
  ambiguous: 'matches more than one library item',
  'not-found': 'matches no library item',
  'not-in-library': 'is not in your library',
  'not-in-catalog': 'is not in the catalog',
};

function resolveAll(db: Db, refs: readonly string[], addMissing: boolean): { ids: number[]; missing: string[]; problems: RefProblem[] } {
  if (refs.length === 0) throw new LibraryError('Name at least one movie');
  const ids: number[] = [];
  const missing: string[] = [];
  const problems: RefProblem[] = [];
  const ready = addMissing && catalogReady(db);
  const inCatalog = db.sql.prepare('SELECT 1 FROM titles WHERE tconst = ?');
  for (const raw of refs) {
    const ref = String(raw).trim();
    const r = resolveRef(db, ref);
    if (r.kind === 'one') ids.push(r.item.id);
    else if (r.kind === 'many') problems.push({ ref, reason: 'ambiguous', candidates: r.items });
    else if (!TCONST_RE.test(ref)) problems.push({ ref, reason: 'not-found' });
    else if (!addMissing) problems.push({ ref, reason: 'not-in-library' });
    else if (!ready || inCatalog.get(ref.toLowerCase()) === undefined) problems.push({ ref, reason: 'not-in-catalog' });
    else if (!missing.includes(ref.toLowerCase())) missing.push(ref.toLowerCase());
  }
  return { ids, missing, problems };
}

export interface AddMembersResult {
  list: List;
  /** Item ids newly in the list, in the order named. */
  added: number[];
  /** Item ids that were in it already. */
  already: number[];
  /** Items added to the library by addMissing. */
  created: LibraryItem[];
}

/** Add movies to a list by reference. All or nothing: a ref that fails stops the whole call. */
export function addMembers(db: Db, listName: string, refs: readonly string[], opts: { addMissing?: boolean } = {}): AddMembersResult {
  return atomic(db, () => {
    const list = requireList(db, listName);
    const { ids, missing, problems } = resolveAll(db, refs, opts.addMissing === true);
    if (problems.length) throw new ListRefError(list.name, problems);
    const created = missing.map((t) => addFromCatalog(db, t, { status: 'queue', owned: false }));
    const { added, already } = addToList(db, list.name, [...ids, ...created.map((i) => i.id)]);
    return { list: requireList(db, list.name), added, already, created };
  });
}

export interface RemoveMembersResult {
  list: List;
  removed: number[];
  notMember: number[];
}

/** Remove movies from a list by reference. All or nothing, as addMembers. */
export function removeMembers(db: Db, listName: string, refs: readonly string[]): RemoveMembersResult {
  return atomic(db, () => {
    const list = requireList(db, listName);
    const { ids, problems } = resolveAll(db, refs, false);
    if (problems.length) throw new ListRefError(list.name, problems);
    const { removed, notMember } = removeFromList(db, list.name, ids);
    return { list: requireList(db, list.name), removed, notMember };
  });
}
