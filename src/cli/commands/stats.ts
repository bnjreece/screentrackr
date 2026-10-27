/** `screentrackr stats`: library counts (and, in 0.4.0, watch stats). */
import { libraryStats } from '../../core/stats.js';
import type { Command } from '../command.js';
import { UserError } from '../context.js';
import { keyValues } from '../format.js';

export const stats: Command = {
  name: 'stats',
  summary: 'Library counts by status, genre, decade and director',
  usage: 'stats',
  options: {},
  run(ctx, pos) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const s = libraryStats(ctx.db());
    ctx.emit(s, () => {
      const list = (pairs: [string, number][]) => pairs.map(([k, v]) => `${k} ${v}`).join(', ');
      return keyValues([
        ['Movies', s.total],
        ['By status', Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')],
        ['Ambiguous', s.ambiguous],
        ['Unmatched', s.unmatched],
        ['Top genres', list(s.topGenres)],
        ['Top directors', list(s.topDirectors)],
        ['By decade', list(s.byDecade)],
      ]);
    });
  },
};
