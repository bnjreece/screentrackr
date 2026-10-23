/**
 * The old web app's export (`ExportData`): `movieList`, plus `movieStatuses`,
 * `myRatings` and `movieImdbData` keyed by title. `movieImdbData[title].imdbID`
 * is a strong match hint.
 *
 * `movieList` may be an array of movie objects, an array of titles, or the raw
 * Apple TV paste text. Keyed entries are attached by exact title, then by
 * trimmed title. A status or rating for a title that is not in `movieList` is
 * reported as a warning, never dropped silently.
 */
import { parseDuration } from '../match.js';
import { parseApplePaste } from './apple-paste.js';
import {
  cleanOwned,
  cleanRating,
  cleanStatus,
  cleanTconst,
  cleanText,
  cleanYear,
  ImportError,
  type ImportRecord,
  type ParsedImport,
} from './common.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isLegacyExport(v: unknown): v is Obj {
  return isObj(v) && ('movieList' in v || 'movieStatuses' in v || 'myRatings' in v);
}

function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

/** Entries of a title-keyed map, looked up by exact then trimmed title. */
class TitleMap {
  private readonly exact = new Map<string, unknown>();
  private readonly trimmed = new Map<string, string>();
  private readonly used = new Set<string>();
  constructor(src: unknown) {
    if (!isObj(src)) return;
    for (const [k, v] of Object.entries(src)) {
      this.exact.set(k, v);
      if (!this.trimmed.has(k.trim())) this.trimmed.set(k.trim(), k);
    }
  }
  get(rawTitle: string): unknown {
    const key = this.exact.has(rawTitle) ? rawTitle : this.trimmed.get(rawTitle.trim());
    if (key === undefined) return undefined;
    this.used.add(key);
    return this.exact.get(key);
  }
  unused(): string[] {
    return [...this.exact.keys()].filter((k) => !this.used.has(k));
  }
}

interface BaseMovie {
  rawTitle: string;
  record: ImportRecord;
}

function baseMovies(list: unknown): BaseMovie[] {
  if (typeof list === 'string') {
    return parseApplePaste(list).records.map((r) => ({ rawTitle: r.sourceTitle, record: { ...r, source: 'legacy' } }));
  }
  if (!Array.isArray(list)) return [];
  const out: BaseMovie[] = [];
  for (const m of list) {
    if (typeof m === 'string') {
      const t = cleanText(m);
      if (t) out.push({ rawTitle: m, record: { sourceTitle: t, source: 'legacy' } });
      continue;
    }
    if (!isObj(m)) continue;
    const rawTitle = pick(m, 'title', 'Title', 'name');
    const title = cleanText(rawTitle);
    if (!title) continue;
    const duration = pick(m, 'duration', 'runtime', 'runtimeMin');
    out.push({
      rawTitle: String(rawTitle),
      record: {
        sourceTitle: title,
        sourceYear: cleanYear(pick(m, 'year', 'Year')),
        sourceDirector: cleanText(pick(m, 'director', 'Director')),
        sourceRuntimeMin: typeof duration === 'number' ? Math.round(duration) : parseDuration(cleanText(duration)),
        sourceGenre: cleanText(pick(m, 'genre', 'Genre')),
        collection: cleanText(pick(m, 'collection', 'Collection')),
        ...cleanOwned(pick(m, 'owned', 'Owned')),
        source: 'legacy',
      },
    });
  }
  return out;
}

export function parseLegacy(data: unknown): ParsedImport {
  if (!isLegacyExport(data)) throw new ImportError('Not an old web app export (no movieList)');
  const movies = baseMovies(data.movieList);
  const statuses = new TitleMap(data.movieStatuses);
  const ratings = new TitleMap(data.myRatings);
  const imdb = new TitleMap(data.movieImdbData);

  for (const { rawTitle, record } of movies) {
    const where = `"${record.sourceTitle}"`;
    const status = cleanStatus(statuses.get(rawTitle), where);
    if (status) Object.assign(record, status);
    const rating = cleanRating(ratings.get(rawTitle), where);
    if (rating !== undefined) record.myRating = rating;
    const info = imdb.get(rawTitle);
    if (isObj(info)) {
      const hint = cleanTconst(pick(info, 'imdbID', 'imdbId', 'imdb_id'));
      // Only the id is kept. The entry's Year came from the same title-only lookup,
      // so a wrong id would bring its own wrong year as false corroboration.
      if (hint) record.imdbIdHint = hint;
    }
  }

  const warnings: string[] = [];
  for (const t of statuses.unused()) warnings.push(`Status for "${t}" has no movie in movieList; not imported`);
  for (const t of ratings.unused()) warnings.push(`Rating for "${t}" has no movie in movieList; not imported`);
  return { records: movies.map((m) => m.record), warnings };
}
