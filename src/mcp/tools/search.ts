/** search_movies: the one shared filter (core/filters.ts) over core/search.ts. */
import { ALL_SCOPE_MIN_VOTES, FilterShape } from '../../core/filters.js';
import { searchMovies, type MovieResult } from '../../core/search.js';
import { handler, MAX_TEXT_LINES, ok, yearPart, type RegisterTools } from './common.js';

function resultLine(r: MovieResult): string {
  const parts = [`${r.title}${yearPart(r.year)}`];
  if (r.rating !== null) parts.push(`IMDb ${r.rating.toFixed(1)}`);
  if (r.runtimeMin !== null) parts.push(`${r.runtimeMin} min`);
  if (r.directors.length) parts.push(r.directors.slice(0, 2).join(', '));
  if (r.library) {
    const lib = [`#${r.library.id}`, r.library.status];
    if (r.library.myRating !== null) lib.push(`my ${r.library.myRating}`);
    if (r.library.editions > 1) lib.push(`${r.library.editions} editions`);
    parts.push(`[${lib.join(' ')}]`);
  } else parts.push('[not in library]');
  return `- ${parts.join(' | ')}${r.tconst ? ` ${r.tconst}` : ''}`;
}

export function searchText(total: number, offset: number, results: MovieResult[]): string {
  if (results.length === 0) return total === 0 ? 'No movies match.' : `No results on this page (${total} match in all).`;
  const head = `${total} match. Showing ${offset + 1} to ${offset + results.length}:`;
  const room = MAX_TEXT_LINES - 2;
  const shown = results.slice(0, room).map(resultLine);
  const more = results.length - shown.length;
  return [head, ...shown, ...(more > 0 ? [`... ${more} more in structuredContent.results`] : [])].join('\n');
}

const SEARCH_DESCRIPTION = [
  'Search movies in your library (default) or in the whole IMDb-derived catalog.',
  'Filters combine with OR within a list and AND across fields: directors ["Fincher", "Villeneuve"] with genres ["Thriller"] means (Fincher OR Villeneuve) AND Thriller.',
  'Names match partially and case-insensitively. genreMode "all" requires every listed genre.',
  '"Unwatched" (unwatched: true) means status queue, priority or someday; status lists exact statuses (queue, priority, someday, watched).',
  'scope: "all" searches every movie in the catalog, annotated with your library status; add notInLibrary: true to find movies you do not own, for example "what should I buy or rent" (unwatched may be added and changes nothing, since a movie you do not have is unwatched).',
  'Genres: IMDb tags at most three genres per movie, so a strict genre filter can miss movies people think of as that genre (Se7en is Crime, Drama, Mystery). In library scope, the store genre (Apple TV) of an owned movie also counts; scope "all" uses IMDb genres only. If a combined query returns nothing, say which filter excluded the near misses and offer to relax it.',
  `Ratings (minRating, sort "rating") are IMDb ratings from 0 to 10. minVotes defaults to ${ALL_SCOPE_MIN_VOTES} for scope "all" (so obscure titles do not flood results) and 0 for your library; myRatingMin filters on your own 1 to 10 rating.`,
  'excludeWatched drops movies you have watched or played (any edition) but, unlike notInLibrary, keeps ones you own and have not seen; decades (["1970s", "1980s"]) are ORed together; maxVotes with minVotes finds well-rated, under-seen titles; owned and lists (your own lists by name) narrow to library movies; neverSeen keeps movies with no recorded play and a status other than watched (in scope all, catalog movies you do not have count as never seen).',
  'Runtimes are in minutes. limit defaults to 20 (max 200); page with offset. Library movies that could not be matched to IMDb still appear, using their own title, director, genre and runtime, with matchStatus "unmatched".',
].join(' ');

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'search_movies',
    {
      title: 'Search movies',
      description: SEARCH_DESCRIPTION,
      inputSchema: FilterShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      const out = searchMovies(db, args);
      return ok(out, searchText(out.total, args.offset ?? 0, out.results));
    }),
  );
};
