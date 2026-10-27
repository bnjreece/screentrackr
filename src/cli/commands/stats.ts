/** `screentrackr stats`: library counts and a short watching block; `stats --watched`: the full watch report. */
import { libraryStats, WATCH_STATS_BY, watchStats, watchSummary, type LibraryStats, type NamedRow, type WatchStats, type WatchStatsBy, type WatchSummary } from '../../core/stats.js';
import { toInt } from '../args.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError } from '../context.js';
import { keyValues, table } from '../format.js';

const NOTHING = 'nothing yet';
const BAR = '█';
const MAX_BAR = 40;

type TableOpts = { width?: number; color?: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const avg = (n: number | null) => (n === null ? '' : n.toFixed(1));
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
const rewatches = (n: number) => (n === 1 ? '1 rewatch' : `${n} rewatches`);

function summaryLines(w: WatchSummary): [string, string | number][] {
  if (w.playsThisYear === 0 && w.playsLastYear === 0 && w.rated === 0) return [['Watching', NOTHING]];
  return [
    [`Plays in ${w.year}`, `${w.playsThisYear}${w.rewatchesThisYear ? ` (${rewatches(w.rewatchesThisYear)})` : ''}`],
    [`Films in ${w.year}`, w.filmsThisYear],
    [`Plays in ${w.year - 1}`, w.playsLastYear],
    ['Rated', w.rated ? `${plural(w.rated, 'film')}, average ${avg(w.averageRating)}` : NOTHING],
  ];
}

export function libraryStatsText(s: LibraryStats, w: WatchSummary): string {
  const list = (pairs: [string, number][]) => pairs.map(([k, v]) => `${k} ${v}`).join(', ');
  return keyValues([
    ['Movies', s.total],
    ['By status', Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['Ambiguous', s.ambiguous],
    ['Unmatched', s.unmatched],
    ['Top genres', list(s.topGenres)],
    ['Top directors', list(s.topDirectors)],
    ['By decade', list(s.byDecade)],
    ...summaryLines(w),
  ]);
}

function scope(s: WatchStats): string {
  const when = s.year === null ? 'all time' : `in ${s.year}`;
  return s.lists ? `${when}, in ${s.lists.length === 1 ? 'the list' : 'the lists'} ${s.lists.map((l) => `"${l}"`).join(', ')}` : when;
}

function headline(s: WatchStats): string {
  return keyValues([
    ['Plays', s.rewatches ? `${s.plays}, ${rewatches(s.rewatches)}` : s.plays],
    ['Films', s.films],
    ['No known date', s.undatedFilms ? plural(s.undatedFilms, 'film') : null],
    ['Rated', s.rated ? `${plural(s.rated, 'film')}, average ${avg(s.averageRating)}` : NOTHING],
    [
      'Versus IMDb',
      s.vsImdb
        ? `${signed(s.vsImdb.difference)} (yours ${avg(s.vsImdb.myAverage)}, IMDb ${avg(s.vsImdb.imdbAverage)}, over ${plural(s.vsImdb.films, 'film')})`
        : null,
    ],
  ]);
}

function block(title: string, body: string | null): string {
  return body === null ? `${title}: ${NOTHING}` : `${title}\n${body}`;
}

function namedTable(rows: NamedRow[], header: string, opts: TableOpts): string | null {
  if (rows.length === 0) return null;
  return table(
    rows,
    [
      { header, get: (r) => r.name, flex: true, min: 10 },
      { header: 'FILMS', get: (r) => String(r.films), align: 'right' },
      { header: 'RATED', get: (r) => String(r.rated), align: 'right' },
      { header: 'AVERAGE', get: (r) => avg(r.averageRating), align: 'right' },
    ],
    opts,
  );
}

function ratingChart(s: WatchStats, width: number | undefined): string | null {
  if (s.rated === 0) return null;
  const max = Math.max(...s.ratings.map((r) => r.films));
  const room = Math.max(1, Math.min(MAX_BAR, (width ?? 80) - 4 - 2 - String(max).length - 1));
  return [...s.ratings]
    .reverse()
    .map((r) => {
      const len = r.films === 0 ? 0 : Math.max(1, Math.round((r.films / max) * room));
      return `${String(r.rating).padStart(2)}  ${BAR.repeat(len)}${len ? ' ' : ''}${r.films}`;
    })
    .join('\n');
}

function blocks(s: WatchStats, opts: TableOpts): Record<WatchStatsBy, () => string> {
  return {
    year: () =>
      block(
        'By year watched',
        s.byYear.length
          ? table(
              s.byYear,
              [
                { header: 'YEAR', get: (r) => String(r.year) },
                { header: 'PLAYS', get: (r) => String(r.plays), align: 'right' },
                { header: 'FILMS', get: (r) => String(r.films), align: 'right' },
                { header: 'REWATCHES', get: (r) => String(r.rewatches), align: 'right' },
              ],
              opts,
            )
          : null,
      ),
    decade: () =>
      block(
        'By release decade',
        s.byDecade.length
          ? table(
              s.byDecade,
              [
                { header: 'DECADE', get: (r) => r.decade },
                { header: 'FILMS', get: (r) => String(r.films), align: 'right' },
              ],
              opts,
            )
          : null,
      ),
    genre: () => block(s.by === 'genre' ? 'By genre' : 'Top genres', namedTable(s.byGenre, 'GENRE', opts)),
    director: () => block(s.by === 'director' ? 'By director' : 'Top directors', namedTable(s.byDirector, 'DIRECTOR', opts)),
    rating: () => block('Your ratings', ratingChart(s, opts.width)),
  };
}

/** The `stats --watched` report as text. `width` is the terminal width (80 when unknown, for the chart). */
export function watchStatsText(s: WatchStats, opts: TableOpts = {}): string {
  const title = `Watched, ${scope(s)}`;
  if (s.films === 0 && s.plays === 0) return `${title}: ${NOTHING}.`;
  const b = blocks(s, opts);
  if (s.by) return `${title}\n\n${b[s.by]()}`;
  return [`${title}\n${headline(s)}`, ...WATCH_STATS_BY.map((k) => b[k]())].join('\n\n');
}

export const stats: Command = {
  name: 'stats',
  summary: 'Library counts, and with --watched what you watched by year, decade, genre, director and rating',
  usage: 'stats [--watched] [--year <yyyy>] [--by <year|decade|genre|director|rating>] [-n <n>] [--list <name>]... [--all-lists]',
  details: [
    'Plain `stats` counts your library and adds a short block about this year.',
    '--watched is the full report: plays and films per year watched (with rewatches), watched films by release decade, genre and director',
    'with your average rating, and how you rated them. A film is every edition of one IMDb title together, and one night recorded by two',
    'sources is one play. --year, --by, -n and --list imply --watched.',
  ].join('\n'),
  options: {
    watched: { type: 'boolean', description: 'The full watch report' },
    year: { type: 'string', value: '<yyyy>', description: 'Only films you played in this calendar year' },
    by: { type: 'string', value: `<${WATCH_STATS_BY.join('|')}>`, description: 'Print this one table in full' },
    limit: { type: 'string', short: 'n', value: '<n>', description: 'Rows in the genre and director tables (default 10), or in the --by table' },
    list: { type: 'string', multiple: true, value: '<name>', description: 'Only films in this list (repeatable; any of them unless --all-lists)' },
    'all-lists': { type: 'boolean', description: 'Require every --list' },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const year = toInt('year', str(values, 'year'));
    const by = str(values, 'by');
    const limit = toInt('limit', str(values, 'limit'));
    const lists = strs(values, 'list');
    const allLists = bool(values, 'all-lists');
    if (by !== undefined && !(WATCH_STATS_BY as readonly string[]).includes(by)) {
      throw new UserError(`--by expects one of ${WATCH_STATS_BY.join(', ')} (got "${by}")`);
    }
    if (allLists && !lists) throw new UserError('--all-lists needs at least one --list');
    const watched = bool(values, 'watched') || year !== undefined || by !== undefined || limit !== undefined || lists !== undefined;
    const db = ctx.db();
    if (!watched) {
      const s = libraryStats(db);
      const w = watchSummary(db);
      ctx.emit({ ...s, watching: w }, () => libraryStatsText(s, w));
      return;
    }
    const s = watchStats(db, {
      ...(year !== undefined ? { year } : {}),
      ...(by !== undefined ? { by: by as WatchStatsBy } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(lists ? { lists, listMode: allLists ? 'all' : 'any' } : {}),
    });
    ctx.emit(s, () => watchStatsText(s, { width: ctx.width, color: ctx.color }));
  },
};
