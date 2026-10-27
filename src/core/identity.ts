/**
 * What identifies a movie in the library, decided in one place.
 *
 * An item's (or an import record's) effective identity is its established IMDb
 * id plus the year, runtime and directors that say which film it is. Its own
 * source fields come first ("(yyyy)" in the title beats the year field, also
 * beneath edition suffixes). A field the source left out is taken from the
 * catalog when the IMDb id is established (a match, a hand link, or a JSON v1
 * link), so an item matched through a hint with no year still says 1978. An
 * unresolved item's stored tconst is only an unchecked hint: it never fills
 * anything in.
 *
 * Every identity check uses these helpers: the import merge resolver, title
 * references (`show`, `set`) and catalog title lookup (`add`).
 */
import type { Db } from './db.js';
import { afterEdition, directorsConflict, directorsOf, RUNTIME_TOLERANCE_MIN, sourceYearOf, splitPeople, yearsConflict } from './match.js';
import { normalizeTitle, titleSuffixYear } from './normalize.js';
import type { MatchStatus } from './types.js';

/** An IMDb id that something vouches for: a match, a hand link or a JSON v1 link. A hint is not one. */
export const isEstablished = (status: MatchStatus): boolean => status === 'matched' || status === 'manual';

export interface Identity {
  /** The established IMDb id, or null (none, or only an unchecked hint). */
  tconst: string | null;
  year: number | null;
  runtime: number | null;
  /** Director credit as written, or the catalog's directors joined with ", ". */
  directors: string | null;
  /**
   * The year of the edition a record's source sells (ImportRecord.editionYear),
   * an upper bound on the film's year and never the year itself. Items store
   * none, so it is null (or absent) for them.
   */
  editionYear?: number | null;
}

export interface IdentitySource {
  sourceTitle: string;
  sourceYear?: number | null;
  sourceRuntimeMin?: number | null;
  sourceDirector?: string | null;
  editionYear?: number | null;
  tconst: string | null;
  matchStatus: MatchStatus;
}

/** The effective identity of an item or record (see the module comment). */
export function identityOf(db: Db, src: IdentitySource): Identity {
  const tconst = src.tconst !== null && isEstablished(src.matchStatus) ? src.tconst : null;
  let year = sourceYearOf(src.sourceTitle, src.sourceYear);
  let runtime = src.sourceRuntimeMin ?? null;
  // "Unknown" or a blank credit says nothing, so the catalog may fill it.
  let directors = splitPeople(src.sourceDirector ?? null).length ? (src.sourceDirector as string) : null;
  if (tconst !== null && (year === null || runtime === null || directors === null)) {
    const row = db.sql.prepare('SELECT year, runtime_min FROM titles WHERE tconst = ?').get(tconst) as
      | { year: number | null; runtime_min: number | null }
      | undefined;
    if (row) {
      year ??= row.year;
      runtime ??= row.runtime_min;
    }
    if (directors === null) {
      const names = directorsOf(db, tconst);
      if (names.length) directors = names.join(', ');
    }
  }
  return { tconst, year, runtime, directors, editionYear: src.editionYear ?? null };
}

/**
 * Whether two identities are clearly different movies by their facts: years
 * more than one apart, a film year more than one after the other side's
 * edition year (an edition can't be sold before its film exists), runtimes
 * more than 3 minutes apart, or director credits that share no person.
 * Unknown fields never conflict. Director credits are not compared when both
 * sides are established as the same IMDb title: that title has one set of
 * directors, so a differing credit is a typo or an author credited as director
 * in one source, not another film (editions of one film share directors;
 * runtime still tells cuts apart). IMDb ids and Apple ids are otherwise
 * compared by the caller, which knows which ids are authoritative.
 */
export function factsConflict(a: Identity, b: Identity): boolean {
  return (
    yearsConflict(a.year, b.year) ||
    afterEdition(b.year, a.editionYear) ||
    afterEdition(a.year, b.editionYear) ||
    (a.runtime !== null && b.runtime !== null && Math.abs(a.runtime - b.runtime) > RUNTIME_TOLERANCE_MIN) ||
    (!(a.tconst !== null && a.tconst === b.tconst) && directorsConflict(a.directors, b.directors))
  );
}

/**
 * Whether two identities are already established as the same movie: the same
 * established IMDb id, or identical in every identity field. Only between such
 * items may cosmetic differences (an edition's exact title) pick one.
 */
export function sameMovie(a: Identity, b: Identity): boolean {
  if (a.tconst !== null && a.tconst === b.tconst) return true;
  return a.tconst === b.tconst && a.year === b.year && a.runtime === b.runtime && a.directors === b.directors;
}

/** A title someone typed: its normalized form and the year it names beneath any edition suffixes. */
export interface TitleRef {
  norm: string;
  year: number | null;
}

/**
 * Parse a title reference ("The Glass Harbor (2009) (4K)"): the one parser
 * for title lookups, in the library and in the catalog. The year comes from a
 * trailing "(yyyy)" group only, so a title that is just digits stays a title.
 */
export function parseTitleRef(ref: string): TitleRef {
  return { norm: normalizeTitle(ref), year: titleSuffixYear(ref) };
}
