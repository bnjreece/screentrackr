/**
 * Matching library items to catalog titles (tconst).
 *
 * Candidates come from the indexed `titles.norm_title` (exact, plus titles that
 * extend the source title by whole words) and from titles_fts when available.
 * Each candidate is scored on evidence, and only a clear winner with an exact
 * normalized title is ever `matched`. Anything close is `ambiguous`, so a wrong
 * auto-match is avoided at the cost of a review step.
 */
import { transaction, type Db } from './db.js';
import { normalizeTitle, titleSuffixYear } from './normalize.js';
import type { MatchStatus } from './types.js';

export { normalizeTitle };

/** Scoring weights and thresholds. */
export const SCORE = {
  exactTitle: 50,
  /** Upper bound for a non-exact title, scaled by word overlap. Such a candidate is never auto-matched. */
  partialTitleMax: 30,
  year: 20,
  runtime: 20,
  director: 25,
  /** Applied when both sides name directors and no surname overlaps. */
  directorConflict: -15,
  votesMax: 5,
  matchedMin: 70,
  matchedLead: 15,
  ambiguousMin: 50,
  /** Candidates below this are not reported. */
  reportMin: 40,
  /** Score reported for a hint accepted outright. */
  hint: 100,
  /**
   * Bonus for a hint whose directors or runtime the source contradicts. It is then only one
   * candidate among the title's others, so a remake can beat it on evidence.
   */
  hintContradicted: 25,
} as const;

const YEAR_TOLERANCE = 1;
export const RUNTIME_TOLERANCE_MIN = 3;
const MAX_CANDIDATES = 3;
const MAX_LOOKUP = 25;

/**
 * Parse a duration to whole minutes. Accepts `H:MM:SS`, `MM:SS`, `"142 min"`,
 * `"2h 22m"` and plain minutes. Returns null for anything else.
 */
export function parseDuration(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const v = s.trim().toLowerCase();
  if (!v) return null;

  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(v);
  if (clock) {
    const [a, b, c] = [clock[1], clock[2], clock[3]].map((x) => (x === undefined ? undefined : Number(x)));
    let seconds: number;
    if (c === undefined) {
      // MM:SS
      if ((b as number) >= 60) return null;
      seconds = (a as number) * 60 + (b as number);
    } else {
      // H:MM:SS
      if ((b as number) >= 60 || c >= 60) return null;
      seconds = (a as number) * 3600 + (b as number) * 60 + c;
    }
    return Math.round(seconds / 60);
  }

  const hm = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/.exec(v);
  if (hm && (hm[1] !== undefined || hm[2] !== undefined)) {
    return Number(hm[1] ?? 0) * 60 + Number(hm[2] ?? 0);
  }

  const plain = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (plain) return Math.round(Number(plain[1]));
  return null;
}

/** Split a people string on `,`, `&` and ` and `, dropping blanks, punctuation-only parts and "Unknown". */
/** Whether a credit names anyone: not blank, punctuation-only or "Unknown". */
export function meaningfulCredit(s: string | null | undefined): boolean {
  return splitPeople(s ?? null).length > 0;
}

export function splitPeople(s: string | null): string[] {
  if (!s) return [];
  return s
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter((x) => x && x.toLowerCase() !== 'unknown' && /[\p{L}\p{N}]/u.test(x));
}

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/** A name's words, folded, apostrophes dropped and a trailing "Jr."-style suffix removed. */
function nameWords(name: string): string[] {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1] as string)) words.pop();
  return words;
}

/**
 * Whether two credits can name the same person: the same surname (last word),
 * or the same words in another order. A shared first name alone is not
 * enough: "Orrin Vale" and "Orrin Brask" are two people.
 */
function samePerson(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  if (a[a.length - 1] === b[b.length - 1]) return true;
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
}

/** Whether any name in `xs` can be the same person as any name in `ys`. */
function sharePerson(xs: string[], ys: string[]): boolean {
  const a = xs.map(nameWords).filter((w) => w.length);
  const b = ys.map(nameWords).filter((w) => w.length);
  return a.some((x) => b.some((y) => samePerson(x, y)));
}

const knownNames = (names: string[]) => names.some((n) => nameWords(n).length > 0);

export interface MatchInput {
  title: string;
  year?: number | null;
  /** The year of the edition the source sells: the film is no later than this (plus a year). Never scored as a year. */
  editionYear?: number | null;
  director?: string | null;
  runtimeMin?: number | null;
  imdbIdHint?: string | null;
}

export interface MatchCandidate {
  tconst: string;
  score: number;
}

export interface MatchResult {
  status: MatchStatus;
  tconst: string | null;
  score: number;
  candidates: MatchCandidate[];
}

interface TitleRow {
  tconst: string;
  title: string;
  original_title: string | null;
  norm_title: string;
  year: number | null;
  runtime_min: number | null;
  votes: number | null;
}

const TITLE_COLS = 't.tconst, t.title, t.original_title, t.norm_title, t.year, t.runtime_min, r.votes';
const TCONST_RE = /^tt\d{7,}$/;
const TITLE_YEAR_RE = /\((\d{4})\)\s*$/;

/**
 * The year a source names: a "(yyyy)" among its title's trailing edition and
 * year groups ("(1978) (4K)" included, parsed the same way normalization strips
 * them), else its year field.
 */
export function sourceYearOf(title: string, year: number | null | undefined): number | null {
  const fromSuffix = titleSuffixYear(title);
  if (fromSuffix !== null) return fromSuffix;
  // A title that is nothing but "(yyyy)" has no base to split it from.
  const m = TITLE_YEAR_RE.exec(title.trim());
  return m ? Number(m[1]) : (year ?? null);
}

/**
 * Whether two director credits name different people: both are known (not
 * blank or "Unknown") and no name in one can be a person in the other (see
 * samePerson). Co-director strings are split.
 */
export function directorsConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = splitPeople(a ?? null);
  const y = splitPeople(b ?? null);
  return knownNames(x) && knownNames(y) && !sharePerson(x, y);
}

/** Whether two known years are more than the matching tolerance apart. */
export function yearsConflict(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) > YEAR_TOLERANCE;
}

/**
 * Whether a film year is too late for an edition sold in `editionYear` (see
 * ImportRecord.editionYear): more than the matching tolerance after it. An
 * edition year is only ever an upper bound; any earlier film year fits.
 */
export function afterEdition(filmYear: number | null, editionYear: number | null | undefined): boolean {
  return filmYear !== null && editionYear != null && filmYear > editionYear + YEAR_TOLERANCE;
}

function lookupCandidates(db: Db, norm: string): TitleRow[] {
  const byId = new Map<string, TitleRow>();
  const add = (rows: TitleRow[]) => {
    for (const r of rows) if (!byId.has(r.tconst)) byId.set(r.tconst, r);
  };
  add(
    db.sql
      .prepare(`SELECT ${TITLE_COLS} FROM titles t LEFT JOIN ratings r ON r.tconst = t.tconst WHERE t.norm_title = ?`)
      .all(norm) as unknown as TitleRow[],
  );
  // Titles that extend the source title by whole words. norm_title holds only
  // letters, digits and single spaces, so [norm + ' ', norm + '!') is exactly that range.
  add(
    db.sql
      .prepare(
        `SELECT ${TITLE_COLS} FROM titles t LEFT JOIN ratings r ON r.tconst = t.tconst WHERE t.norm_title >= ? AND t.norm_title < ? LIMIT ${MAX_LOOKUP}`,
      )
      .all(`${norm} `, `${norm}!`) as unknown as TitleRow[],
  );
  if (db.fts) {
    const query = norm
      .split(' ')
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(' ');
    try {
      add(
        db.sql
          .prepare(
            `SELECT ${TITLE_COLS} FROM titles t LEFT JOIN ratings r ON r.tconst = t.tconst WHERE t.tconst IN (SELECT tconst FROM titles_fts WHERE titles_fts MATCH ? LIMIT ${MAX_LOOKUP})`,
          )
          .all(query) as unknown as TitleRow[],
      );
    } catch {
      // A query FTS cannot parse just yields no extra candidates.
    }
  }
  return [...byId.values()];
}

export function directorsOf(db: Db, tconst: string): string[] {
  return (
    db.sql
      .prepare(
        "SELECT p.name FROM title_people tp JOIN people p ON p.nconst = tp.nconst WHERE tp.tconst = ? AND tp.role = 'director' ORDER BY tp.ord",
      )
      .all(tconst) as { name: string }[]
  ).map((r) => r.name);
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(Boolean));
  const wb = new Set(b.split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const LATIN_RE = /[A-Za-z]/;

/**
 * Whether another film with the hinted title's (or the source's) normalized
 * title fits the source runtime, within tolerance and without a year conflict:
 * the other film of a remake pair the runtime could point at. Without one, a
 * runtime far off the hint is only a different cut of the same film.
 */
function runtimeRival(db: Db, row: TitleRow, norm: string, year: number | null, runtime: number): boolean {
  const rivals = db.sql
    .prepare('SELECT year, runtime_min FROM titles WHERE norm_title IN (?, ?) AND tconst <> ? AND runtime_min BETWEEN ? AND ?')
    .all(row.norm_title, norm, row.tconst, runtime - RUNTIME_TOLERANCE_MIN, runtime + RUNTIME_TOLERANCE_MIN) as { year: number | null }[];
  return rivals.some((r) => !yearsConflict(year, r.year));
}

/**
 * How the source contradicts a hinted catalog title, if it does. `year`: the
 * source's year (a "(yyyy)" in its title, else its year field) is more than a
 * year off (hard evidence, the source names the year). `director`: no
 * Latin-script source director can be one of the title's directors (the same
 * surname; a shared first name is not enough), which is soft evidence, since
 * old sources sometimes name an author or producer. Names in other scripts are not compared, since the
 * catalog spells them in Latin script. `runtime`: the source's runtime is more
 * than 3 minutes off the title's (the same test the import merge uses to tell
 * two movies apart) and fits a same-titled rival (see `runtimeRival`), also
 * soft evidence. With no such rival it is just another cut and no contradiction.
 */
function hintContradiction(
  db: Db,
  row: TitleRow,
  norm: string,
  year: number | null,
  runtime: number | null,
  sourceDirectors: string[],
  editionYear: number | null = null,
): 'year' | 'runtime' | 'director' | null {
  if (yearsConflict(year, row.year) || afterEdition(row.year, editionYear)) return 'year';
  if (runtime !== null && row.runtime_min !== null && Math.abs(runtime - row.runtime_min) > RUNTIME_TOLERANCE_MIN && runtimeRival(db, row, norm, year, runtime)) {
    return 'runtime';
  }
  const wanted = sourceDirectors.filter((n) => LATIN_RE.test(n));
  const have = directorsOf(db, row.tconst);
  if (!knownNames(wanted) || !knownNames(have)) return null;
  return sharePerson(wanted, have) ? null : 'director';
}

/**
 * Match one source record against the catalog. Read-only.
 *
 * An `imdbIdHint` that is in the catalog is accepted outright unless the source
 * contradicts it (see `hintContradiction`). Hints from old exports were often
 * looked up by title alone and point at the other film of a remake pair, so a
 * contradicted hint only joins the scored candidates: with a small bonus when
 * only the director or runtime disagrees, with none when the year does.
 *
 * A candidate whose year is more than one off the source's is never matched
 * automatically, however strong its other evidence: at best it is ambiguous.
 *
 * An `editionYear` (the Apple TV app's year) is not the film's year: it earns
 * no year points and only drops candidates released more than a year after it.
 */
export function matchOne(db: Db, input: MatchInput): MatchResult {
  const rawTitle = input.title ?? '';
  // A trailing "(2019)" on the source title is the strongest year evidence there is.
  const year = sourceYearOf(rawTitle, input.year);
  const editionYear = input.editionYear ?? null;
  const sourceDirectors = splitPeople(input.director ?? null);

  const hint = input.imdbIdHint?.trim();
  let hintRow: TitleRow | null = null;
  let hintBonus = 0;
  if (hint && TCONST_RE.test(hint)) {
    hintRow =
      (db.sql
        .prepare(`SELECT ${TITLE_COLS} FROM titles t LEFT JOIN ratings r ON r.tconst = t.tconst WHERE t.tconst = ?`)
        .get(hint) as unknown as TitleRow | undefined) ?? null;
    if (hintRow) {
      const why = hintContradiction(db, hintRow, normalizeTitle(rawTitle), year, input.runtimeMin ?? null, sourceDirectors, editionYear);
      if (!why) {
        return { status: 'matched', tconst: hintRow.tconst, score: SCORE.hint, candidates: [{ tconst: hintRow.tconst, score: SCORE.hint }] };
      }
      hintBonus = why === 'year' ? 0 : SCORE.hintContradicted;
    }
  }

  const norm = normalizeTitle(rawTitle);
  const none: MatchResult = { status: 'unmatched', tconst: null, score: 0, candidates: [] };
  if (!norm) return none;

  const runtime = input.runtimeMin ?? null;
  const wanted = knownNames(sourceDirectors);

  // A film released after the edition on sale (beyond the year's tolerance) cannot be it.
  const rows = lookupCandidates(db, norm).filter((r) => !afterEdition(r.year, editionYear));
  if (hintRow && !afterEdition(hintRow.year, editionYear) && !rows.some((r) => r.tconst === hintRow.tconst)) rows.push(hintRow);

  const scored = rows.map((row) => {
    const exact = row.norm_title === norm || (row.original_title !== null && normalizeTitle(row.original_title) === norm);
    let score = exact ? SCORE.exactTitle : SCORE.partialTitleMax * wordOverlap(norm, row.norm_title);
    if (year !== null && row.year !== null && Math.abs(year - row.year) <= YEAR_TOLERANCE) score += SCORE.year;
    if (runtime !== null && row.runtime_min !== null && Math.abs(runtime - row.runtime_min) <= RUNTIME_TOLERANCE_MIN) {
      score += SCORE.runtime;
    }
    if (wanted) {
      const have = directorsOf(db, row.tconst);
      if (knownNames(have)) score += sharePerson(sourceDirectors, have) ? SCORE.director : SCORE.directorConflict;
    }
    if (row.votes && row.votes > 0) score += Math.min(SCORE.votesMax, Math.log10(row.votes));
    if (hintRow && row.tconst === hintRow.tconst) score += hintBonus;
    return { tconst: row.tconst, score, exact, yearConflict: yearsConflict(year, row.year) || afterEdition(row.year, editionYear) };
  });

  scored.sort((a, b) => b.score - a.score || a.tconst.localeCompare(b.tconst));
  const top = scored[0];
  if (!top) return none;
  const second = scored[1];
  const candidates = scored
    .filter((c) => c.score >= SCORE.reportMin)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ tconst: c.tconst, score: round1(c.score) }));

  const clearLead = !second || top.score - second.score >= SCORE.matchedLead;
  if (top.exact && !top.yearConflict && top.score >= SCORE.matchedMin && clearLead) {
    return { status: 'matched', tconst: top.tconst, score: round1(top.score), candidates };
  }
  if (top.score >= SCORE.ambiguousMin) {
    return { status: 'ambiguous', tconst: null, score: round1(top.score), candidates };
  }
  return { status: 'unmatched', tconst: null, score: round1(top.score), candidates: [] };
}

interface ItemRow {
  id: number;
  tconst: string | null;
  source_title: string;
  source_year: number | null;
  source_director: string | null;
  source_runtime_min: number | null;
  match_status: MatchStatus;
}

/**
 * Re-run matching over the library. `manual` items are never touched. With
 * `onlyUnresolved`, only `unmatched` and `ambiguous` items are processed. A
 * `matched` item keeps its tconst while that title is still in the catalog.
 * Candidates are stored for `ambiguous` items and cleared otherwise.
 */
export function rematch(db: Db, opts: { onlyUnresolved?: boolean } = {}): { matched: number; ambiguous: number; unmatched: number } {
  const where = opts.onlyUnresolved ? "match_status IN ('unmatched', 'ambiguous')" : "match_status <> 'manual'";
  const items = db.sql
    .prepare(
      `SELECT id, tconst, source_title, source_year, source_director, source_runtime_min, match_status FROM library_items WHERE ${where} ORDER BY id`,
    )
    .all() as unknown as ItemRow[];

  const counts = { matched: 0, ambiguous: 0, unmatched: 0 };
  const update = db.sql.prepare('UPDATE library_items SET tconst = ?, match_status = ?, match_score = ? WHERE id = ?');
  const clear = db.sql.prepare('DELETE FROM match_candidates WHERE item_id = ?');
  const addCandidate = db.sql.prepare('INSERT INTO match_candidates (item_id, tconst, score) VALUES (?, ?, ?)');

  transaction(db.sql, () => {
    for (const it of items) {
      const res = matchOne(db, {
        title: it.source_title,
        year: it.source_year,
        director: it.source_director,
        runtimeMin: it.source_runtime_min,
        // A matched item's link, or a hint kept from an import made before the catalog existed.
        imdbIdHint: it.match_status === 'matched' || it.match_status === 'unmatched' ? it.tconst : null,
      });
      counts[res.status as keyof typeof counts]++;
      update.run(res.tconst, res.status, res.status === 'unmatched' && res.score === 0 ? null : res.score, it.id);
      clear.run(it.id);
      if (res.status === 'ambiguous') for (const c of res.candidates) addCandidate.run(it.id, c.tconst, c.score);
    }
  });
  return counts;
}
