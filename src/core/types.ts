export const STATUSES = ['queue', 'priority', 'someday', 'watched'] as const;
export type Status = (typeof STATUSES)[number];

/** "Unwatched" means any of these. */
export const UNWATCHED_STATUSES = ['queue', 'priority', 'someday'] as const satisfies readonly Status[];

export const WATCHED_ERAS = ['long-ago', '2010s', '2020s'] as const;
export type WatchedEra = (typeof WATCHED_ERAS)[number];

export const MATCH_STATUSES = ['matched', 'ambiguous', 'unmatched', 'manual'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const ITEM_SOURCES = ['paste', 'apple-tv', 'json', 'csv', 'manual', 'legacy'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

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
