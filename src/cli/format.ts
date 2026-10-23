import { cleanCell } from './sanitize.js';
/**
 * Hand-rolled plain-text output: aligned tables truncated to the terminal
 * width, and key/value blocks. Styling (bold headers) only on a color TTY, so
 * pipes and files never get ANSI codes.
 */
import type { MovieResult } from '../core/search.js';
import type { LibraryItem, Status, WatchedEra } from '../core/types.js';

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: 'left' | 'right';
  /** Flexible columns shrink to fit the terminal; fixed ones keep their width. */
  flex?: boolean;
  /** Never shrink a flexible column below this. */
  min?: number;
}

const GAP = '  ';
const ELLIPSIS = '…';

export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}${ELLIPSIS}`;
}

function pad(s: string, width: number, align: 'left' | 'right'): string {
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

function bold(s: string, color: boolean): string {
  return color ? `\u001b[1m${s}\u001b[22m` : s;
}

/** One cell value with control characters flattened, so a title can't break the layout. */
function clean(s: string): string {
  return cleanCell(s);
}

/**
 * Render rows as an aligned table with a header row. When `width` is given,
 * flexible columns are shrunk (largest first) until the table fits.
 */
export function table<T>(rows: T[], columns: Column<T>[], opts: { width?: number; color?: boolean } = {}): string {
  const cells = rows.map((r) => columns.map((c) => clean(c.get(r))));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => (row[i] as string).length)));

  if (opts.width !== undefined) {
    const total = () => widths.reduce((a, b) => a + b, 0) + GAP.length * (columns.length - 1);
    let over = total() - opts.width;
    while (over > 0) {
      let widest = -1;
      columns.forEach((c, i) => {
        if (!c.flex) return;
        const floor = Math.max(c.min ?? 6, c.header.length);
        if ((widths[i] as number) > floor && (widest < 0 || (widths[i] as number) > (widths[widest] as number))) widest = i;
      });
      if (widest < 0) break;
      widths[widest] = (widths[widest] as number) - 1;
      over--;
    }
  }

  const line = (vals: string[], header: boolean) =>
    vals
      .map((v, i) => {
        const w = widths[i] as number;
        const col = columns[i] as Column<T>;
        const cell = pad(truncate(v, w), w, col.align ?? 'left');
        return header ? bold(cell, opts.color ?? false) : cell;
      })
      .join(GAP)
      .trimEnd();

  return [line(columns.map((c) => c.header), true), ...cells.map((row) => line(row, false))].join('\n');
}

/** Aligned `key  value` lines, skipping empty values. */
export function keyValues(pairs: [string, string | number | null | undefined][]): string {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const w = Math.max(0, ...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${k.padEnd(w)}  ${clean(String(v))}`).join('\n');
}

export function statusLabel(status: Status, era: WatchedEra | null): string {
  return era ? `${status} (${era})` : status;
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return '';
  return digits ? v.toFixed(digits) : String(v);
}

export function votes(v: number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
}

export function movieTable(results: MovieResult[], opts: { width?: number; color?: boolean }): string {
  return table(
    results,
    [
      { header: 'ID', get: (r) => (r.library ? String(r.library.id) : ''), align: 'right' },
      { header: 'TITLE', get: (r) => r.title, flex: true, min: 12 },
      { header: 'YEAR', get: (r) => num(r.year), align: 'right' },
      { header: 'MIN', get: (r) => num(r.runtimeMin), align: 'right' },
      { header: 'RATING', get: (r) => num(r.rating, 1), align: 'right' },
      { header: 'VOTES', get: (r) => votes(r.votes), align: 'right' },
      { header: 'DIRECTOR', get: (r) => r.directors.join(', '), flex: true, min: 10 },
      { header: 'GENRES', get: (r) => r.genres.join(', '), flex: true, min: 8 },
      {
        header: 'STATUS',
        get: (r) => {
          if (!r.library) return '';
          const parts = [statusLabel(r.library.status, r.library.watchedEra)];
          if (r.library.myRating !== null) parts.push(`mine ${r.library.myRating}`);
          if (r.library.editions > 1) parts.push(`x${r.library.editions}`);
          if (r.library.matchStatus === 'unmatched' || r.library.matchStatus === 'ambiguous') parts.push(r.library.matchStatus);
          return parts.join(', ');
        },
        flex: true,
        min: 8,
      },
    ],
    opts,
  );
}

/** One line per item, for listing candidates in an error. */
export function itemLine(i: LibraryItem): string {
  const bits = [i.sourceYear ? String(i.sourceYear) : null, i.sourceRuntimeMin ? `${i.sourceRuntimeMin} min` : null, i.tconst, statusLabel(i.status, i.watchedEra)]
    .filter(Boolean)
    .join(', ');
  return `  ${i.id}  ${i.sourceTitle}${bits ? ` (${bits})` : ''}`;
}
