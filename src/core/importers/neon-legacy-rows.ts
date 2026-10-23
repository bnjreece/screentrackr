/**
 * Rows from the old hosted app's `library_items` table, as a JSON array (or an
 * object with a `rows` array): `{ title, metadata: { director, genre, duration,
 * collection, owned, status?, rating?, imdbData?: { imdbID? } } }`.
 * `metadata.rating` is the user's own rating.
 */
import { parseDuration } from '../match.js';
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

function rowsOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (isObj(data) && Array.isArray(data.rows)) return data.rows;
  return null;
}

export function isNeonRows(data: unknown): boolean {
  const rows = rowsOf(data);
  return rows !== null && rows.length > 0 && rows.every((r) => isObj(r) && 'title' in r && isObj(r.metadata));
}

export function parseNeonRows(data: unknown): ParsedImport {
  const rows = rowsOf(data);
  if (!rows) throw new ImportError('Not a list of old library rows');
  const records: ImportRecord[] = [];
  const warnings: string[] = [];
  rows.forEach((row, i) => {
    if (!isObj(row)) {
      warnings.push(`Row ${i + 1}: not an object, skipped`);
      return;
    }
    const title = cleanText(row.title);
    if (!title) {
      warnings.push(`Row ${i + 1}: no title, skipped`);
      return;
    }
    const m = isObj(row.metadata) ? row.metadata : {};
    const where = `Row ${i + 1} ("${title}")`;
    const imdbData = isObj(m.imdbData) ? m.imdbData : {};
    const duration = m.duration;
    const rec: ImportRecord = {
      sourceTitle: title,
      // Not imdbData.Year: it came from the same title-only lookup as the hint, so
      // a wrong hint would bring its own wrong year as false corroboration.
      sourceYear: cleanYear(m.year),
      sourceDirector: cleanText(m.director),
      sourceRuntimeMin: typeof duration === 'number' ? Math.round(duration) : parseDuration(cleanText(duration)),
      sourceGenre: cleanText(m.genre),
      collection: cleanText(m.collection),
      ...cleanOwned(m.owned),
      imdbIdHint: cleanTconst(imdbData.imdbID),
      source: 'legacy',
    };
    const status = cleanStatus(m.status, where);
    if (status) Object.assign(rec, status);
    const rating = cleanRating(m.rating, where);
    if (rating !== undefined) rec.myRating = rating;
    records.push(rec);
  });
  return { records, warnings };
}
