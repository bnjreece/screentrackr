/**
 * ScreenTrackr JSON v1, the tool's own export. Every field is carried over.
 * An omitted (or null) `status` or `owned` stays absent on the record, so a merge keeps
 * what the library has; the defaults (queue, owned) apply only to new items.
 */
import { z } from 'zod';
import { LIBRARY_FORMAT, LIBRARY_FORMAT_VERSION } from '../export.js';
import { ITEM_SOURCES, MATCH_STATUSES, STATUSES, WATCHED_ERAS } from '../types.js';
import { ImportError, type ImportRecord, type ParsedImport } from './common.js';

const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional().default(null);

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
  myRating: nullable(z.number().int().min(1).max(10)),
  notes: nullable(z.string()),
  matchStatus: z.enum(MATCH_STATUSES).nullish(),
  matchScore: nullable(z.number()),
  source: z.enum(ITEM_SOURCES).nullish().transform((v) => v ?? 'json'),
  applePersistentId: nullable(z.string()),
  addedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});

const FileSchema = z.object({
  format: z.literal(LIBRARY_FORMAT),
  version: z.literal(LIBRARY_FORMAT_VERSION),
  exportedAt: z.string().optional(),
  items: z.array(ItemSchema),
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
    if (it.addedAt) rec.addedAt = it.addedAt;
    return rec;
  });
  return { records, warnings: [] };
}
