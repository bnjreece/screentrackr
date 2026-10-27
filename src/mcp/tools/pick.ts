/** pick_movie: a random pick within the search filter (core/pick.ts), the same code `screentrackr pick` runs. */
import { PICK_MAX_COUNT, PickSchema, pickMovies, type PickResult } from '../../core/pick.js';
import { handler, ok, type RegisterTools } from './common.js';
import { resultLine } from './search.js';
import { mcpCountry } from './where.js';

function pickText(res: PickResult): string {
  if (res.picks.length === 0) return 'No movie fits these filters.';
  const from = res.priorityOnly ? `Picked from ${res.total} priority movies (${res.matched ?? res.total} match in all):` : `Picked from ${res.total} movies:`;
  return [from, ...res.picks.flatMap((p) => [resultLine(p), `  Where to watch: ${p.whereToWatch}`])].join('\n');
}

const PICK_DESCRIPTION = [
  'Pick a movie to watch at random, within the same filters as search_movies (scope, directors, genres, ratings, runtime, decades, owned, lists, neverSeen, excludeWatched and the rest).',
  'By default it picks from the library movies the user has not watched (status queue, priority or someday); with scope "all", from catalog movies they have not watched or played. anyStatus: true drops that default; status or unwatched replace it.',
  `count is how many distinct movies to pick (1 to ${PICK_MAX_COUNT}, default 1). For another suggestion, call pick_movie again rather than asking for a large count.`,
  'priorityFirst draws from priority movies when any match. seed makes a pick repeatable while the library is unchanged.',
  'Each pick carries whereToWatch, a JustWatch search link (only a link: nothing is fetched). total is how many movies the pick was drawn from; no match gives total 0 and no picks.',
].join(' ');

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'pick_movie',
    {
      title: 'Pick a movie to watch',
      description: PICK_DESCRIPTION,
      // Strict, so a search-only field (sort, limit) is refused rather than silently dropped.
      inputSchema: PickSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      const out = pickMovies(db, args, { country: mcpCountry(db.home) });
      return ok(out, pickText(out));
    }),
  );
};
