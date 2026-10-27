/** Shared pieces for the importers: the record shape, errors and value cleaners. */
import { LibraryError, mapLegacyStatus } from '../library.js';
import type { ExternalIds, ItemSource, MatchStatus, Status, WatchedEra } from '../types.js';

/** One movie as a source describes it, before it is matched and written. */
export interface ImportRecord {
  sourceTitle: string;
  sourceYear?: number | null;
  /**
   * The year of the edition the source sells, not the film's (the Apple TV
   * app's `year`: a 1972 film restored in 2015 shows 2015). The film came out
   * no later than a year after it, so it only rules out later films. It is
   * never stored and never counts as the record's year.
   */
  editionYear?: number | null;
  /**
   * Set by `import apple-tv` only: a track read from the TV app just now, so
   * its director credit is the store's, not a hand-typed one.
   */
  fromTvApp?: boolean;
  sourceDirector?: string | null;
  sourceRuntimeMin?: number | null;
  sourceGenre?: string | null;
  collection?: string | null;
  /** Whether you own it. Set, it applies on insert and on merge; absent, a merge keeps the existing value. */
  owned?: boolean;
  /**
   * Owned for a NEW item only, when `owned` is absent (default true). A merge
   * never reads it, so a source with no idea of ownership (IMDb, Letterboxd,
   * a Trakt watch history) sends `ownedIfNew: false` and can never flip an
   * existing item's owned flag either way.
   */
  ownedIfNew?: boolean;
  sourceOwnedRaw?: string | null;
  /** Absent means the source says nothing about status; merge keeps the existing one. */
  status?: Status;
  /**
   * The status of a NEW item only, when `status` is absent (default `queue`).
   * A merge never reads it, so a watchlist row (`statusIfNew: 'queue'`) never
   * moves an existing item, a watched one included.
   */
  statusIfNew?: Status;
  /**
   * The descriptive fields (sourceYear, sourceDirector, sourceRuntimeMin,
   * sourceGenre, collection, notes) only fill fields an existing item has
   * blank; they never replace a value. For sources that describe a movie but
   * are not the owner's own copy of it (IMDb, Letterboxd, Trakt), so a merge
   * into an Apple TV item keeps that item's own credits and genres. They still
   * count for identity (which item the record is) as usual.
   */
  fillOnly?: boolean;
  /**
   * The source's own stable per-film ids, by kind (EXTERNAL_ID_KINDS), such
   * as `{ letterboxd: 'https://boxd.it/abc' }`. Like the Apple persistent id:
   * an item with the same id of a kind is that item whatever else differs, an
   * item with a different id of the same kind is another film, and a merge
   * adds a kind the item lacks but never replaces or clears one. Stored in
   * item_external_ids and written to JSON v1 as `externalIds`.
   */
  externalIds?: ExternalIds | null;
  watchedEra?: WatchedEra | null;
  /** Absent means the source has no rating; merge keeps the existing one. */
  myRating?: number | null;
  watchedAt?: string | null;
  /**
   * Imports never clear a field, with this one exception. When the record has
   * no `watchedAt` and this is true, the item's watched date is cleared, but
   * only if this record's `source` set that date (the item's stored
   * watched-date source equals `source`). A date the user set, another source
   * set, or a JSON v1 file gave without a source is never cleared. For a
   * source whose earlier, partial export carried dates a later, full export
   * shows were fake (Trakt's bulk "mark watched" plays). Status, era and
   * rating are untouched.
   */
  clearWatchedAtIfOwn?: boolean;
  /**
   * ScreenTrackr JSON v1 only: which source set `watchedAt`, as the export
   * wrote it (null: the user, or unknown). Every other importer leaves it out,
   * and the record's `source` is recorded as the date's source.
   */
  watchedAtSource?: ItemSource | null;
  /** An authoritative link (ScreenTrackr JSON v1 only). Kept as is, without rematching. */
  tconst?: string | null;
  /** A strong match hint, checked against the catalog. */
  imdbIdHint?: string | null;
  /**
   * The hint is the source's own id for exactly this title (IMDb's Const in
   * an IMDb export), not an id someone looked up by title. Once the catalog
   * exists it is accepted whenever the catalog has it, and when the catalog
   * doesn't (a short, a TV title, a catalog built without TV movies) the item
   * stays unmatched with the id kept as its hint, instead of being matched to
   * another title by name.
   */
  imdbIdExact?: boolean;
  applePersistentId?: string | null;
  source: ItemSource;
  /** ScreenTrackr JSON v1 only, so a round trip is lossless. */
  notes?: string | null;
  matchStatus?: MatchStatus;
  matchScore?: number | null;
  addedAt?: string;
}

export const FORMATS = ['json-v1', 'legacy', 'neon-rows', 'apple-paste', 'csv', 'imdb'] as const;
export type ImportFormat = (typeof FORMATS)[number];

/** A problem with the import input. The CLI maps it to exit code 1. */
export class ImportError extends LibraryError {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/** What a parser returns: the records plus anything it could not place. */
export interface ParsedImport {
  records: ImportRecord[];
  warnings: string[];
}

/** Trimmed string, or null when blank or not a string-like value. */
export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** A 4-digit year, or null. */
export function cleanYear(v: unknown): number | null {
  const s = cleanText(v);
  if (!s) return null;
  const m = /^(\d{4})/.exec(s);
  return m ? Number(m[1]) : null;
}

/** A whole-number rating from 1 to 10. Blank is undefined (no rating); anything else invalid throws. */
export function cleanRating(v: unknown, where: string): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
  if (s === null) throw new ImportError(`${where}: rating must be a number (got ${JSON.stringify(v)})`);
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new ImportError(`${where}: rating must be a whole number from 1 to 10 (got ${JSON.stringify(v)})`);
  }
  return n;
}

/** Map a legacy or current status. Blank gives no status at all (not `queue`), so merge keeps what is there. */
export function cleanStatus(v: unknown, where: string): { status: Status; watchedEra: WatchedEra | null } | undefined {
  const s = cleanText(v);
  if (!s) return undefined;
  try {
    return mapLegacyStatus(s);
  } catch {
    throw new ImportError(`${where}: unknown status "${s}"`);
  }
}

const NOT_OWNED = new Set(['no', 'false', '0', 'not owned', 'n']);

/**
 * Owned flag from a raw source value. Blank or missing counts as owned (the
 * library is a list of movies you own); only an explicit negative is not owned.
 * The raw value is kept so the distinction can be recovered.
 */
export function cleanOwned(v: unknown): { owned: boolean; sourceOwnedRaw: string } {
  if (typeof v === 'boolean') return { owned: v, sourceOwnedRaw: String(v) };
  const raw = v === null || v === undefined ? '' : String(v).trim();
  return { owned: !NOT_OWNED.has(raw.toLowerCase()), sourceOwnedRaw: raw };
}

const TCONST_RE = /^tt\d{7,}$/;

/** A well-formed tconst, or null. */
export function cleanTconst(v: unknown): string | null {
  const s = cleanText(v)?.toLowerCase() ?? null;
  return s && TCONST_RE.test(s) ? s : null;
}

/**
 * Fold several records for one film into one, by a key such as an IMDb id or a
 * source's own film id. Needed whenever a source can list one film more than
 * once in a single import (a rating and a watchlist row, two files): within
 * one import every record claims its own item, so unfolded rows would become
 * several items. Records whose key is null pass through untouched, in place;
 * a folded record takes the place of its group's first row.
 *
 * Precedence, which never invents data:
 * - status: `watched` beats any other status; otherwise the first explicit
 *   status (a different explicit one is warned about). `statusIfNew` survives
 *   only when no record has an explicit status, and then the first one wins.
 * - myRating: kept when every record that has one agrees; otherwise left out,
 *   with a warning, so the merge keeps whatever the library has.
 * - watchedAt: the latest date, with that record's watchedAtSource.
 *   watchedEra: the first one given.
 * - clearWatchedAtIfOwn: true when any record asks (it only applies when the
 *   folded record has no watchedAt).
 * - owned, ownedIfNew and the other flags: true when any record says true,
 *   else false when any says false.
 * - externalIds: merged by kind; a kind with two different values keeps the
 *   first, with a warning.
 * - everything else: the first non-null value, in record order.
 */
export function foldRecords(
  records: ImportRecord[],
  keyOf: (r: ImportRecord) => string | null | undefined,
  warn: (message: string) => void,
): ImportRecord[] {
  const groups = new Map<string, ImportRecord[]>();
  const order: (ImportRecord | string)[] = [];
  for (const r of records) {
    const key = keyOf(r);
    if (key == null || key === '') {
      order.push(r);
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(r);
    else {
      groups.set(key, [r]);
      order.push(key);
    }
  }
  return order.map((x) => (typeof x === 'string' ? foldGroup(groups.get(x) as ImportRecord[], warn) : x));
}

const FIRST_VALUE_FIELDS = [
  'sourceYear',
  'editionYear',
  'sourceDirector',
  'sourceRuntimeMin',
  'sourceGenre',
  'collection',
  'sourceOwnedRaw',
  'notes',
  'tconst',
  'imdbIdHint',
  'applePersistentId',
  'matchStatus',
  'matchScore',
  'addedAt',
  'watchedEra',
] as const satisfies readonly (keyof ImportRecord)[];

function foldGroup(group: ImportRecord[], warn: (message: string) => void): ImportRecord {
  const first = group[0] as ImportRecord;
  if (group.length === 1) return first;
  const title = first.sourceTitle;
  const out: Record<string, unknown> = { ...first };
  const set = (key: keyof ImportRecord, value: unknown) => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };
  for (const key of FIRST_VALUE_FIELDS) {
    set(key, group.map((r) => r[key]).find((v) => v !== undefined && v !== null));
  }

  const statuses = group.map((r) => r.status).filter((s): s is Status => s !== undefined);
  const distinctStatuses = [...new Set(statuses)];
  if (statuses.includes('watched')) set('status', 'watched');
  else {
    set('status', statuses[0]);
    if (distinctStatuses.length > 1) warn(`"${title}" is listed with different statuses (${distinctStatuses.join(', ')}); kept ${String(statuses[0])}`);
  }
  set('statusIfNew', out.status === undefined ? group.map((r) => r.statusIfNew).find((s) => s !== undefined) : undefined);
  if (out.status !== 'watched') delete out.watchedEra;

  const ratings = group.map((r) => r.myRating).filter((n): n is number => n !== undefined && n !== null);
  if (ratings.some((n) => n !== ratings[0])) {
    warn(`"${title}" is listed with different ratings (${[...new Set(ratings)].join(', ')}); its rating was left out`);
    set('myRating', undefined);
  } else set('myRating', ratings[0]);

  const dates = group.map((r) => r.watchedAt).filter((d): d is string => typeof d === 'string' && d !== '');
  const latest = dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : undefined;
  set('watchedAt', latest);
  set('watchedAtSource', latest === undefined ? undefined : group.find((r) => r.watchedAt === latest)?.watchedAtSource);

  for (const key of ['owned', 'ownedIfNew', 'fillOnly', 'fromTvApp', 'imdbIdExact', 'clearWatchedAtIfOwn'] as const) {
    const vs = group.map((r) => r[key]).filter((v): v is boolean => typeof v === 'boolean');
    set(key, vs.length ? vs.includes(true) : undefined);
  }

  const ids: Record<string, string> = {};
  for (const r of group) {
    for (const [kind, value] of Object.entries(r.externalIds ?? {})) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const have = ids[kind];
      if (have === undefined) ids[kind] = value;
      else if (have !== value) warn(`"${title}" is listed with two different ${kind} ids; kept the first`);
    }
  }
  set('externalIds', Object.keys(ids).length ? ids : undefined);
  return out as unknown as ImportRecord;
}
