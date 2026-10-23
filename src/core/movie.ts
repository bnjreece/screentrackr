/**
 * Read-only catalog lookups shared by the CLI and the MCP server: one movie's
 * full catalog record, catalog titles by name (for `add <title>`), and the
 * match review queue. Kept in core so every front end shows the same data.
 */
import { catalogReady, type Db } from './db.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from './library.js';
import { parseTitleRef } from './identity.js';
import { yearsConflict } from './match.js';
import { CatalogMissingError } from './search.js';
import type { LibraryItem } from './types.js';

export interface CatalogMovie {
  tconst: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  runtimeMin: number | null;
  genres: string[];
  directors: string[];
  /** Top-billed cast, in billing order. */
  cast: string[];
  rating: number | null;
  votes: number | null;
}

interface TitleRow {
  tconst: string;
  title: string;
  original_title: string | null;
  year: number | null;
  runtime_min: number | null;
  genres_csv: string | null;
  rating: number | null;
  votes: number | null;
}

const TITLE_SELECT = `SELECT t.tconst, t.title, t.original_title, t.year, t.runtime_min, t.genres_csv, r.rating, r.votes
  FROM titles t LEFT JOIN ratings r ON r.tconst = t.tconst`;

function peopleOf(db: Db, tconst: string, role: 'director' | 'actor'): string[] {
  return (
    db.sql
      .prepare('SELECT p.name FROM title_people tp JOIN people p ON p.nconst = tp.nconst WHERE tp.tconst = ? AND tp.role = ? ORDER BY tp.ord')
      .all(tconst, role) as { name: string }[]
  ).map((r) => r.name);
}

function toMovie(db: Db, r: TitleRow): CatalogMovie {
  return {
    tconst: r.tconst,
    title: r.title,
    originalTitle: r.original_title && r.original_title !== r.title ? r.original_title : null,
    year: r.year,
    runtimeMin: r.runtime_min,
    genres: (r.genres_csv ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
    directors: peopleOf(db, r.tconst, 'director'),
    cast: peopleOf(db, r.tconst, 'actor'),
    rating: r.rating,
    votes: r.votes,
  };
}

/** One catalog movie by tconst, or null when it is not in the catalog (or no catalog is built). */
export function getCatalogMovie(db: Db, tconst: string): CatalogMovie | null {
  const row = db.sql.prepare(`${TITLE_SELECT} WHERE t.tconst = ?`).get(tconst.trim().toLowerCase()) as TitleRow | undefined;
  return row ? toMovie(db, row) : null;
}

/**
 * Catalog movies whose normalized title equals the normalized `title`, most
 * voted first. A year narrows to that year (within one): `year`, or a
 * "(yyyy)" in the title (beneath edition tags too); when both are given and
 * disagree, nothing is returned. Partial matches are never returned, so a
 * caller can't add the wrong movie by accident. Throws CatalogMissingError
 * before `setup`.
 */
export function findCatalogByTitle(db: Db, title: string, opts: { year?: number | null } = {}): CatalogMovie[] {
  if (!catalogReady(db)) throw new CatalogMissingError();
  const ref = parseTitleRef(title);
  if (!ref.norm) return [];
  if (opts.year != null && yearsConflict(opts.year, ref.year)) return [];
  const year = opts.year ?? ref.year;
  const params: (string | number)[] = [ref.norm];
  let where = 't.norm_title = ?';
  if (year !== null) {
    where += ' AND t.year BETWEEN ? AND ?';
    params.push(year - 1, year + 1);
  }
  const rows = db.sql
    .prepare(`${TITLE_SELECT} WHERE ${where} ORDER BY COALESCE(r.votes, 0) DESC, t.tconst LIMIT 20`)
    .all(...params) as unknown as TitleRow[];
  // With a year, prefer the exact year when one exists.
  const exact = year !== null ? rows.filter((r) => r.year === year) : [];
  return (exact.length ? exact : rows).map((r) => toMovie(db, r));
}

export interface ReviewCandidate {
  tconst: string;
  score: number;
  title: string;
  year: number | null;
  runtimeMin: number | null;
  directors: string[];
  votes: number | null;
}

export type ReviewItem = LibraryItem & { candidates: ReviewCandidate[] };

/** Library items that are ambiguous or unmatched, each with its stored candidates (best first). */
export function reviewQueue(db: Db): ReviewItem[] {
  const items = (
    db.sql
      .prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items WHERE match_status IN ('ambiguous', 'unmatched') ORDER BY match_status, id`)
      .all() as unknown as LibraryRow[]
  ).map(rowToItem);
  const cands = db.sql.prepare(
    `SELECT mc.tconst, mc.score, t.title, t.year, t.runtime_min, r.votes
     FROM match_candidates mc
     JOIN titles t ON t.tconst = mc.tconst
     LEFT JOIN ratings r ON r.tconst = mc.tconst
     WHERE mc.item_id = ? ORDER BY mc.score DESC, mc.tconst`,
  );
  return items.map((item) => ({
    ...item,
    candidates: (
      cands.all(item.id) as { tconst: string; score: number; title: string; year: number | null; runtime_min: number | null; votes: number | null }[]
    ).map((c) => ({
      tconst: c.tconst,
      score: c.score,
      title: c.title,
      year: c.year,
      runtimeMin: c.runtime_min,
      directors: peopleOf(db, c.tconst, 'director'),
      votes: c.votes,
    })),
  }));
}
