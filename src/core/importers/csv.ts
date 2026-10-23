/**
 * CSV with a header row. Recognized columns (case-insensitive): title, year,
 * director, status, rating, imdb_id, plus optional runtime, genre, collection,
 * owned and watched_at. Unknown columns are ignored. Quoted fields follow RFC 4180.
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

/** Split CSV text into rows of cells. Handles quotes, doubled quotes and newlines inside quotes. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/^\uFEFF/, '');
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
    i++;
  }
  if (quoted) throw new ImportError('CSV has an unclosed quote');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMNS: Record<string, string> = {
  title: 'title',
  name: 'title',
  year: 'year',
  director: 'director',
  directors: 'director',
  status: 'status',
  rating: 'rating',
  my_rating: 'rating',
  imdb_id: 'imdb_id',
  imdbid: 'imdb_id',
  tconst: 'imdb_id',
  runtime: 'runtime',
  runtime_min: 'runtime',
  duration: 'runtime',
  genre: 'genre',
  genres: 'genre',
  collection: 'collection',
  owned: 'owned',
  watched_at: 'watched_at',
};

export function parseCsv(text: string): ParsedImport {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) throw new ImportError('The CSV is empty');
  const cols = header.map((h) => COLUMNS[h.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null);
  if (!cols.includes('title')) throw new ImportError('The CSV header needs a "title" column');

  const records: ImportRecord[] = [];
  const warnings: string[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (c: string): string | undefined => {
      const idx = cols.indexOf(c);
      return idx === -1 ? undefined : cells[idx];
    };
    const title = cleanText(get('title'));
    if (!title) {
      warnings.push(`Line ${line}: no title, skipped`);
      return;
    }
    const where = `Line ${line} ("${title}")`;
    const rec: ImportRecord = {
      sourceTitle: title,
      sourceYear: cleanYear(get('year')),
      sourceDirector: cleanText(get('director')),
      sourceRuntimeMin: parseDuration(get('runtime') ?? null),
      sourceGenre: cleanText(get('genre')),
      collection: cleanText(get('collection')),
      imdbIdHint: cleanTconst(get('imdb_id')),
      source: 'csv',
    };
    if (cols.includes('owned')) Object.assign(rec, cleanOwned(get('owned')));
    const status = cleanStatus(get('status'), where);
    if (status) Object.assign(rec, status);
    const rating = cleanRating(get('rating'), where);
    if (rating !== undefined) rec.myRating = rating;
    const watchedAt = cleanText(get('watched_at'));
    if (watchedAt) rec.watchedAt = watchedAt;
    records.push(rec);
  });
  return { records, warnings };
}
