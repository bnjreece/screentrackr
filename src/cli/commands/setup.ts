import { IMDB_CREDIT, runSetup } from '../../core/setup.js';
import { bool, type Command } from '../command.js';
import { UserError } from '../context.js';

export { IMDB_CREDIT };

export const setup: Command = {
  name: 'setup',
  summary: 'Download the IMDb datasets and build the local movie catalog',
  usage: 'setup [--refresh] [--no-cast] [--include-tv-movies]',
  details:
    'Downloads five IMDb dataset files (about 1 GB in total) into the cache, then builds the catalog.\nCached files are reused unless --refresh is given. Afterwards it refreshes automatic matches; your statuses, ratings, notes and manual links are never changed.',
  options: {
    refresh: { type: 'boolean', description: 'Check IMDb for newer dataset files and rebuild' },
    'with-cast': { type: 'boolean', description: 'Load top-billed cast (the default)' },
    'no-cast': { type: 'boolean', description: 'Skip cast, for a faster and smaller build' },
    'include-tv-movies': { type: 'boolean', description: 'Also include TV movies' },
  },
  async run(ctx, _pos, values) {
    if (bool(values, 'with-cast') && bool(values, 'no-cast')) throw new UserError('Use either --with-cast or --no-cast, not both');
    const db = ctx.db();
    const progress = (msg: string) => ctx.log(msg);
    const result = await runSetup(db, {
      refresh: bool(values, 'refresh'),
      withCast: !bool(values, 'no-cast'),
      includeTvMovies: bool(values, 'include-tv-movies'),
      onProgress: progress,
    });
    const { matching } = result;
    const stats = result.catalog as NonNullable<typeof result.catalog>; // Always built: no matchOnly here.
    ctx.emit(result, () =>
      [
        `Catalog built: ${stats.movies.toLocaleString('en-US')} movies, ${stats.rated.toLocaleString('en-US')} rated, ${stats.people.toLocaleString('en-US')} people, ${stats.castRows.toLocaleString('en-US')} cast credits in ${stats.seconds.toFixed(1)}s.`,
        `Library matching: ${matching.matched} matched, ${matching.ambiguous} ambiguous, ${matching.unmatched} unmatched.`,
        '',
        IMDB_CREDIT,
      ].join('\n'),
    );
  },
};
