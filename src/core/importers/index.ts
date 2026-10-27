/**
 * Importing a library: detect the format, parse it to ImportRecords, then
 * apply them in one transaction.
 *
 * Merge (the default) adds new items and updates the fields a record has. A
 * field the record lacks (undefined or null) is never cleared, so a source
 * with no statuses or ratings can't wipe yours. Replace backs the library up
 * to `backups/` as ScreenTrackr JSON v1 first, then starts from empty.
 *
 * Which existing item a record is, if any, is decided in one place,
 * resolveMergeTarget: hard conflicts (Apple id, year, runtime, established
 * IMDb id) rule items out, and a record updates an item only when exactly one
 * is left. When several are left, nothing is written and the record is listed
 * in the summary's `reviews` for the owner to settle. Within one import each
 * existing item is claimed by at most one record, and an item the import adds
 * is never a candidate for a later record.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogReady, transaction, type Db } from '../db.js';
import { exportLibrary } from '../export.js';
import { backupsDir } from '../home.js';
import { LIBRARY_COLUMNS, rowToItem, WATCHED_AT_RE, type LibraryRow } from '../library.js';
import { factsConflict, identityOf, sameMovie, type Identity } from '../identity.js';
import { directorsConflict, directorsOf, matchOne, meaningfulCredit, SCORE, type MatchCandidate } from '../match.js';
import { normalizeTitle } from '../normalize.js';
import {
  EXTERNAL_ID_KINDS,
  ITEM_SOURCES,
  MATCH_STATUSES,
  STATUSES,
  WATCHED_ERAS,
  type ExternalIds,
  type LibraryItem,
  type MatchStatus,
} from '../types.js';
import { parseApplePaste } from './apple-paste.js';
import { FORMATS, ImportError, type ImportFormat, type ImportRecord, type ParsedImport } from './common.js';
import { parseCsv } from './csv.js';
import { isImdbHeader, parseImdb } from './imdb.js';
import { isJsonV1, parseJsonV1 } from './json-v1.js';
import { isLegacyExport, parseLegacy } from './legacy.js';
import { isNeonRows, parseNeonRows } from './neon-legacy-rows.js';

export { FORMATS, ImportError, type ImportFormat, type ImportRecord, type ParsedImport };

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ImportError(`The file looks like JSON but does not parse: ${(err as Error).message}`);
  }
}

/** Work out which importer a file needs. Throws ImportError when it can't tell. */
export function detectFormat(text: string, filename?: string): ImportFormat {
  const t = stripBom(text).trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    const data = parseJson(t);
    if (isJsonV1(data)) return 'json-v1';
    if (isLegacyExport(data)) return 'legacy';
    if (isNeonRows(data)) return 'neon-rows';
    throw new ImportError(
      'Unrecognized JSON. Expected a ScreenTrackr export, an old web app export (movieList), or old library rows ({ title, metadata }).',
    );
  }
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  if (isImdbHeader(firstLine)) return 'imdb';
  if (filename?.toLowerCase().endsWith('.csv')) return 'csv';
  if (firstLine.includes('\t')) return 'apple-paste';
  if (firstLine.includes(',') && /(^|,)\s*"?(title|name)"?\s*(,|$)/i.test(firstLine)) return 'csv';
  throw new ImportError(
    'Could not tell the format. Expected ScreenTrackr JSON, an old web app export, tab-separated Apple TV paste, or CSV with a title header. Pass --format to choose.',
  );
}

/** Parse a file to records, also returning the format used and any warnings (skipped rows, orphaned statuses). */
export function parseImportDetailed(
  text: string,
  format?: ImportFormat,
  filename?: string,
): ParsedImport & { format: ImportFormat } {
  const fmt = format ?? detectFormat(text, filename);
  if (!(FORMATS as readonly string[]).includes(fmt)) throw new ImportError(`Unknown import format "${String(fmt)}"`);
  const body = stripBom(text);
  let parsed: ParsedImport;
  switch (fmt) {
    case 'json-v1':
      parsed = parseJsonV1(parseJson(body));
      break;
    case 'legacy':
      parsed = parseLegacy(parseJson(body));
      break;
    case 'neon-rows':
      parsed = parseNeonRows(parseJson(body));
      break;
    case 'apple-paste':
      parsed = parseApplePaste(body);
      break;
    case 'csv':
      parsed = parseCsv(body);
      break;
    case 'imdb': {
      // The library API has no options: a list file is read as a watchlist,
      // and only Movie rows come in. `screentrackr import imdb` takes options.
      const res = parseImdb([{ name: filename ?? 'file', text: body }], {});
      parsed = { records: res.records, warnings: [...res.notices, ...res.warnings, ...res.skippedSummary] };
      break;
    }
  }
  return { format: fmt, ...parsed };
}

export function parseImport(text: string, format?: ImportFormat): ImportRecord[] {
  return parseImportDetailed(text, format).records;
}

export interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  /** Records whose item is ambiguous or unmatched after the import, plus records listed in `reviews`. */
  needsReview: number;
  /**
   * Records that were not written because they fit more than one unclaimed
   * item (see applyImport). `record` is the
   * 1-based position in the file; `candidateIds` are library item ids.
   */
  reviews: ImportReview[];
  backupPath: string | null;
  /** Present and true when nothing was written (`dryRun`): the counts say what the import would do. */
  dryRun?: true;
}

export interface ImportReview {
  record: number;
  sourceTitle: string;
  candidateIds: number[];
}

function validate(records: ImportRecord[]): void {
  records.forEach((r, i) => {
    const where = `Record ${i + 1}${typeof r.sourceTitle === 'string' ? ` ("${r.sourceTitle}")` : ''}`;
    const fail = (msg: string): never => {
      throw new ImportError(`${where}: ${msg}`);
    };
    if (typeof r.sourceTitle !== 'string' || !r.sourceTitle.trim()) fail('missing title');
    if (!(ITEM_SOURCES as readonly string[]).includes(r.source)) fail(`invalid source "${String(r.source)}"`);
    if (r.status !== undefined && !(STATUSES as readonly string[]).includes(r.status)) fail(`invalid status "${String(r.status)}"`);
    if (r.statusIfNew !== undefined && !(STATUSES as readonly string[]).includes(r.statusIfNew)) {
      fail(`invalid new-item status "${String(r.statusIfNew)}"`);
    }
    for (const flag of ['owned', 'ownedIfNew', 'fillOnly', 'imdbIdExact', 'clearWatchedAtIfOwn'] as const) {
      if (r[flag] !== undefined && typeof r[flag] !== 'boolean') fail(`${flag} must be true or false`);
    }
    if (r.watchedAtSource != null && !(ITEM_SOURCES as readonly string[]).includes(r.watchedAtSource)) {
      fail(`invalid watched date source "${String(r.watchedAtSource)}"`);
    }
    if (r.externalIds != null) {
      if (typeof r.externalIds !== 'object' || Array.isArray(r.externalIds)) fail('externalIds must be an object');
      for (const [kind, value] of Object.entries(r.externalIds)) {
        if (!(EXTERNAL_ID_KINDS as readonly string[]).includes(kind)) fail(`unknown external id kind "${kind}"`);
        if (value != null && (typeof value !== 'string' || value.length > 1000)) fail(`invalid ${kind} id`);
        if (kind === 'imdb' && value != null && value.trim() !== '' && !/^tt\d{7,}$/.test(value.trim())) fail(`invalid imdb id "${value}"`);
      }
    }
    if (r.watchedEra != null) {
      if (!(WATCHED_ERAS as readonly string[]).includes(r.watchedEra)) fail(`invalid watched era "${String(r.watchedEra)}"`);
      if (r.status !== 'watched') fail('a watched era needs status watched');
    }
    if (r.myRating != null && !(Number.isInteger(r.myRating) && r.myRating >= 1 && r.myRating <= 10)) {
      fail(`rating must be a whole number from 1 to 10 (got ${String(r.myRating)})`);
    }
    if (r.watchedAt != null && (!WATCHED_AT_RE.test(r.watchedAt) || Number.isNaN(Date.parse(r.watchedAt)))) {
      fail(`invalid watched date "${r.watchedAt}"`);
    }
    if (r.tconst != null && !/^tt\d{7,}$/.test(r.tconst)) fail(`invalid IMDb id "${r.tconst}"`);
    if (r.editionYear != null && !(Number.isInteger(r.editionYear) && r.editionYear >= 1000 && r.editionYear <= 9999)) {
      fail(`invalid edition year "${String(r.editionYear)}"`);
    }
    if (r.matchStatus !== undefined && !(MATCH_STATUSES as readonly string[]).includes(r.matchStatus)) {
      fail(`invalid match status "${String(r.matchStatus)}"`);
    }
  });
}

function writeBackup(db: Db): string {
  const dir = backupsDir(db.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let path = join(dir, `library-${stamp}.json`);
  for (let n = 1; existsSync(path); n++) path = join(dir, `library-${stamp}-${n}.json`);
  writeFileSync(path, JSON.stringify(exportLibrary(db), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

interface Target {
  tconst: string | null;
  matchStatus: MatchStatus;
  matchScore: number | null;
  candidates: MatchCandidate[];
  /**
   * The record's IMDb hint was checked against the catalog and matching did
   * not accept it (the record's own year, runtime or director contradicts it).
   * Such a hint is stale evidence, so it never rules out an item.
   */
  hintRefuted?: boolean;
  /**
   * The record's own director credit names a director of the catalog title
   * it matched (both known and sharing a person). See resolveMergeTarget.
   */
  directorConfirmed?: boolean;
}

function targetFor(db: Db, r: ImportRecord): Target {
  if (r.tconst) {
    return { tconst: r.tconst, matchStatus: r.matchStatus ?? 'matched', matchScore: r.matchScore ?? null, candidates: [] };
  }
  // Before `setup` there is nothing to check a hint against. Keep it on the
  // (still unmatched) item so matching can use it once the catalog is built.
  // An `imdb` external id is IMDb's own id for exactly this title: it is the
  // hint, and an exact one.
  const exactId = r.externalIds?.imdb ?? undefined;
  const hint = (exactId ?? r.imdbIdHint)?.trim().toLowerCase();
  if (hint && /^tt\d{7,}$/.test(hint) && !catalogReady(db)) {
    return { tconst: hint, matchStatus: 'unmatched', matchScore: null, candidates: [] };
  }
  // The source's own id for exactly this title: the catalog's title when it
  // has it, otherwise nothing (never another title found by name).
  if (hint && /^tt\d{7,}$/.test(hint) && (r.imdbIdExact === true || exactId !== undefined)) {
    const known = db.sql.prepare('SELECT 1 FROM titles WHERE tconst = ?').get(hint) !== undefined;
    return known
      ? { tconst: hint, matchStatus: 'matched', matchScore: SCORE.hint, candidates: [] }
      : { tconst: hint, matchStatus: 'unmatched', matchScore: null, candidates: [] };
  }
  const res = matchOne(db, {
    title: r.sourceTitle,
    year: r.sourceYear ?? null,
    editionYear: r.editionYear ?? null,
    director: r.sourceDirector ?? null,
    runtimeMin: r.sourceRuntimeMin ?? null,
    imdbIdHint: hint || null,
  });
  const catalogDirectors = res.tconst !== null && meaningfulCredit(r.sourceDirector) ? directorsOf(db, res.tconst) : [];
  const inCatalog = hint !== undefined && /^tt\d{7,}$/.test(hint) && db.sql.prepare('SELECT 1 FROM titles WHERE tconst = ?').get(hint) !== undefined;
  return {
    tconst: res.tconst,
    matchStatus: res.status,
    // Once the catalog exists, a hint it can't confirm (refuted, or not a
    // movie in the catalog at all, such as a TV episode id) is not evidence.
    hintRefuted: hint !== undefined && hint !== '' && (inCatalog || catalogReady(db)) && res.tconst !== hint,
    // Same convention as rematch: an unmatched item with no candidate at all has no score.
    matchScore: res.status === 'unmatched' && res.score === 0 ? null : res.score,
    candidates: res.status === 'ambiguous' ? res.candidates : [],
    directorConfirmed:
      res.status === 'matched' && catalogDirectors.length > 0 && !directorsConflict(r.sourceDirector, catalogDirectors.join(', ')),
  };
}

interface Existing {
  item: PoolItem;
  norm: string;
  /** The item's effective identity (see identityOf), kept current as the import updates the item. */
  identity: Identity;
}

const blankToNull = (v: string | null | undefined): string | null => (v == null || v.trim() === '' ? null : v.trim());
/** A director credit, or null for blank and placeholder credits such as "Unknown". */
const credit = (v: string | null | undefined): string | null => (meaningfulCredit(v) ? (v as string).trim() : null);

/**
 * Blank and placeholder values carry no identity: an empty Apple id, a
 * blank IMDb hint, or a director credit like "Unknown" or "-" count as absent,
 * so they never match each other and never overwrite a known value.
 */
function cleanRecord(r: ImportRecord): ImportRecord {
  return {
    ...r,
    applePersistentId: blankToNull(r.applePersistentId),
    imdbIdHint: blankToNull(r.imdbIdHint),
    sourceDirector: credit(r.sourceDirector),
    externalIds: canonicalIds(r.externalIds),
  };
}

/** External ids with blank values dropped, trimmed, in a stable key order (so equal sets compare equal). */
function canonicalIds(ids: ExternalIds | null | undefined): ExternalIds {
  const out: Record<string, string> = {};
  for (const kind of Object.keys(ids ?? {}).sort()) {
    const v = blankToNull((ids as Record<string, string | null | undefined>)[kind]);
    if (v !== null) out[kind] = v;
  }
  return out as ExternalIds;
}

const sameIds = (a: ExternalIds, b: ExternalIds): boolean => JSON.stringify(canonicalIds(a)) === JSON.stringify(canonicalIds(b));

/**
 * An item as the import sees it: its row plus its external ids and the source
 * that set its watched date (null: the user, or unknown; see schema V3).
 */
type PoolItem = LibraryItem & { externalIds: ExternalIds; watchedAtSource: string | null };

/** The library columns plus watched_at_source, for the import's own reads. */
const POOL_COLUMNS = `${LIBRARY_COLUMNS}, watched_at_source`;
type PoolRow = LibraryRow & { watched_at_source: string | null };

function externalIdsOf(db: Db): Map<number, ExternalIds> {
  const rows = db.sql.prepare('SELECT item_id, kind, value FROM item_external_ids ORDER BY item_id, kind').all() as {
    item_id: number;
    kind: string;
    value: string;
  }[];
  const out = new Map<number, ExternalIds>();
  for (const row of rows) {
    const ids = (out.get(row.item_id) ?? {}) as Record<string, string>;
    ids[row.kind] = row.value;
    out.set(row.item_id, ids as ExternalIds);
  }
  return out;
}

/**
 * An exact IMDb id (the `imdb` external id) is the item's or record's IMDb
 * title even while the catalog lacks it, so it stands in as the established
 * link when there is none: another movie's link then conflicts with it.
 */
const withExactId = (identity: Identity, exact: string | null | undefined): Identity =>
  identity.tconst === null && exact ? { ...identity, tconst: exact } : identity;

const existing = (db: Db, row: PoolRow, ids: ExternalIds | undefined): Existing => {
  const raw = rowToItem(row);
  const item: PoolItem = {
    ...raw,
    applePersistentId: blankToNull(raw.applePersistentId),
    externalIds: canonicalIds(ids),
    watchedAtSource: raw.watchedAt === null ? null : row.watched_at_source,
  };
  return { item, norm: normalizeTitle(item.sourceTitle), identity: withExactId(identityOf(db, item), item.externalIds.imdb) };
};

/** The identity of the item a record would be, its own catalog link included. */
const recordIdentity = (db: Db, r: ImportRecord, t: Target): Identity =>
  withExactId(identityOf(db, {
    sourceTitle: r.sourceTitle.trim(),
    sourceYear: r.sourceYear ?? null,
    sourceRuntimeMin: r.sourceRuntimeMin ?? null,
    sourceDirector: r.sourceDirector ?? null,
    editionYear: r.editionYear ?? null,
    tconst: t.tconst,
    matchStatus: t.matchStatus,
  }), r.externalIds?.imdb);

/** What the import does with one record. */
type MergeTarget =
  | { kind: 'update'; id: number }
  | { kind: 'unchanged'; id: number; claim?: false }
  | { kind: 'insert' }
  | { kind: 'ambiguous'; candidateIds: number[] };

/** The columns that hold an item's match, as opposed to its own data. */
const MATCH_COLUMNS = new Set(['tconst', 'match_status', 'match_score']);

/**
 * Decide which existing item, if any, a record is. This is the only place
 * merge identity is decided (on identities from core/identity.ts); the rules
 * are documented in docs/library-json-v1.md.
 *
 * 1. Candidates: items with the record's Apple persistent id, items with the
 *    same established IMDb id as the record, and items with the same
 *    normalized title. A shared unverified hint alone never makes a candidate.
 * 2. Hard conflicts rule a candidate out, however it was found: different
 *    known Apple ids; facts that name another movie (factsConflict over each
 *    side's effective identity: years more than one apart, a "(YYYY)" in the
 *    title beating the year field; runtimes more than 3 minutes apart;
 *    directors who are clearly different people), where a linked item or
 *    record whose source left a field out is judged by its catalog title's;
 *    different IMDb ids, unchecked hints included (a hand link yields only to
 *    a record's own JSON v1 link; a record hint matching refuted is stale and
 *    does not count). An equal Apple id is the same item and is never ruled out.
 * 3. Of the survivors, items whose own data the record would not change win
 *    (a re-derived match on an unresolved item does not count as a change).
 *    The record claims one only when the narrowing below, run over all the
 *    survivors, also leaves only that item (items identical to it aside);
 *    otherwise it is unchanged, writes nothing and claims none of them, so a
 *    later record can't inherit a guess. Without such items the survivors are
 *    narrowed, step by step, to the ones with the same Apple id, then the same
 *    established IMDb id, then the same exact title; a step that keeps none is
 *    skipped. The exact-title step only runs among items already established
 *    as one movie (sameMovie), so title formatting never picks between films.
 * 4. One survivor: update it. None: insert. Several: ambiguous, nothing is
 *    written, unless they are identical apart from ids and dates, when the
 *    first is updated.
 *
 * `pool` holds only the items no earlier record of this import has claimed
 * (see applyImport), so every rule above applies among unclaimed items.
 */
function resolveMergeTarget(pool: Existing[], r: ImportRecord, t: Target, rec: Identity): MergeTarget {
  const title = r.sourceTitle.trim();
  const norm = normalizeTitle(title);
  const apple = r.applePersistentId ?? null;
  const recLink = rec.tconst;
  const itemLink = (e: Existing) => e.identity.tconst;
  const sameApple = (e: Existing) => apple !== null && e.item.applePersistentId === apple;
  const hint = (r.externalIds?.imdb ?? r.imdbIdHint)?.trim().toLowerCase() ?? null;
  const supplied = r.tconst ?? (hint && /^tt\d{7,}$/.test(hint) && !t.hintRefuted ? hint : null);

  // A source's own film ids work like the Apple id: the same id of a kind is
  // the same film, a different id of the same kind is another film.
  const recIds = Object.entries(r.externalIds ?? {}) as [keyof ExternalIds, string][];
  const sharedIds = (e: Existing) => recIds.filter(([kind]) => e.item.externalIds[kind] !== undefined);
  const idsDiffer = (e: Existing) => sharedIds(e).some(([kind, v]) => e.item.externalIds[kind] !== v);
  const sameIdsAs = (e: Existing) => sharedIds(e).length > 0 && !idsDiffer(e);

  const found = pool.filter((e) => sameApple(e) || sameIdsAs(e) || (recLink !== null && itemLink(e) === recLink) || e.norm === norm);

  // A TV app track whose store credit names a director of the catalog title it
  // matched, against an item established as that same title: the item's
  // differing credit is a typo or an author credited as director, not another
  // film (editions of one film share directors; runtime still tells cuts
  // apart). Only then are director credits left out of the comparison. Other
  // formats keep it: their automatic match can be wrong, and a hand-typed credit
  // that disagrees may be the only sign.
  const linkSettlesDirectors = (e: Existing) =>
    r.fromTvApp === true && t.directorConfirmed === true && recLink !== null && itemLink(e) === recLink;

  const conflicts = (e: Existing): boolean => {
    if (idsDiffer(e)) return true;
    if (sameApple(e)) return false;
    if (apple !== null && e.item.applePersistentId !== null) return true;
    if (sameIdsAs(e)) return false;
    return (
      // Years more than one apart (or a film from after the edition the record
      // sells), runtimes more than 3 minutes apart (within that, the same cut
      // reported by different sources) or directors who are clearly different
      // people (a remake): another movie. A linked item or record whose source
      // left a field out is judged by its catalog title's.
      factsConflict(rec, e.identity, { directors: !linkSettlesDirectors(e) }) ||
      // Two different IMDb ids that the record itself names (a JSON v1 link or a
      // hint matching did not refute) mean two different movies; a hint yields
      // to a hand link.
      (supplied !== null && e.item.tconst !== null && supplied !== e.item.tconst && (r.tconst != null || e.item.matchStatus !== 'manual')) ||
      // A confident automatic match that disagrees with the item's own
      // established link means another movie (a remake). Treating it as a new
      // item can at worst add a duplicate; never rewrite the other film.
      (recLink !== null && itemLink(e) !== null && recLink !== itemLink(e))
    );
  };
  let survivors = found.filter((e) => !conflicts(e));
  if (!survivors.length) return { kind: 'insert' };

  // How a title is written (an edition tag, a "(1978)" in one and a year
  // field in the other) only chooses between items already established as the
  // same movie; it never decides which of two different movies a record is.
  const exactTitle = (xs: Existing[]) =>
    xs.every((e) => sameMovie(e.identity, (xs[0] as Existing).identity)) ? (e: Existing) => e.item.sourceTitle === title : () => false;
  const narrow = (xs: Existing[]): Existing[] => {
    for (const keep of [() => sameApple, () => sameIdsAs, () => (e: Existing) => recLink !== null && itemLink(e) === recLink, exactTitle]) {
      if (xs.length === 1) break;
      const narrowed = xs.filter(keep(xs));
      if (narrowed.length) xs = narrowed;
    }
    return xs;
  };
  // Items identical in every stored field (two editions an Apple TV paste lists
  // twice, say) are not a choice between movies: the first one stands for all.
  const distinct = (xs: Existing[]) => xs.length > 1 && !xs.every((e) => sameContent(e.item, (xs[0] as Existing).item));

  // A record "repeats" an item when it would change none of the item's own
  // data. Re-deriving an unresolved item's match from the record (tconst,
  // match status, score) does not count: a sparse row matches differently from
  // the item it came from, and that says nothing about which item it is.
  const repeats = survivors.filter((e) => mergeChanges(e.item, r, t).every(([c]) => MATCH_COLUMNS.has(c)));
  if (repeats.length) {
    const fits = narrow(repeats);
    const first = fits[0] as Existing;
    // A repeat claims its item only when the record fits that item alone (or
    // items identical to it). One that would leave several different items as
    // they are, or that would also fit a different item as an update ("watched"
    // with no rating, when the 1978 film is watched and its 2009 remake is not),
    // says nothing about which one it is, so it claims none of them and writes
    // nothing: a later record of the import still has to tell those items apart
    // on its own.
    const alone = !distinct(fits) && narrow(survivors).every((e) => sameContent(e.item, first.item));
    if (!alone) return { kind: 'unchanged', id: first.item.id, claim: false };
    return mergeChanges(first.item, r, t).length ? { kind: 'update', id: first.item.id } : { kind: 'unchanged', id: first.item.id };
  }

  survivors = narrow(survivors);
  const first = survivors[0] as Existing;
  if (distinct(survivors)) return { kind: 'ambiguous', candidateIds: survivors.map((e) => e.item.id) };
  return { kind: 'update', id: first.item.id };
}

/** Whether two items hold the same data (external ids included), local ids, dates and the watched date's source aside. */
function sameContent(a: PoolItem, b: PoolItem): boolean {
  const content = (x: PoolItem) => {
    const rest: Partial<PoolItem> = { ...x };
    delete rest.id;
    delete rest.watchedAtSource;
    delete rest.addedAt;
    delete rest.updatedAt;
    return JSON.stringify(rest);
  };
  return content(a) === content(b);
}

/**
 * Whether `cur` is exactly the item that adding `r` would create (ids, dates
 * and match status aside) and merging `r` would not change it. Such a twin is
 * claimed before any other record is resolved, so an import of an export finds
 * every row's own item whatever the order of the rows.
 */
function isTwin(cur: PoolItem, r: ImportRecord, t: Target): boolean {
  const status = newStatus(r);
  const same =
    cur.sourceTitle === r.sourceTitle.trim() &&
    cur.tconst === t.tconst &&
    cur.status === status &&
    cur.watchedEra === (status === 'watched' ? (r.watchedEra ?? null) : null) &&
    cur.owned === newOwned(r) &&
    cur.source === r.source &&
    cur.sourceYear === (r.sourceYear ?? null) &&
    credit(cur.sourceDirector) === credit(r.sourceDirector) &&
    cur.sourceRuntimeMin === (r.sourceRuntimeMin ?? null) &&
    cur.sourceGenre === (r.sourceGenre ?? null) &&
    cur.collection === (r.collection ?? null) &&
    cur.sourceOwnedRaw === (r.sourceOwnedRaw ?? null) &&
    cur.watchedAt === (r.watchedAt ?? null) &&
    cur.myRating === (r.myRating ?? null) &&
    cur.notes === (r.notes ?? null) &&
    blankToNull(cur.applePersistentId) === blankToNull(r.applePersistentId) &&
    sameIds(cur.externalIds, r.externalIds ?? {});
  return same && mergeChanges(cur, r, t).length === 0;
}

/** The status a new item gets: the record's, else its new-item status, else queue. */
const newStatus = (r: ImportRecord) => r.status ?? r.statusIfNew ?? 'queue';
/** Whether a new item is owned: the record's owned, else its new-item value, else owned. */
const newOwned = (r: ImportRecord) => r.owned ?? r.ownedIfNew ?? true;

/**
 * The source recorded for a date this record writes: a JSON v1 record's own
 * `watchedAtSource` (null when the file gives none), else the record's source.
 */
const dateSource = (r: ImportRecord): string | null => (r.watchedAtSource !== undefined ? r.watchedAtSource : r.source);

/** mergeChanges marks an external id the item lacks with this column prefix; it is written to item_external_ids. */
const EXT_PREFIX = 'ext:';

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";


type Col = [column: string, value: string | number | null];

/**
 * The column changes needed to merge `r` into `cur`. Absent or null fields
 * never clear anything, except that `clearWatchedAtIfOwn` clears a watched
 * date the record's own source set. `ownedIfNew` and `statusIfNew` are never read here
 * (they are for new items only), and with `fillOnly` the descriptive fields
 * only fill blanks. External ids the item lacks come back as `ext:<kind>`.
 */
function mergeChanges(cur: PoolItem, r: ImportRecord, t: Target): Col[] {
  const out: Col[] = [];
  const keep = <K extends keyof LibraryItem & keyof ImportRecord>(key: K, column: string, descriptive = false) => {
    const v = r[key];
    if (v === undefined || v === null || v === cur[key]) return;
    if (descriptive && r.fillOnly === true && cur[key] !== null) return;
    out.push([column, typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number)]);
  };
  keep('sourceYear', 'source_year', true);
  keep('sourceDirector', 'source_director', true);
  keep('sourceRuntimeMin', 'source_runtime_min', true);
  keep('sourceGenre', 'source_genre', true);
  keep('collection', 'collection', true);
  keep('owned', 'owned');
  keep('sourceOwnedRaw', 'source_owned_raw');
  if (r.watchedAt != null && r.watchedAt !== cur.watchedAt) {
    out.push(['watched_at', r.watchedAt], ['watched_at_source', dateSource(r)]);
  } else if (r.watchedAt != null && r.watchedAtSource !== undefined && r.watchedAtSource !== cur.watchedAtSource) {
    // A JSON v1 record says who set this same date (null: the user, or
    // unknown); its word replaces the stored one, so a date a file gives
    // without a source can no longer be cleared by the source that set it.
    out.push(['watched_at_source', r.watchedAtSource]);
  } else if (r.watchedAt == null && r.clearWatchedAtIfOwn === true && cur.watchedAt !== null && cur.watchedAtSource === r.source) {
    // The one clear an import may make: a date this same source set earlier.
    out.push(['watched_at', null], ['watched_at_source', null]);
  }
  keep('myRating', 'my_rating');
  keep('notes', 'notes', true);
  keep('applePersistentId', 'apple_persistent_id');
  for (const [kind, value] of Object.entries(r.externalIds ?? {})) {
    if (!value || cur.externalIds[kind as keyof ExternalIds] !== undefined) continue;
    // A hand link to another title stays the item's identity: an exact IMDb
    // id that names a different title is not stored on it.
    if (kind === 'imdb' && cur.matchStatus === 'manual' && cur.tconst !== null && cur.tconst !== value) continue;
    out.push([`${EXT_PREFIX}${kind}`, value]);
  }

  if (r.status !== undefined) {
    if (r.status !== cur.status) out.push(['status', r.status]);
    const era =
      r.status !== 'watched' ? null : (r.watchedEra ?? (cur.status === 'watched' ? cur.watchedEra : null));
    if (era !== cur.watchedEra) out.push(['watched_era', era]);
  }

  // A hand link is never moved, and an automatic match is not downgraded here
  // (`screentrackr match` re-runs matching on purpose). Unresolved items take
  // the new result, and a JSON v1 link is authoritative.
  // A record with nothing to say about the link (no match, no hint) keeps the
  // item's stored one, such as a hint saved before `setup`.
  const silent = t.tconst === null && t.matchStatus === 'unmatched' && cur.tconst !== null;
  if (cur.matchStatus !== 'manual' && (r.tconst || cur.matchStatus !== 'matched') && !silent) {
    if (t.tconst !== cur.tconst) out.push(['tconst', t.tconst]);
    if (t.matchStatus !== cur.matchStatus) out.push(['match_status', t.matchStatus]);
    if (t.matchScore !== cur.matchScore) out.push(['match_score', t.matchScore]);
  }
  return out;
}

/** Thrown inside a dry run's transaction to roll it back, carrying the summary out. */
class DryRun {
  constructor(readonly summary: ImportSummary) {}
}

/**
 * Write records into the library in one transaction. In `replace` mode the
 * current library is first exported to `backups/` and the backup path is
 * returned. With `dryRun` the import runs as usual inside the transaction and
 * is then rolled back: nothing is written (no backup either) and the summary
 * says what it would have done.
 */
export function applyImport(db: Db, records: ImportRecord[], opts: { mode: 'merge' | 'replace'; dryRun?: boolean }): ImportSummary {
  if (opts.mode !== 'merge' && opts.mode !== 'replace') throw new ImportError(`Unknown import mode "${String(opts.mode)}"`);
  validate(records);
  records = records.map(cleanRecord);
  if (opts.dryRun === true) {
    try {
      writeImport(db, records, opts.mode, null, (summary) => {
        throw new DryRun(summary);
      });
    } catch (err) {
      if (err instanceof DryRun) return { ...err.summary, dryRun: true };
      throw err;
    }
    throw new Error('unreachable: a dry run always rolls back');
  }
  const backupPath = opts.mode === 'replace' ? writeBackup(db) : null;
  return writeImport(db, records, opts.mode, backupPath, (summary) => summary);
}

function writeImport(
  db: Db,
  records: ImportRecord[],
  mode: 'merge' | 'replace',
  backupPath: string | null,
  finish: (summary: ImportSummary) => ImportSummary,
): ImportSummary {
  const opts = { mode };

  const select = db.sql.prepare(`SELECT ${POOL_COLUMNS} FROM library_items WHERE id = ?`);
  const insert = db.sql.prepare(
    `INSERT INTO library_items (tconst, source_title, source_year, source_director, source_runtime_min, source_genre, collection, owned, source_owned_raw, status, watched_era, watched_at, watched_at_source, my_rating, notes, match_status, match_score, source, apple_persistent_id, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}), ${NOW_SQL})`,
  );
  const addExternalId = db.sql.prepare('INSERT OR IGNORE INTO item_external_ids (item_id, kind, value) VALUES (?, ?, ?)');
  const clearCandidates = db.sql.prepare('DELETE FROM match_candidates WHERE item_id = ?');
  const addCandidate = db.sql.prepare('INSERT INTO match_candidates (item_id, tconst, score) VALUES (?, ?, ?)');
  const storeCandidates = (id: number, t: Target) => {
    clearCandidates.run(id);
    if (t.matchStatus === 'ambiguous') for (const c of t.candidates) addCandidate.run(id, c.tconst, c.score);
  };

  return transaction(db.sql, () => {
    if (opts.mode === 'replace') db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');

    const ids = externalIdsOf(db);
    const pool: Existing[] = (db.sql.prepare(`SELECT ${POOL_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as PoolRow[]).map(
      (row) => existing(db, row, ids.get(row.id)),
    );
    // One import claims each existing item for at most one record, and an item
    // it adds is never a candidate for a later record: N records that fit N
    // items claim N distinct items, and a record left with no unclaimed
    // candidate becomes a new item, so no row of a file is ever dropped.
    const claimed = new Set<number>();
    const unclaimed = () => pool.filter((e) => !claimed.has(e.item.id));
    const summary: ImportSummary = { added: 0, updated: 0, unchanged: 0, needsReview: 0, reviews: [], backupPath };
    const targets = records.map((r) => targetFor(db, r));

    // Exact twins first, so a later, sparser record can't take an earlier row's own item.
    // Twins whose match is the same too are paired before the rest, so of two
    // editions that differ only in how they were matched (one linked by hand),
    // each row of an export takes its own item and not the other's.
    const twins: (Existing | undefined)[] = records.map(() => undefined);
    for (const strict of [true, false]) {
      records.forEach((r, index) => {
        if (twins[index]) return;
        const t = targets[index] as Target;
        const twin = pool.find(
          (e) =>
            !claimed.has(e.item.id) &&
            isTwin(e.item, r, t) &&
            (!strict || (e.item.matchStatus === t.matchStatus && e.item.matchScore === t.matchScore)),
        );
        if (twin) claimed.add(twin.item.id);
        twins[index] = twin;
      });
    }

    records.forEach((r, index) => {
      const t = targets[index] as Target;
      const twin = twins[index];
      const target: MergeTarget = twin ? { kind: 'unchanged', id: twin.item.id } : resolveMergeTarget(unclaimed(), r, t, recordIdentity(db, r, t));
      let final: MatchStatus;

      if (target.kind === 'ambiguous') {
        summary.reviews.push({ record: index + 1, sourceTitle: r.sourceTitle.trim(), candidateIds: target.candidateIds });
        summary.needsReview++;
        return;
      }
      if (target.kind === 'insert') {
        const status = newStatus(r);
        const addedAt = r.addedAt && !Number.isNaN(Date.parse(r.addedAt)) ? r.addedAt : null;
        const res = insert.run(
          t.tconst,
          r.sourceTitle.trim(),
          r.sourceYear ?? null,
          r.sourceDirector ?? null,
          r.sourceRuntimeMin ?? null,
          r.sourceGenre ?? null,
          r.collection ?? null,
          newOwned(r) ? 1 : 0,
          r.sourceOwnedRaw ?? null,
          status,
          status === 'watched' ? (r.watchedEra ?? null) : null,
          r.watchedAt ?? null,
          r.watchedAt != null ? dateSource(r) : null,
          r.myRating ?? null,
          r.notes ?? null,
          t.matchStatus,
          t.matchScore,
          r.source,
          r.applePersistentId ?? null,
          addedAt,
        );
        const id = Number(res.lastInsertRowid);
        for (const [kind, value] of Object.entries(r.externalIds ?? {})) addExternalId.run(id, kind, value);
        storeCandidates(id, t);
        summary.added++;
        final = t.matchStatus;
      } else {
        const found = pool.find((e) => e.item.id === target.id) as Existing;
        if (!(target.kind === 'unchanged' && target.claim === false)) claimed.add(found.item.id);
        const changes = target.kind === 'update' ? mergeChanges(found.item, r, t) : [];
        if (changes.length) {
          const columns = changes.filter(([c]) => !c.startsWith(EXT_PREFIX));
          db.sql
            .prepare(`UPDATE library_items SET ${columns.map(([c]) => `${c} = ?, `).join('')}updated_at = ${NOW_SQL} WHERE id = ?`)
            .run(...columns.map(([, v]) => v), found.item.id);
          const ext: Record<string, string> = { ...found.item.externalIds };
          for (const [c, v] of changes) {
            if (!c.startsWith(EXT_PREFIX)) continue;
            addExternalId.run(found.item.id, c.slice(EXT_PREFIX.length), v);
            ext[c.slice(EXT_PREFIX.length)] = String(v);
          }
          if (changes.some(([c]) => c === 'match_status' || c === 'tconst')) storeCandidates(found.item.id, t);
          Object.assign(found, existing(db, select.get(found.item.id) as unknown as PoolRow, ext));
          summary.updated++;
        } else {
          summary.unchanged++;
        }
        final = found.item.matchStatus;
      }
      if (final === 'ambiguous' || final === 'unmatched') summary.needsReview++;
    });
    return finish(summary);
  });
}
