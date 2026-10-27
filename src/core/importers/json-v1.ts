/**
 * ScreenTrackr JSON v1, the tool's own export. Every field is carried over.
 * An omitted (or null) `status` or `owned` stays absent on the record, so a merge keeps
 * what the library has; the defaults (queue, owned) apply only to new items.
 */
import { z } from 'zod';
import { LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION } from '../export.js';
import { cleanListName } from '../lists.js';
import { EXTERNAL_ID_KINDS, ITEM_SOURCES, MATCH_STATUSES, STATUSES, WATCHED_ERAS } from '../types.js';
import { calendarDate, isValidWatchedAt } from '../viewings.js';
import { ImportError, type ImportRecord, type ParsedImport } from './common.js';

const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional().default(null);

const listName = z.string().refine((n) => {
  try {
    cleanListName(n);
    return true;
  } catch {
    return false;
  }
}, 'Expected a list name (1 to 100 characters, no control characters)');

/** One play (0.4.0). `source` is required: a play's source decides which imports may remove it. */
const ViewingSchema = z.object({
  watchedAt: z
    .string()
    .trim()
    .refine(isValidWatchedAt, 'Expected YYYY-MM-DD or an ISO date-time')
    .nullable(),
  rewatch: z.boolean().nullish(),
  rating: z.number().int().min(1).max(10).nullish(),
  source: z.enum(ITEM_SOURCES),
  sourceRef: z.string().trim().min(1).max(1000).nullish(),
});

const ItemSchema = z.object({
  tconst: nullable(z.string().regex(/^tt\d{7,}$/)),
  sourceTitle: z.string().trim().min(1),
  sourceYear: nullable(z.number().int()),
  sourceDirector: nullable(z.string()),
  sourceRuntimeMin: nullable(z.number().int()),
  sourceGenre: nullable(z.string()),
  collection: nullable(z.string()),
  owned: z.boolean().nullish(),
  sourceOwnedRaw: nullable(z.string()),
  status: z.enum(STATUSES).nullish(),
  watchedEra: nullable(z.enum(WATCHED_ERAS)),
  watchedAt: nullable(z.string()),
  watchedAtSource: nullable(z.enum(ITEM_SOURCES)),
  myRating: nullable(z.number().int().min(1).max(10)),
  notes: nullable(z.string()),
  matchStatus: z.enum(MATCH_STATUSES).nullish(),
  matchScore: nullable(z.number()),
  source: z.enum(ITEM_SOURCES).nullish().transform((v) => v ?? 'json'),
  applePersistentId: nullable(z.string()),
  externalIds: z.partialRecord(z.enum(EXTERNAL_ID_KINDS), z.string().max(1000)).nullish(),
  addedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  viewings: z.array(ViewingSchema).nullish(),
  lists: z.array(listName).nullish(),
});

const FileSchema = z.object({
  format: z.literal(LIBRARY_FORMAT),
  version: z.literal(LIBRARY_FORMAT_VERSION),
  exportedAt: z.string().optional(),
  items: z.array(ItemSchema),
  lists: z
    .array(z.object({ name: listName, description: z.string().max(1000).nullish(), createdAt: z.string().nullish() }))
    .nullish(),
});

export function isJsonV1(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { format?: unknown }).format === LIBRARY_FORMAT;
}

export function parseJsonV1(data: unknown): ParsedImport {
  const parsed = FileSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new ImportError(`Invalid ScreenTrackr JSON v1${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unknown error'}`);
  }
  const warnings: string[] = [];
  const records: ImportRecord[] = parsed.data.items.map((it) => {
    // An unmatched item can carry an IMDb id kept from an import made before
    // setup. That is a hint to check, not a link to trust.
    const hintOnly = it.tconst !== null && (it.matchStatus === 'unmatched' || it.matchStatus === 'ambiguous');
    const linked = it.tconst !== null && !hintOnly;
    const rec: ImportRecord = {
      sourceTitle: it.sourceTitle,
      sourceYear: it.sourceYear,
      sourceDirector: it.sourceDirector,
      sourceRuntimeMin: it.sourceRuntimeMin,
      sourceGenre: it.sourceGenre,
      collection: it.collection,
      sourceOwnedRaw: it.sourceOwnedRaw,
      watchedEra: it.status === 'watched' ? it.watchedEra : null,
      watchedAt: it.watchedAt,
      // Which source set the date, as exported; a file without one gives a
      // date no import may clear later.
      watchedAtSource: it.watchedAt !== null ? it.watchedAtSource : null,
      myRating: it.myRating,
      notes: it.notes,
      tconst: hintOnly ? null : it.tconst,
      applePersistentId: it.applePersistentId,
      source: it.source,
    };
    if (it.owned != null) rec.owned = it.owned;
    if (it.status != null) rec.status = it.status;
    if (hintOnly) rec.imdbIdHint = it.tconst;
    if (linked) {
      rec.matchStatus = it.matchStatus === 'manual' ? 'manual' : 'matched';
      rec.matchScore = it.matchScore;
    }
    if (it.externalIds) rec.externalIds = it.externalIds;
    if (it.addedAt) rec.addedAt = it.addedAt;
    if (it.viewings) {
      // The plays win; watchedAt is then only the cache a 0.3.x reader would use.
      rec.viewings = it.viewings.map((v) => ({
        watchedAt: v.watchedAt,
        source: v.source,
        // A null flag or rating says nothing: a merge never clears one.
        ...(v.rewatch != null ? { rewatch: v.rewatch } : {}),
        ...(v.rating != null ? { rating: v.rating } : {}),
        sourceRef: v.sourceRef ?? null,
      }));
      const latest = it.viewings.reduce<string | null>(
        (best, v) => (v.watchedAt !== null && (best === null || calendarDate(v.watchedAt) >= calendarDate(best)) ? v.watchedAt : best),
        null,
      );
      if (it.watchedAt !== null && (latest === null || calendarDate(latest) !== calendarDate(it.watchedAt))) {
        warnings.push(`"${it.sourceTitle}": watchedAt ${it.watchedAt} disagrees with its viewings (latest ${latest ?? 'none'}); the viewings were used`);
      }
    }
    if (it.lists?.length) rec.lists = it.lists;
    return rec;
  });
  return {
    records,
    warnings,
    ...(parsed.data.lists ? { lists: parsed.data.lists.map((l) => ({ name: l.name, description: l.description ?? null, createdAt: l.createdAt ?? null })) } : {}),
  };
}
