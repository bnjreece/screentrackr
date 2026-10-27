/** Shared pieces for the importers: the record shape, errors and value cleaners. */
import { LibraryError, mapLegacyStatus } from '../library.js';
import type { ItemSource, MatchStatus, Status, WatchedEra } from '../types.js';

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
  owned?: boolean;
  sourceOwnedRaw?: string | null;
  /** Absent means the source says nothing about status; merge keeps the existing one. */
  status?: Status;
  watchedEra?: WatchedEra | null;
  /** Absent means the source has no rating; merge keeps the existing one. */
  myRating?: number | null;
  watchedAt?: string | null;
  /** An authoritative link (ScreenTrackr JSON v1 only). Kept as is, without rematching. */
  tconst?: string | null;
  /** A strong match hint, checked against the catalog. */
  imdbIdHint?: string | null;
  applePersistentId?: string | null;
  source: ItemSource;
  /** ScreenTrackr JSON v1 only, so a round trip is lossless. */
  notes?: string | null;
  matchStatus?: MatchStatus;
  matchScore?: number | null;
  addedAt?: string;
}

export const FORMATS = ['json-v1', 'legacy', 'neon-rows', 'apple-paste', 'csv'] as const;
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
