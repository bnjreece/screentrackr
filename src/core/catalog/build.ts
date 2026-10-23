import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { transaction, type Db } from '../db.js';
import { normalizeTitle } from '../normalize.js';
import { CATALOG_INDEXES_SQL, CATALOG_TABLES, catalogTablesSql } from '../schema.js';
import type { DatabaseSync } from '../sqlite.js';
import { DATASETS, datasetFile, type Dataset } from './download.js';
import { readTsvGzRows, tsvValue } from './tsv.js';

export interface BuildCatalogOptions {
  cacheDir: string;
  /** Also load titleType = tvMovie. */
  includeTvMovies?: boolean;
  /** Load top-billed cast from title.principals. Defaults to true. */
  withCast?: boolean;
  onProgress?: (msg: string) => void;
}

export interface CatalogStats {
  movies: number;
  rated: number;
  people: number;
  castRows: number;
  seconds: number;
}

/** Cast is the top-billed actors and actresses up to this ordering. */
export const MAX_CAST_ORDERING = 6;

const NEW = '_new';
const PROGRESS_EVERY = 1_000_000;

function dropNewTables(sql: DatabaseSync): void {
  for (const t of CATALOG_TABLES) sql.exec(`DROP TABLE IF EXISTS ${t}${NEW}`);
}

function toInt(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toReal(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Iterate a dataset's rows, resolving the named columns to indexes from its
 * header. Rejects when the file is empty or lacks a required column.
 */
async function* rowsOf<const C extends readonly string[]>(
  path: string,
  file: string,
  columns: C,
  onProgress: (msg: string) => void,
): AsyncGenerator<{ get: (c: C[number]) => string | null }> {
  let idx: Record<string, number> | null = null;
  let fields: string[] = [];
  const row = { get: (c: C[number]) => tsvValue(fields[(idx as Record<string, number>)[c] as number]) };
  let n = 0;
  for await (const f of readTsvGzRows(path)) {
    if (!idx) {
      const map: Record<string, number> = {};
      for (const c of columns) {
        const i = f.indexOf(c);
        if (i === -1) throw new Error(`${file} is missing the "${c}" column; the file may be corrupt or in an unexpected format.`);
        map[c] = i;
      }
      idx = map;
      continue;
    }
    fields = f;
    if (++n % PROGRESS_EVERY === 0) onProgress(`  ${file}: ${n.toLocaleString('en-US')} rows`);
    yield row;
  }
  if (!idx) throw new Error(`${file} is empty.`);
}

/**
 * Build (or rebuild) the catalog from the dataset files in `cacheDir`.
 *
 * Everything loads into `*_new` tables inside one transaction. Then, in a
 * second transaction, the old tables are dropped, the new ones renamed into
 * place, the indexes and titles_fts rebuilt and meta updated. Any failure
 * (a corrupt or truncated file, a bad header, an empty catalog) rolls back and
 * leaves the previous catalog untouched and queryable. Library tables are
 * never touched.
 */
export async function buildCatalog(db: Db, opts: BuildCatalogOptions): Promise<CatalogStats> {
  const started = Date.now();
  const sql = db.sql;
  const progress = opts.onProgress ?? (() => {});
  const withCast = opts.withCast ?? true;
  const types = new Set(opts.includeTvMovies ? ['movie', 'tvMovie'] : ['movie']);

  const needed: Dataset[] = DATASETS.filter((d) => withCast || d !== 'title.principals');
  const paths = {} as Record<Dataset, string>;
  for (const d of needed) {
    const p = join(opts.cacheDir, datasetFile(d));
    if (!existsSync(p)) throw new Error(`Missing ${datasetFile(d)} in ${opts.cacheDir}. Download the IMDb datasets first.`);
    paths[d] = p;
  }

  dropNewTables(sql);
  sql.exec('BEGIN IMMEDIATE');
  try {
    sql.exec(catalogTablesSql(NEW));

    // title.basics: keep movies (and optionally TV movies).
    progress('Loading title.basics');
    const kept = new Set<string>();
    const insTitle = sql.prepare(
      `INSERT OR IGNORE INTO titles${NEW} (tconst, title, original_title, norm_title, year, runtime_min, genres_csv, is_adult) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insGenre = sql.prepare(`INSERT OR IGNORE INTO title_genres${NEW} (tconst, genre) VALUES (?, ?)`);
    const basicsCols = ['tconst', 'titleType', 'primaryTitle', 'originalTitle', 'isAdult', 'startYear', 'runtimeMinutes', 'genres'] as const;
    for await (const r of rowsOf(paths['title.basics'], 'title.basics', basicsCols, progress)) {
      const type = r.get('titleType');
      if (!type || !types.has(type)) continue;
      const tconst = r.get('tconst');
      const title = r.get('primaryTitle');
      if (!tconst || !title || kept.has(tconst)) continue;
      kept.add(tconst);
      const genres = r.get('genres');
      insTitle.run(
        tconst,
        title,
        r.get('originalTitle'),
        normalizeTitle(title),
        toInt(r.get('startYear')),
        toInt(r.get('runtimeMinutes')),
        genres,
        r.get('isAdult') === '1' ? 1 : 0,
      );
      if (genres) for (const g of genres.split(',')) if (g) insGenre.run(tconst, g);
    }
    if (kept.size === 0) throw new Error('title.basics contained no movies; refusing to replace the catalog.');

    // title.ratings
    progress('Loading title.ratings');
    const insRating = sql.prepare(`INSERT OR IGNORE INTO ratings${NEW} (tconst, rating, votes) VALUES (?, ?, ?)`);
    for await (const r of rowsOf(paths['title.ratings'], 'title.ratings', ['tconst', 'averageRating', 'numVotes'] as const, progress)) {
      const tconst = r.get('tconst');
      if (!tconst || !kept.has(tconst)) continue;
      insRating.run(tconst, toReal(r.get('averageRating')), toInt(r.get('numVotes')));
    }

    // title.crew: directors, in credited order.
    progress('Loading title.crew');
    const referenced = new Set<string>();
    const insPerson = sql.prepare(`INSERT OR IGNORE INTO title_people${NEW} (tconst, nconst, role, ord) VALUES (?, ?, ?, ?)`);
    for await (const r of rowsOf(paths['title.crew'], 'title.crew', ['tconst', 'directors'] as const, progress)) {
      const tconst = r.get('tconst');
      const directors = r.get('directors');
      if (!tconst || !directors || !kept.has(tconst)) continue;
      let ord = 0;
      for (const n of directors.split(',')) {
        if (!n) continue;
        insPerson.run(tconst, n, 'director', ++ord);
        referenced.add(n);
      }
    }

    // title.principals: top-billed actors and actresses.
    if (withCast) {
      progress('Loading title.principals (cast)');
      const cols = ['tconst', 'ordering', 'nconst', 'category'] as const;
      for await (const r of rowsOf(paths['title.principals'], 'title.principals', cols, progress)) {
        const category = r.get('category');
        if (category !== 'actor' && category !== 'actress') continue;
        const tconst = r.get('tconst');
        const nconst = r.get('nconst');
        const ord = toInt(r.get('ordering'));
        if (!tconst || !nconst || ord === null || ord > MAX_CAST_ORDERING || !kept.has(tconst)) continue;
        insPerson.run(tconst, nconst, 'actor', ord);
        referenced.add(nconst);
      }
    }

    // name.basics: only people credited above.
    progress('Loading name.basics');
    const insName = sql.prepare(`INSERT OR IGNORE INTO people${NEW} (nconst, name) VALUES (?, ?)`);
    for await (const r of rowsOf(paths['name.basics'], 'name.basics', ['nconst', 'primaryName'] as const, progress)) {
      const nconst = r.get('nconst');
      const name = r.get('primaryName');
      if (!nconst || !name || !referenced.has(nconst)) continue;
      insName.run(nconst, name);
    }

    // Files refresh on different days: drop credits whose person is not in name.basics.
    sql.exec(`DELETE FROM title_people${NEW} WHERE nconst NOT IN (SELECT nconst FROM people${NEW})`);
    sql.exec('COMMIT');
  } catch (err) {
    try {
      sql.exec('ROLLBACK');
    } catch {
      // Already ended.
    }
    try {
      dropNewTables(sql);
    } catch {
      // Best effort; the next build drops them first anyway.
    }
    throw err;
  }

  progress('Swapping in the new catalog');
  const builtAt = new Date().toISOString();
  try {
    transaction(sql, () => {
      for (const t of CATALOG_TABLES) sql.exec(`DROP TABLE IF EXISTS ${t}`);
      for (const t of CATALOG_TABLES) sql.exec(`ALTER TABLE ${t}${NEW} RENAME TO ${t}`);
      sql.exec(CATALOG_INDEXES_SQL);
      if (db.fts) {
        sql.exec('DELETE FROM titles_fts');
        sql.exec(
          'INSERT INTO titles_fts (tconst, title, original_title) SELECT tconst, title, CASE WHEN original_title = title THEN NULL ELSE original_title END FROM titles',
        );
      }
      const setMeta = sql.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      setMeta.run('catalog_built_at', builtAt);
      setMeta.run('catalog_with_cast', withCast ? '1' : '0');
      setMeta.run('catalog_include_tv_movies', opts.includeTvMovies ? '1' : '0');
      for (const d of needed) setMeta.run(`dataset_date:${d}`, statSync(paths[d]).mtime.toUTCString());
      if (!withCast) sql.prepare('DELETE FROM meta WHERE key = ?').run('dataset_date:title.principals');
    });
  } catch (err) {
    try {
      dropNewTables(sql);
    } catch {
      // Best effort.
    }
    throw err;
  }

  try {
    sql.exec('PRAGMA optimize');
    sql.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Housekeeping only.
  }

  const count = (q: string) => (sql.prepare(q).get() as { n: number }).n;
  return {
    movies: count('SELECT COUNT(*) AS n FROM titles'),
    rated: count('SELECT COUNT(*) AS n FROM ratings'),
    people: count('SELECT COUNT(*) AS n FROM people'),
    castRows: count("SELECT COUNT(*) AS n FROM title_people WHERE role = 'actor'"),
    seconds: (Date.now() - started) / 1000,
  };
}
