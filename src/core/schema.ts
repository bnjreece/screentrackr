/**
 * Versioned schema migrations. MIGRATIONS[i] upgrades schema version i to i + 1.
 * Each step runs inside one transaction together with the meta.schema_version bump.
 * Never edit a released step; append a new one and bump SCHEMA_VERSION.
 *
 * Catalog tables (titles, title_genres, ratings, people, title_people, titles_fts)
 * are rebuilt by `setup`. Library tables (library_items, match_candidates) are
 * never touched by `setup`. library_items.tconst deliberately has no foreign key
 * to titles, so a catalog rebuild never cascades into the library.
 */

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/**
 * Catalog table DDL. `suffix` lets the catalog build create identical
 * `*_new` tables to load into before swapping them in. Indexes are separate so
 * the build can create them with their canonical names after the swap.
 */
/** meta key set when a catalog build commits and cleared by the full rematch that follows. */
export const MATCHING_PENDING_KEY = 'matching_pending';

export const CATALOG_TABLES = ['titles', 'title_genres', 'ratings', 'people', 'title_people'] as const;

export function catalogTablesSql(suffix = ''): string {
  return `
CREATE TABLE titles${suffix} (
  tconst         TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  original_title TEXT,
  norm_title     TEXT NOT NULL DEFAULT '',
  year           INTEGER,
  runtime_min    INTEGER,
  genres_csv     TEXT,
  is_adult       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE title_genres${suffix} (
  tconst TEXT NOT NULL,
  genre  TEXT NOT NULL,
  PRIMARY KEY (tconst, genre)
);

CREATE TABLE ratings${suffix} (
  tconst TEXT PRIMARY KEY,
  rating REAL,
  votes  INTEGER
);

CREATE TABLE people${suffix} (
  nconst TEXT PRIMARY KEY,
  name   TEXT NOT NULL
);

CREATE TABLE title_people${suffix} (
  tconst TEXT NOT NULL,
  nconst TEXT NOT NULL,
  role   TEXT NOT NULL CHECK (role IN ('director', 'actor')),
  ord    INTEGER,
  PRIMARY KEY (tconst, nconst, role)
);
`;
}

/** Secondary indexes on the canonical catalog tables. */
export const CATALOG_INDEXES_SQL = `
CREATE INDEX titles_norm_title ON titles(norm_title);
CREATE INDEX titles_year ON titles(year);
CREATE INDEX title_genres_genre ON title_genres(genre);
CREATE INDEX ratings_rating ON ratings(rating);
CREATE INDEX ratings_votes ON ratings(votes);
CREATE INDEX people_name ON people(name COLLATE NOCASE);
CREATE INDEX title_people_nconst ON title_people(nconst, role);
`;

const V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
${catalogTablesSql()}
${CATALOG_INDEXES_SQL}
CREATE TABLE library_items (
  id                  INTEGER PRIMARY KEY,
  tconst              TEXT,
  source_title        TEXT NOT NULL,
  source_year         INTEGER,
  source_director     TEXT,
  source_runtime_min  INTEGER,
  source_genre        TEXT,
  collection          TEXT,
  owned               INTEGER NOT NULL DEFAULT 1 CHECK (owned IN (0, 1)),
  source_owned_raw    TEXT,
  status              TEXT NOT NULL DEFAULT 'queue'
                        CHECK (status IN ('queue', 'priority', 'someday', 'watched')),
  watched_era         TEXT CHECK (watched_era IS NULL OR watched_era IN ('long-ago', '2010s', '2020s')),
  watched_at          TEXT,
  my_rating           INTEGER CHECK (my_rating IS NULL OR (my_rating BETWEEN 1 AND 10)),
  notes               TEXT,
  match_status        TEXT NOT NULL DEFAULT 'unmatched'
                        CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'manual')),
  match_score         REAL,
  source              TEXT NOT NULL
                        CHECK (source IN ('paste', 'apple-tv', 'json', 'csv', 'manual', 'legacy')),
  apple_persistent_id TEXT,
  added_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at          TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX library_items_tconst ON library_items(tconst);
CREATE INDEX library_items_status ON library_items(status);
CREATE INDEX library_items_match_status ON library_items(match_status);

CREATE TABLE match_candidates (
  item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tconst  TEXT NOT NULL,
  score   REAL NOT NULL,
  PRIMARY KEY (item_id, tconst)
);
`;

/**
 * V2: more item sources, and a source's own stable ids.
 *
 * SQLite can't change a CHECK constraint in place, so library_items is rebuilt
 * with the wider `source` list, keeping every row and id. match_candidates
 * references library_items with ON DELETE CASCADE, so its rows are set aside
 * first and the table is dropped before its parent (dropping the parent with
 * the child still there would cascade and delete them).
 *
 * item_external_ids holds ImportRecord.externalIds: at most one value per kind
 * per item. Kinds are validated in code (EXTERNAL_ID_KINDS), not here, so a
 * new kind never needs another rebuild.
 */
const V2 = `
CREATE TABLE library_items_v2 (
  id                  INTEGER PRIMARY KEY,
  tconst              TEXT,
  source_title        TEXT NOT NULL,
  source_year         INTEGER,
  source_director     TEXT,
  source_runtime_min  INTEGER,
  source_genre        TEXT,
  collection          TEXT,
  owned               INTEGER NOT NULL DEFAULT 1 CHECK (owned IN (0, 1)),
  source_owned_raw    TEXT,
  status              TEXT NOT NULL DEFAULT 'queue'
                        CHECK (status IN ('queue', 'priority', 'someday', 'watched')),
  watched_era         TEXT CHECK (watched_era IS NULL OR watched_era IN ('long-ago', '2010s', '2020s')),
  watched_at          TEXT,
  my_rating           INTEGER CHECK (my_rating IS NULL OR (my_rating BETWEEN 1 AND 10)),
  notes               TEXT,
  match_status        TEXT NOT NULL DEFAULT 'unmatched'
                        CHECK (match_status IN ('matched', 'ambiguous', 'unmatched', 'manual')),
  match_score         REAL,
  source              TEXT NOT NULL
                        CHECK (source IN ('paste', 'apple-tv', 'json', 'csv', 'manual', 'legacy', 'imdb', 'letterboxd', 'trakt', 'plex', 'jellyfin')),
  apple_persistent_id TEXT,
  added_at            TEXT NOT NULL DEFAULT ${NOW},
  updated_at          TEXT NOT NULL DEFAULT ${NOW}
);
INSERT INTO library_items_v2 (id, tconst, source_title, source_year, source_director, source_runtime_min, source_genre, collection, owned, source_owned_raw, status, watched_era, watched_at, my_rating, notes, match_status, match_score, source, apple_persistent_id, added_at, updated_at)
  SELECT id, tconst, source_title, source_year, source_director, source_runtime_min, source_genre, collection, owned, source_owned_raw, status, watched_era, watched_at, my_rating, notes, match_status, match_score, source, apple_persistent_id, added_at, updated_at
  FROM library_items;
CREATE TEMP TABLE match_candidates_v1 AS SELECT item_id, tconst, score FROM match_candidates;
DROP TABLE match_candidates;
DROP TABLE library_items;
ALTER TABLE library_items_v2 RENAME TO library_items;
CREATE INDEX library_items_tconst ON library_items(tconst);
CREATE INDEX library_items_status ON library_items(status);
CREATE INDEX library_items_match_status ON library_items(match_status);

CREATE TABLE match_candidates (
  item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tconst  TEXT NOT NULL,
  score   REAL NOT NULL,
  PRIMARY KEY (item_id, tconst)
);
INSERT INTO match_candidates (item_id, tconst, score) SELECT item_id, tconst, score FROM match_candidates_v1;
DROP TABLE match_candidates_v1;

CREATE TABLE item_external_ids (
  item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (item_id, kind)
);
CREATE INDEX item_external_ids_value ON item_external_ids(kind, value);
`;

/**
 * V3: which import source set an item's watched date (watched_at_source).
 *
 * Imports never clear a field, with one exception: an import may clear a
 * watched date that the same source set earlier (a partial export's dates
 * that a later full export shows were fake). This column records that
 * source. NULL means the user set the date (`set`, `update_movie`), a JSON v1
 * file gave it without saying where it came from, or it was set before this
 * column existed: such a date is never cleared by an import. Values are
 * ITEM_SOURCES, checked in code like external id kinds, so a new source never
 * needs a rebuild. Existing rows start NULL, so nothing already in a library
 * becomes clearable.
 */
const V3 = `
ALTER TABLE library_items ADD COLUMN watched_at_source TEXT;
`;

export const MIGRATIONS: readonly string[] = [V1, V2, V3];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Created only when the FTS5 probe succeeds. Standalone (not external-content):
 * the catalog build repopulates it after each swap.
 */
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(
  tconst UNINDEXED,
  title,
  original_title,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;
