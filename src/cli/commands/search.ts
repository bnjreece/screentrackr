import { GENRE_MODES, LIST_MODES, ORDERS, SCOPES, SORTS, type FilterInput } from '../../core/filters.js';
import { searchMovies } from '../../core/search.js';
import { STATUSES } from '../../core/types.js';
import { toInt, toNumber, toYearRange } from '../args.js';
import { bool, str, strs, type Command, type OptionSpec, type Values } from '../command.js';
import { UserError } from '../context.js';
import { movieTable } from '../format.js';

/** Map search flags onto the shared filter object. Validation is left to FilterSchema. */
export function filterFromFlags(values: Values): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const set = (k: keyof FilterInput, v: unknown) => {
    if (v !== undefined) f[k] = v;
  };
  set('scope', str(values, 'scope'));
  set('directors', strs(values, 'director'));
  set('actors', strs(values, 'actor'));
  set('genres', strs(values, 'genre'));
  if (bool(values, 'all-genres')) f.genreMode = 'all' satisfies (typeof GENRE_MODES)[number];
  set('minRating', toNumber('min-rating', str(values, 'min-rating')));
  set('minVotes', toInt('min-votes', str(values, 'min-votes')));
  set('minRuntime', toInt('min-runtime', str(values, 'min-runtime')));
  set('maxRuntime', toInt('max-runtime', str(values, 'max-runtime')));

  const year = str(values, 'year');
  const yearFrom = toInt('year-from', str(values, 'year-from'));
  const yearTo = toInt('year-to', str(values, 'year-to'));
  if (year !== undefined && (yearFrom !== undefined || yearTo !== undefined)) {
    throw new UserError('Use either --year or --year-from/--year-to, not both');
  }
  if (year !== undefined) {
    const r = toYearRange(year);
    set('yearFrom', r.from);
    set('yearTo', r.to);
  }
  set('yearFrom', yearFrom);
  set('yearTo', yearTo);

  set('status', strs(values, 'status'));
  if (bool(values, 'unwatched')) f.unwatched = true;
  set('myRatingMin', toInt('my-rating-min', str(values, 'my-rating-min')));
  if (bool(values, 'not-in-library')) f.notInLibrary = true;
  if (bool(values, 'owned') && bool(values, 'not-owned')) throw new UserError('Use either --owned or --not-owned, not both');
  if (bool(values, 'owned')) f.owned = true;
  if (bool(values, 'not-owned')) f.owned = false;
  set('decades', strs(values, 'decade'));
  set('lists', strs(values, 'list'));
  if (bool(values, 'all-lists')) {
    if (!strs(values, 'list')) throw new UserError('--all-lists needs at least one --list');
    f.listMode = 'all' satisfies (typeof LIST_MODES)[number];
  }
  if (bool(values, 'never-seen')) f.neverSeen = true;
  if (bool(values, 'exclude-watched')) f.excludeWatched = true;
  set('maxVotes', toInt('max-votes', str(values, 'max-votes')));
  set('text', str(values, 'text'));
  set('sort', str(values, 'sort'));
  set('order', str(values, 'order'));
  set('limit', toInt('limit', str(values, 'limit')));
  set('offset', toInt('offset', str(values, 'offset')));
  return f;
}

/** The filter flags, shared by search, pick and any command that takes search filters. */
export const FILTER_OPTIONS: Record<string, OptionSpec> = {
  scope: { type: 'string', value: `<${SCOPES.join('|')}>`, description: 'library (default) or all (the whole catalog)' },
  director: { type: 'string', multiple: true, short: 'd', value: '<name>', description: 'Director name, partial, case-insensitive (repeatable)' },
  actor: { type: 'string', multiple: true, short: 'a', value: '<name>', description: 'Top-billed cast name (repeatable)' },
  genre: { type: 'string', multiple: true, short: 'g', value: '<genre>', description: 'Genre (repeatable; any of them unless --all-genres)' },
  'all-genres': { type: 'boolean', description: 'Require every --genre' },
  'min-rating': { type: 'string', value: '<n>', description: 'Minimum IMDb rating' },
  'min-votes': { type: 'string', value: '<n>', description: 'Minimum IMDb votes (default 1000 for --scope all)' },
  'max-votes': { type: 'string', value: '<n>', description: 'Maximum IMDb votes, for under-seen titles' },
  'min-runtime': { type: 'string', value: '<min>', description: 'Minimum runtime in minutes' },
  'max-runtime': { type: 'string', value: '<min>', description: 'Maximum runtime in minutes' },
  year: { type: 'string', value: '<yyyy|yyyy-yyyy>', description: 'A year or a range, e.g. 1990-1999' },
  'year-from': { type: 'string', value: '<yyyy>', description: 'Earliest year' },
  'year-to': { type: 'string', value: '<yyyy>', description: 'Latest year' },
  decade: { type: 'string', multiple: true, value: '<1980s>', description: 'Release decade (repeatable; any of them)' },
  status: { type: 'string', multiple: true, value: `<${STATUSES.join('|')}>`, description: 'Library status (repeatable)' },
  unwatched: { type: 'boolean', description: 'Only queue, priority or someday' },
  'my-rating-min': { type: 'string', value: '<1-10>', description: 'Minimum personal rating' },
  owned: { type: 'boolean', description: 'Only library movies you own' },
  'not-owned': { type: 'boolean', description: 'Only library movies you do not own' },
  list: { type: 'string', multiple: true, value: '<name>', description: 'In your list (repeatable; any of them unless --all-lists)' },
  'all-lists': { type: 'boolean', description: 'Require every --list' },
  'never-seen': { type: 'boolean', description: 'No recorded play and a status other than watched' },
  'exclude-watched': { type: 'boolean', description: 'Leave out movies you have watched or played (any edition); owned unwatched ones stay' },
  'not-in-library': { type: 'boolean', description: 'With --scope all: only movies you do not have' },
  text: { type: 'string', short: 't', value: '<words>', description: 'Title search' },
};

/** Paging and order, for search only (pick draws at random). */
const PAGE_OPTIONS: Record<string, OptionSpec> = {
  sort: { type: 'string', value: `<${SORTS.join('|')}>`, description: 'Sort field (default rating)' },
  order: { type: 'string', value: `<${ORDERS.join('|')}>`, description: 'Sort direction' },
  limit: { type: 'string', short: 'n', value: '<n>', description: 'Results per page (default 20, max 200)' },
  offset: { type: 'string', value: '<n>', description: 'Skip this many results' },
};

export const search: Command = {
  name: 'search',
  summary: 'Search your library, or every movie with --scope all',
  usage: 'search [filters]',
  details:
    'Repeat a flag to OR its values (--director A --director B). Different flags are ANDed.\n"Unwatched" means queue, priority or someday.\nExample: screentrackr search --director Fincher --director Villeneuve --genre Thriller --min-rating 7.5 --unwatched --max-runtime 120\nDiscovery: screentrackr search --scope all --genre Horror --decade 1970s --decade 1980s --min-rating 7.3 --min-votes 25000 --exclude-watched --sort votes',
  options: { ...FILTER_OPTIONS, ...PAGE_OPTIONS },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}". Use --text to search titles.`);
    const filter = filterFromFlags(values);
    const res = searchMovies(ctx.db(), filter);
    ctx.emit(res, () => {
      if (res.results.length === 0) return res.total ? `No results on this page (${res.total} in total).` : 'No movies match.';
      const offset = typeof filter.offset === 'number' ? filter.offset : 0;
      const range = `${offset + 1}-${offset + res.results.length}`;
      return `${movieTable(res.results, { width: ctx.width, color: ctx.color })}\n\nShowing ${range} of ${res.total}.`;
    });
  },
};
