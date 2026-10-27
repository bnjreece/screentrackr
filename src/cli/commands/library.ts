/** `screentrackr match`: match library items to the catalog, or review the ones that need it. */
import { catalogReady } from '../../core/db.js';
import { rematch } from '../../core/match.js';
import { reviewQueue } from '../../core/movie.js';
import { CatalogMissingError } from '../../core/search.js';
import { bool, type Command } from '../command.js';
import { UserError } from '../context.js';
import { table, votes } from '../format.js';

export const match: Command = {
  name: 'match',
  summary: 'Match library items to the catalog, or review the ones that need it',
  usage: 'match [--review] [--all]',
  details:
    'Without flags, retries the ambiguous and unmatched items. --all rematches everything except manual links.\n--review lists ambiguous and unmatched items with their candidates; fix one with `screentrackr link <id> <tconst>`.',
  options: {
    review: { type: 'boolean', description: 'List the items that need review' },
    all: { type: 'boolean', description: 'Rematch every item except manual links' },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const db = ctx.db();
    if (bool(values, 'review')) {
      if (bool(values, 'all')) throw new UserError('Use either --review or --all, not both');
      const items = reviewQueue(db);
      ctx.emit({ items }, () => {
        if (!items.length) return 'Nothing to review.';
        const out: string[] = [];
        for (const i of items) {
          const src = [i.sourceYear, i.sourceRuntimeMin ? `${i.sourceRuntimeMin} min` : null, i.sourceDirector].filter(Boolean).join(', ');
          out.push(`${i.id}  ${i.sourceTitle}${src ? ` (${src})` : ''}  [${i.matchStatus}]`);
          if (i.candidates.length) {
            out.push(
              table(
                i.candidates,
                [
                  { header: '    TCONST', get: (c) => `    ${c.tconst}` },
                  { header: 'TITLE', get: (c) => c.title, flex: true, min: 12 },
                  { header: 'YEAR', get: (c) => (c.year === null ? '' : String(c.year)), align: 'right' },
                  { header: 'MIN', get: (c) => (c.runtimeMin === null ? '' : String(c.runtimeMin)), align: 'right' },
                  { header: 'DIRECTOR', get: (c) => c.directors.join(', '), flex: true, min: 10 },
                  { header: 'VOTES', get: (c) => votes(c.votes), align: 'right' },
                ],
                { width: ctx.width, color: ctx.color },
              ),
            );
          }
          out.push('');
        }
        out.push(`${items.length} to review. Link one with \`screentrackr link <id> <tconst>\`.`);
        return out.join('\n');
      });
      return;
    }
    if (!catalogReady(db)) throw new CatalogMissingError();
    const res = rematch(db, { onlyUnresolved: !bool(values, 'all') });
    ctx.emit(res, () => `Matched ${res.matched}, ambiguous ${res.ambiguous}, unmatched ${res.unmatched}.`);
  },
};
