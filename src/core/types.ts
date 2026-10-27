export const STATUSES = ['queue', 'priority', 'someday', 'watched'] as const;
export type Status = (typeof STATUSES)[number];

/** "Unwatched" means any of these. */
export const UNWATCHED_STATUSES = ['queue', 'priority', 'someday'] as const satisfies readonly Status[];

export const WATCHED_ERAS = ['long-ago', '2010s', '2020s'] as const;
export type WatchedEra = (typeof WATCHED_ERAS)[number];

export const MATCH_STATUSES = ['matched', 'ambiguous', 'unmatched', 'manual'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/**
 * Where an item first came from. `imdb` is the IMDb CSV importer; `letterboxd`,
 * `trakt`, `plex` and `jellyfin` are reserved for importers of those sources,
 * so the database accepts them without another table rebuild.
 */
export const ITEM_SOURCES = ['paste', 'apple-tv', 'json', 'csv', 'manual', 'legacy', 'imdb', 'letterboxd', 'trakt', 'plex', 'jellyfin'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/**
 * Kinds of a source's own stable per-film id (ImportRecord.externalIds). Each
 * value must name one film for good in that source (a Letterboxd film URI, a
 * Trakt movie id), never a per-server or per-file id that changes. `imdb` is
 * IMDb's own Const for the row (`import imdb`), an exact id: the item is that
 * IMDb title and no other, so matching (import, `setup`, `match`) links it to
 * that title when the catalog has it and otherwise leaves it unmatched with
 * the id kept, never linking it to another title by name. Adding a
 * kind needs no migration: the database stores any kind, the code validates.
 */
export const EXTERNAL_ID_KINDS = ['imdb', 'letterboxd', 'trakt', 'plex', 'jellyfin'] as const;
export type ExternalIdKind = (typeof EXTERNAL_ID_KINDS)[number];
export type ExternalIds = Partial<Record<ExternalIdKind, string>>;

/** One row of library_items, in camelCase. */
export interface LibraryItem {
  id: number;
  tconst: string | null;
  sourceTitle: string;
  sourceYear: number | null;
  sourceDirector: string | null;
  sourceRuntimeMin: number | null;
  sourceGenre: string | null;
  collection: string | null;
  owned: boolean;
  sourceOwnedRaw: string | null;
  status: Status;
  watchedEra: WatchedEra | null;
  watchedAt: string | null;
  myRating: number | null;
  notes: string | null;
  matchStatus: MatchStatus;
  matchScore: number | null;
  source: ItemSource;
  applePersistentId: string | null;
  addedAt: string;
  updatedAt: string;
}
