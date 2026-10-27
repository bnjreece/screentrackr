/** library_stats and watch_stats. */
import { z } from 'zod';
import { LIST_MODES } from '../../core/filters.js';
import { libraryStats, WATCH_STATS_BY, WATCH_STATS_MAX_LIMIT, watchStats, type WatchStats } from '../../core/stats.js';
import { STATUSES } from '../../core/types.js';
import { handler, ok, type RegisterTools } from './common.js';
import { listNameSchema } from './lists.js';

const pairs = (rows: { name: string; films: number; averageRating: number | null }[]) =>
  rows
    .slice(0, 5)
    .map((r) => `${r.name} ${r.films}${r.averageRating !== null ? ` (avg ${r.averageRating.toFixed(1)})` : ''}`)
    .join(', ');

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function watchStatsSummary(s: WatchStats): string {
  const when = `${s.year === null ? 'All time' : `In ${s.year}`}${s.lists ? `, lists ${s.lists.join(', ')}` : ''}`;
  if (s.films === 0 && s.plays === 0) return `${when}: nothing watched yet.`;
  const lines = [`${when}: ${n(s.plays, 'play')} (${s.rewatches === 1 ? '1 rewatch' : `${s.rewatches} rewatches`}) of ${n(s.films, 'film')}.`];
  if (s.undatedFilms) lines.push(`Watched with no known date: ${n(s.undatedFilms, 'film')}.`);
  if (s.byYear.length) lines.push(`By year: ${s.byYear.slice(0, 6).map((y) => `${y.year} ${y.plays} plays/${y.films} films`).join(', ')}`);
  if (s.byDecade.length) lines.push(`By release decade: ${s.byDecade.map((d) => `${d.decade} ${d.films}`).join(', ')}`);
  if (s.byGenre.length) lines.push(`Top genres: ${pairs(s.byGenre)}`);
  if (s.byDirector.length) lines.push(`Top directors: ${pairs(s.byDirector)}`);
  if (s.rated) {
    lines.push(`Rated ${n(s.rated, 'film')}, average ${(s.averageRating as number).toFixed(1)}: ${s.ratings.filter((r) => r.films).map((r) => `${r.rating}: ${r.films}`).join(', ')}`);
  }
  if (s.vsImdb) lines.push(`Versus IMDb over ${n(s.vsImdb.films, 'film')}: yours ${s.vsImdb.myAverage.toFixed(1)}, IMDb ${s.vsImdb.imdbAverage.toFixed(1)}.`);
  return lines.join('\n');
}

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'library_stats',
    {
      title: 'Library stats',
      description:
        'Counts for your library: total, by status, unmatched and ambiguous IMDb matches, top genres, top directors and movies by decade, plus plays this calendar year (playsThisYear) and films you rated (rated). For what you watched when, use watch_stats.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(() => {
      const s = libraryStats(db);
      const text = [
        `${s.total} movies: ${STATUSES.map((st) => `${s.byStatus[st]} ${st}`).join(', ')}.`,
        `Unmatched ${s.unmatched}, ambiguous ${s.ambiguous}.`,
        ...(s.topGenres.length ? [`Top genres: ${s.topGenres.slice(0, 5).map(([g, n]) => `${g} ${n}`).join(', ')}`] : []),
        ...(s.topDirectors.length ? [`Top directors: ${s.topDirectors.slice(0, 5).map(([d, n]) => `${d} ${n}`).join(', ')}`] : []),
        ...(s.byDecade.length ? [`By decade: ${s.byDecade.map(([d, n]) => `${d} ${n}`).join(', ')}`] : []),
        `Plays this year ${s.playsThisYear}, rated films ${s.rated}.`,
      ].join('\n');
      return ok(s, text);
    }),
  );

  server.registerTool(
    'watch_stats',
    {
      title: 'Watch stats',
      description: [
        'What you watched: plays and distinct films per calendar year watched (with rewatches), watched films by release decade, genre and director (count and your average rating), your rating distribution 1 to 10, watched films with no known date, and your average against IMDb\'s over films you rated.',
        'A film is every edition of one IMDb title together; one night recorded by two sources (or on two editions) is one play.',
        'year limits every block to films played in that calendar year. by names the one block to return in full (others are capped); limit caps the genre and director blocks (default 10) or the by block; the rating distribution always has all ten ratings.',
        'lists narrows to films in your lists, by name.',
      ].join(' '),
      inputSchema: {
        year: z.number().int().min(1800).max(2200).optional().describe('Calendar year watched, e.g. 2025.'),
        by: z.enum(WATCH_STATS_BY).optional().describe('The one block to return in full: year, decade, genre, director or rating.'),
        limit: z.number().int().min(1).max(WATCH_STATS_MAX_LIMIT).optional().describe('Rows in the genre and director blocks (default 10), or in the by block (the rating distribution always has all ten ratings).'),
        lists: z.array(listNameSchema).min(1).max(50).optional().describe('Your lists by name (case-insensitive): films in any of them.'),
        listMode: z.enum(LIST_MODES).optional().describe('any (default): in at least one of lists. all: in every one.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      const s = watchStats(db, args);
      return ok(s, watchStatsSummary(s));
    }),
  );
};
