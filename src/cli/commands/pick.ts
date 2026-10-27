/** `screentrackr pick`: what to watch tonight, at random within the search filters. */
import { pickMovies, PICK_MAX_COUNT, type PickResult } from '../../core/pick.js';
import { toInt } from '../args.js';
import { bool, str, type Command } from '../command.js';
import { UserError } from '../context.js';
import { movieTable } from '../format.js';
import { FILTER_OPTIONS, filterFromFlags } from './search.js';
import { cliCountry } from './where.js';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function pickText(res: PickResult, opts: { width?: number | undefined; color: boolean }): string {
  if (res.picks.length === 0) return 'No movie fits these filters.';
  const from = res.priorityOnly
    ? `Picked from ${plural(res.total, 'priority movie')} (${res.matched ?? res.total} match in all).`
    : `Picked from ${plural(res.total, 'movie')}.`;
  const links = res.picks.map((p) => `  ${p.title}${p.year !== null ? ` (${p.year})` : ''}  ${p.whereToWatch}`);
  return [movieTable(res.picks, { width: opts.width, color: opts.color }), '', from, 'Where to watch:', ...links].join('\n');
}

export const pick: Command = {
  name: 'pick',
  summary: 'Pick a movie to watch from your library, at random within filters',
  usage: 'pick [filters] [-n <1-10>] [--seed <n>] [--priority-first] [--any-status]',
  details:
    'Takes every search filter. By default it picks from your unwatched library movies (queue, priority or someday); with --scope all, from catalog movies you have not watched.\nExamples:\n  screentrackr pick --owned --max-runtime 110 --genre Horror --decade 1980s -n 3\n  screentrackr pick --scope all --min-rating 7.5 --min-votes 20000 --exclude-watched\nThe same --seed over an unchanged library gives the same picks.',
  options: {
    ...FILTER_OPTIONS,
    count: { type: 'string', short: 'n', value: `<1-${PICK_MAX_COUNT}>`, description: 'How many distinct movies to pick (default 1)' },
    seed: { type: 'string', value: '<n>', description: 'Repeatable picks (0 to 4294967295)' },
    'priority-first': { type: 'boolean', description: 'Pick from priority movies when any match' },
    'any-status': { type: 'boolean', description: 'Include watched movies too' },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}". Use --text to match titles.`);
    const input: Record<string, unknown> = filterFromFlags(values);
    const count = toInt('count', str(values, 'count'));
    const seed = toInt('seed', str(values, 'seed'));
    if (count !== undefined) input.count = count;
    if (seed !== undefined) input.seed = seed;
    if (bool(values, 'priority-first')) input.priorityFirst = true;
    if (bool(values, 'any-status')) input.anyStatus = true;
    const { country } = cliCountry(ctx);
    const res = pickMovies(ctx.db(), input, { country });
    ctx.emit(res, () => pickText(res, { width: ctx.width, color: ctx.color }));
  },
};
