/** Library-wide commands: match, stats, export. */
import { safeJson } from '../sanitize.js';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { catalogReady } from '../../core/db.js';
import { exportLibrary } from '../../core/export.js';
import { rematch } from '../../core/match.js';
import { reviewQueue } from '../../core/movie.js';
import { CatalogMissingError } from '../../core/search.js';
import { libraryStats } from '../../core/stats.js';
import { bool, str, type Command } from '../command.js';
import { UserError } from '../context.js';
import { keyValues, table, votes } from '../format.js';

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

export const exportCmd: Command = {
  name: 'export',
  summary: 'Export your library as ScreenTrackr JSON v1',
  usage: 'export [--out <file>]',
  details: 'Prints to stdout unless --out is given.',
  options: {
    out: { type: 'string', short: 'o', value: '<file>', description: 'Write to this file instead of stdout' },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const data = exportLibrary(ctx.db());
    const out = str(values, 'out');
    if (!out) {
      ctx.out(safeJson(data));
      return;
    }
    const path = resolve(out);
    // Write an owner-only temp file beside the destination, then rename it over
    // the destination: an existing file never keeps wider permissions, and a
    // failed write never leaves a half-written export in its place.
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new UserError(`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    ctx.emit({ path, items: data.items.length }, () => `Exported ${data.items.length} items to ${path}`);
  },
};
