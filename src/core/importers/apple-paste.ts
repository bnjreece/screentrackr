/**
 * Tab-separated text copied from the Apple TV app's list view.
 *
 * The usual layout has no header and seven columns: title, (empty), duration,
 * director, collection, genre, owned. When the first line is a header (it
 * names a title column), columns are found by name instead, in any order.
 */
import { parseDuration } from '../match.js';
import { cleanOwned, cleanText, cleanYear, ImportError, type ImportRecord, type ParsedImport } from './common.js';

type Field = 'title' | 'duration' | 'director' | 'collection' | 'genre' | 'owned' | 'year';

const POSITIONAL: (Field | null)[] = ['title', null, 'duration', 'director', 'collection', 'genre', 'owned'];

const HEADER_NAMES: Record<string, Field> = {
  title: 'title',
  name: 'title',
  duration: 'duration',
  time: 'duration',
  runtime: 'duration',
  director: 'director',
  directors: 'director',
  collection: 'collection',
  genre: 'genre',
  genres: 'genre',
  owned: 'owned',
  year: 'year',
  'release date': 'year',
};

function headerLayout(cells: string[]): (Field | null)[] | null {
  const layout = cells.map((c) => HEADER_NAMES[c.trim().toLowerCase()] ?? null);
  return layout.includes('title') ? layout : null;
}

export function parseApplePaste(text: string): ParsedImport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new ImportError('The paste is empty');

  const first = (lines[0] as string).split('\t');
  const header = headerLayout(first);
  const layout = header ?? POSITIONAL;
  const body = header ? lines.slice(1) : lines;

  const records: ImportRecord[] = [];
  const warnings: string[] = [];
  body.forEach((line, i) => {
    const cells = line.split('\t');
    const get = (f: Field): string | undefined => {
      const idx = layout.indexOf(f);
      return idx === -1 ? undefined : cells[idx];
    };
    const title = cleanText(get('title'));
    if (!title) {
      warnings.push(`Line ${i + 1 + (header ? 1 : 0)}: no title, skipped`);
      return;
    }
    const { owned, sourceOwnedRaw } = cleanOwned(get('owned'));
    records.push({
      sourceTitle: title,
      sourceYear: cleanYear(get('year')),
      sourceDirector: cleanText(get('director')),
      sourceRuntimeMin: parseDuration(get('duration') ?? null),
      sourceGenre: cleanText(get('genre')),
      collection: cleanText(get('collection')),
      owned,
      sourceOwnedRaw,
      source: 'paste',
    });
  });
  return { records, warnings };
}
