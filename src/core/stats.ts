/**
 * Library summary counts. Each library item (edition) counts once. Genres,
 * directors and years come from the catalog for linked items and from the
 * source fields otherwise, the same rule search uses.
 */
import type { Db } from './db.js';
import { splitPeople } from './match.js';
import { STATUSES, type Status } from './types.js';

export interface LibraryStats {
  total: number;
  byStatus: Record<Status, number>;
  unmatched: number;
  ambiguous: number;
  topGenres: [string, number][];
  topDirectors: [string, number][];
  byDecade: [string, number][];
}

const TOP_N = 10;

function top(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_N);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function libraryStats(db: Db): LibraryStats {
  const rows = db.sql
    .prepare(
      `SELECT li.status AS status, li.match_status AS match_status, li.source_director AS source_director,
              li.source_genre AS source_genre, t.tconst AS cat_tconst, t.genres_csv AS genres_csv,
              COALESCE(t.year, li.source_year) AS year,
              (SELECT group_concat(p.name, char(31)) FROM title_people tp JOIN people p ON p.nconst = tp.nconst
                WHERE tp.tconst = t.tconst AND tp.role = 'director') AS directors
       FROM library_items li
       LEFT JOIN titles t ON t.tconst = li.tconst AND li.tconst IS NOT NULL AND li.match_status IN ('matched', 'manual')`,
    )
    .all() as {
    status: Status;
    match_status: string;
    source_director: string | null;
    source_genre: string | null;
    cat_tconst: string | null;
    genres_csv: string | null;
    year: number | null;
    directors: string | null;
  }[];

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const genres = new Map<string, number>();
  const directors = new Map<string, number>();
  const decades = new Map<string, number>();
  let unmatched = 0;
  let ambiguous = 0;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.match_status === 'unmatched') unmatched++;
    if (r.match_status === 'ambiguous') ambiguous++;

    const g = r.genres_csv ?? r.source_genre;
    for (const name of new Set((g ?? '').split(',').map((x) => x.trim()).filter(Boolean))) bump(genres, name);

    const ds = r.directors ? r.directors.split('\u001f') : splitPeople(r.source_director);
    for (const d of new Set(ds)) bump(directors, d);

    if (r.year !== null) bump(decades, `${Math.floor(r.year / 10) * 10}s`);
  }

  return {
    total: rows.length,
    byStatus,
    unmatched,
    ambiguous,
    topGenres: top(genres),
    topDirectors: top(directors),
    byDecade: [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}
