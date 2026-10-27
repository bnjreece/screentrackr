/** library_stats (and, in 0.4.0, watch_stats). */
import { libraryStats } from '../../core/stats.js';
import { STATUSES } from '../../core/types.js';
import { handler, ok, type RegisterTools } from './common.js';

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'library_stats',
    {
      title: 'Library stats',
      description: 'Counts for your library: total, by status, unmatched and ambiguous IMDb matches, top genres, top directors and movies by decade.',
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
      ].join('\n');
      return ok(s, text);
    }),
  );
};
