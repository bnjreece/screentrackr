/** Commands that read or write single library items: show, add, set, remove, link. */
import { createInterface } from 'node:readline/promises';
import { catalogReady, type Db } from '../../core/db.js';
import { addFromCatalog, getItem, linkItem, removeItem, resolveRef, updateItemDetailed, type ItemPatch } from '../../core/library.js';
import { listsOfItem } from '../../core/lists.js';
import { findCatalogByTitle, getCatalogMovie, type CatalogMovie } from '../../core/movie.js';
import { CatalogMissingError } from '../../core/search.js';
import { STATUSES, WATCHED_ERAS, type LibraryItem, type Status, type WatchedEra } from '../../core/types.js';
import { countPlays, deriveRewatch, viewingsByItem, viewingsOf, type Viewing } from '../../core/viewings.js';
import { toId, toInt } from '../args.js';
import { bool, str, type Command } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { itemLine, keyValues, num, statusLabel, votes } from '../format.js';

const TCONST = /^tt\d{7,}$/i;

function candidatesError(what: string, items: LibraryItem[], hint: string): UserError {
  return new UserError(`"${what}" matches ${items.length} library items. ${hint}\n${items.map(itemLine).join('\n')}`, {
    candidates: items.map((i) => ({ id: i.id, title: i.sourceTitle, year: i.sourceYear, runtimeMin: i.sourceRuntimeMin, tconst: i.tconst, status: i.status })),
  });
}

/** Resolve a reference to exactly one library item, or fail listing what it matched. */
function oneItem(db: Db, ref: string, hint: string): LibraryItem {
  const r = resolveRef(db, ref);
  if (r.kind === 'one') return r.item;
  if (r.kind === 'many') throw candidatesError(ref, r.items, hint);
  throw new UserError(`No library item matches "${ref}"`);
}

function movieLines(m: CatalogMovie): [string, string | number | null][] {
  return [
    ['IMDb', m.tconst],
    ['Title', m.title],
    ['Original title', m.originalTitle],
    ['Year', m.year],
    ['Runtime', m.runtimeMin !== null ? `${m.runtimeMin} min` : null],
    ['Genres', m.genres.join(', ')],
    ['Directors', m.directors.join(', ')],
    ['Cast', m.cast.join(', ')],
    ['Rating', m.rating !== null ? `${num(m.rating, 1)} (${votes(m.votes)} votes)` : null],
  ];
}

function itemLines(i: LibraryItem): [string, string | number | null][] {
  return [
    ['Library id', i.id],
    ['Source title', i.sourceTitle],
    ['Source year', i.sourceYear],
    ['Source director', i.sourceDirector],
    ['Source runtime', i.sourceRuntimeMin !== null ? `${i.sourceRuntimeMin} min` : null],
    ['Source genre', i.sourceGenre],
    ['Collection', i.collection],
    ['Owned', i.owned ? 'yes' : 'no'],
    ['Status', statusLabel(i.status, i.watchedEra)],
    ['Watched on', i.watchedAt],
    ['My rating', i.myRating],
    ['Notes', i.notes],
    ['Match', i.tconst ? `${i.matchStatus} (${i.tconst})` : i.matchStatus],
    ['Source', i.source],
    ['Added', i.addedAt],
    ['Updated', i.updatedAt],
  ];
}

/** How many of an item's plays `show` prints. */
const SHOW_PLAYS = 10;

/** One play line: date (or "no date"), R for a rewatch, source, rating, viewing id. */
function playLine(v: Viewing, rewatch: boolean): string {
  return [v.watchedAt ?? 'no date', rewatch ? 'R' : ' ', v.source, v.rating !== null ? `rated ${v.rating}` : '', `#${v.id}`].filter(Boolean).join('  ');
}

/** An item's plays and lists, as `show` prints them. */
export interface ShowHistory {
  viewings: Viewing[];
  plays: number;
  lists: string[];
}

/**
 * Each of an item's plays flagged as a rewatch or not, judged against the
 * film's plays in every linked edition (a play of another edition earlier
 * makes this one a rewatch).
 */
function rewatchFlags(db: Db, item: LibraryItem, viewings: Viewing[]): Map<number, boolean> {
  const linked = item.tconst !== null && (item.matchStatus === 'matched' || item.matchStatus === 'manual');
  const editions = linked ? resolveRef(db, item.tconst as string) : null;
  const ids = editions?.kind === 'many' ? editions.items.map((i) => i.id) : [item.id];
  return deriveRewatch(ids.length > 1 ? [...viewingsByItem(db, ids).values()].flat() : viewings);
}

function historyLines(h: ShowHistory, rewatch: Map<number, boolean>): [string, string | number | null][] {
  const shown = h.viewings.slice(0, SHOW_PLAYS);
  const lines: [string, string | number | null][] = [['Plays', h.plays]];
  shown.forEach((v, i) => lines.push([i === 0 ? 'History' : '', playLine(v, rewatch.get(v.id) === true)]));
  if (h.viewings.length > shown.length) lines.push(['', `... ${h.viewings.length - shown.length} more (screentrackr history <id>)`]);
  lines.push(['Lists', h.lists.join(', ')]);
  return lines;
}

function showText(item: LibraryItem | null, movie: CatalogMovie | null, history: ShowHistory | null, rewatch: Map<number, boolean>): string {
  const blocks: string[] = [];
  if (movie) blocks.push(keyValues(movieLines(movie)));
  if (item) blocks.push(keyValues([...itemLines(item), ...(history ? historyLines(history, rewatch) : [])]));
  else blocks.push('Not in your library. Add it with `screentrackr add ' + (movie?.tconst ?? '') + '`.');
  return blocks.join('\n\n');
}

export const show: Command = {
  name: 'show',
  summary: 'Show the full record for one movie',
  usage: 'show <id|tconst|title>',
  options: {},
  run(ctx, pos) {
    const ref = pos.join(' ').trim();
    if (!ref) throw new UserError('Usage: screentrackr show <id|tconst|title>');
    const db = ctx.db();
    const r = resolveRef(db, ref);
    if (r.kind === 'many') throw candidatesError(ref, r.items, 'Show one by its id:');
    const item = r.kind === 'one' ? r.item : null;
    let movie: CatalogMovie | null = null;
    // An unresolved item's tconst is an unchecked hint, not this movie's record.
    if (item?.tconst && (item.matchStatus === 'matched' || item.matchStatus === 'manual')) movie = getCatalogMovie(db, item.tconst);
    else if (!item && TCONST.test(ref)) movie = getCatalogMovie(db, ref);
    if (!item && !movie) {
      throw new UserError(TCONST.test(ref) && !catalogReady(db) ? new CatalogMissingError().message : `No library item or catalog movie matches "${ref}"`);
    }
    let history: ShowHistory | null = null;
    let rewatch = new Map<number, boolean>();
    if (item) {
      const viewings = viewingsOf(db, item.id);
      history = { viewings, plays: countPlays(viewings), lists: listsOfItem(db, item.id) };
      rewatch = rewatchFlags(db, item, viewings);
    }
    ctx.emit({ item, movie, ...(history ?? {}) }, () => showText(item, movie, history, rewatch));
  },
};

async function pick(ctx: Ctx, movies: CatalogMovie[]): Promise<CatalogMovie | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    movies.forEach((m, i) => ctx.log(`  ${i + 1}) ${m.title} (${m.year ?? '?'}), ${m.directors.join(', ') || 'unknown director'}, ${votes(m.votes)} votes, ${m.tconst}`));
    const answer = (await rl.question(`Which one? [1-${movies.length}, Enter to cancel] `)).trim();
    const n = Number(answer);
    return Number.isInteger(n) && n >= 1 && n <= movies.length ? (movies[n - 1] as CatalogMovie) : null;
  } finally {
    rl.close();
  }
}

function parseStatus(v: string | undefined): Status | undefined {
  if (v === undefined) return undefined;
  if (!(STATUSES as readonly string[]).includes(v)) throw new UserError(`Unknown status "${v}" (expected ${STATUSES.join(', ')})`);
  return v as Status;
}

export const add: Command = {
  name: 'add',
  summary: 'Add a catalog movie to your library',
  usage: 'add <tconst|title> [--year <yyyy>] [--status <status>] [--new-edition]',
  details:
    'A title that matches more than one movie asks which one in a terminal, and fails listing the candidates otherwise.\nA movie already in your library is refused (listing its ids) unless --new-edition is given.',
  options: {
    year: { type: 'string', value: '<yyyy>', description: 'Narrow a title to this year' },
    status: { type: 'string', value: `<${STATUSES.join('|')}>`, description: 'Initial status (default queue)' },
    'new-edition': { type: 'boolean', description: 'Add another edition of a movie already in your library' },
  },
  async run(ctx, pos, values) {
    const ref = pos.join(' ').trim();
    if (!ref) throw new UserError('Usage: screentrackr add <tconst|title>');
    const status = parseStatus(str(values, 'status'));
    const db = ctx.db();
    if (!catalogReady(db)) throw new CatalogMissingError();

    let tconst: string;
    if (TCONST.test(ref)) {
      tconst = ref.toLowerCase();
    } else {
      const movies = findCatalogByTitle(db, ref, { year: toInt('year', str(values, 'year')) ?? null });
      if (movies.length === 0) throw new UserError(`No catalog movie is titled "${ref}". Try \`screentrackr search --scope all --text "${ref}"\`.`);
      if (movies.length === 1) tconst = (movies[0] as CatalogMovie).tconst;
      else {
        const chosen = !ctx.json && ctx.tty && process.stdin.isTTY ? await pick(ctx, movies) : null;
        if (!chosen) {
          throw new UserError(
            `"${ref}" matches ${movies.length} catalog movies. Add one by its IMDb id, or narrow with --year:\n${movies
              .map((m) => `  ${m.tconst}  ${m.title} (${m.year ?? '?'}), ${m.directors.join(', ') || 'unknown director'}`)
              .join('\n')}`,
            { candidates: movies.map((m) => ({ tconst: m.tconst, title: m.title, year: m.year, directors: m.directors, votes: m.votes })) },
          );
        }
        tconst = chosen.tconst;
      }
    }
    if (!bool(values, 'new-edition')) {
      const existing = resolveRef(db, tconst);
      const items = existing.kind === 'one' ? [existing.item] : existing.kind === 'many' ? existing.items : [];
      if (items.length) {
        throw new UserError(
          `${tconst} is already in your library. Pass --new-edition to add another edition.\n${items.map(itemLine).join('\n')}`,
          { candidates: items.map((i) => ({ id: i.id, title: i.sourceTitle, year: i.sourceYear, tconst: i.tconst, status: i.status })) },
        );
      }
    }
    const item = addFromCatalog(db, tconst, status ? { status } : {});
    ctx.emit(item, () => `Added ${item.sourceTitle}${item.sourceYear ? ` (${item.sourceYear})` : ''} as item ${item.id}, status ${item.status}.`);
  },
};

export const set: Command = {
  name: 'set',
  summary: 'Update a library item: status, era, rating, watched date, notes',
  usage: 'set <id|tconst|title> [--status <s>] [--era <e>] [--rating <1-10> | --clear-rating] [--watched-at <date> | --clear-watched-at] [--notes <text>]',
  details: 'A reference that matches more than one item (two editions, or two movies with one title) never writes; it lists the ids to use instead.',
  options: {
    status: { type: 'string', value: `<${STATUSES.join('|')}>`, description: 'New status' },
    era: { type: 'string', value: `<${WATCHED_ERAS.join('|')}>`, description: 'When you watched it (status watched only)' },
    rating: { type: 'string', value: '<1-10>', description: 'Your rating' },
    'clear-rating': { type: 'boolean', description: 'Remove your rating' },
    'watched-at': { type: 'string', value: '<date>', description: 'Watched date, YYYY-MM-DD: adds a play that day (not earlier than a play you have)' },
    'clear-watched-at': { type: 'boolean', description: 'Remove the watched date and every play of the movie' },
    notes: { type: 'string', value: '<text>', description: 'Notes (empty string clears)' },
  },
  run(ctx, pos, values) {
    const ref = pos.join(' ').trim();
    if (!ref) throw new UserError('Usage: screentrackr set <id|tconst|title> [--status ...] [--rating N]');
    const patch: ItemPatch = {};
    const status = parseStatus(str(values, 'status'));
    if (status) patch.status = status;
    const era = str(values, 'era');
    if (era !== undefined) {
      if (!(WATCHED_ERAS as readonly string[]).includes(era)) throw new UserError(`Unknown era "${era}" (expected ${WATCHED_ERAS.join(', ')})`);
      patch.watchedEra = era as WatchedEra;
    }
    const rating = str(values, 'rating');
    if (rating !== undefined && bool(values, 'clear-rating')) throw new UserError('Use either --rating or --clear-rating, not both');
    if (rating !== undefined) patch.myRating = toInt('rating', rating) as number;
    if (bool(values, 'clear-rating')) patch.myRating = null;
    const watchedAt = str(values, 'watched-at');
    const clearWatched = bool(values, 'clear-watched-at');
    if (watchedAt !== undefined && clearWatched) throw new UserError('Use either --watched-at or --clear-watched-at, not both');
    if (watchedAt !== undefined) patch.watchedAt = watchedAt;
    if (bool(values, 'clear-watched-at')) patch.watchedAt = null;
    const notes = str(values, 'notes');
    if (notes !== undefined) patch.notes = notes === '' ? null : notes;
    if (Object.keys(patch).length === 0) throw new UserError('Nothing to change. Pass --status, --era, --rating, --clear-rating, --watched-at or --notes.');

    const db = ctx.db();
    const target = oneItem(db, ref, 'Set one by its id:');
    const { item, viewingsRemoved } = updateItemDetailed(db, target.id, patch);
    const removed = clearWatched ? ` Cleared the watched date: removed ${viewingsRemoved} play${viewingsRemoved === 1 ? '' : 's'}.` : '';
    ctx.emit(clearWatched ? { ...item, viewingsRemoved } : item, () =>
      `Updated item ${item.id}, ${item.sourceTitle}: ${statusLabel(item.status, item.watchedEra)}${item.myRating !== null ? `, rated ${item.myRating}` : ''}.${removed}`,
    );
  },
};

export const remove: Command = {
  name: 'remove',
  summary: 'Remove one library item by id',
  usage: 'remove <id>',
  options: {},
  run(ctx, pos) {
    if (pos.length !== 1) throw new UserError('Usage: screentrackr remove <id>');
    const id = toId(pos[0], 'an item id (find it with `screentrackr search` or `show`)');
    const db = ctx.db();
    const item = getItem(db, id);
    removeItem(db, id);
    ctx.emit({ removed: id }, () => `Removed item ${id}${item ? `, ${item.sourceTitle}` : ''}.`);
  },
};

export const link: Command = {
  name: 'link',
  summary: 'Match a library item to a catalog movie by hand',
  usage: 'link <id> <tconst>',
  details: 'Manual links are never changed by later matching.',
  options: {},
  run(ctx, pos) {
    if (pos.length !== 2) throw new UserError('Usage: screentrackr link <id> <tconst>');
    const id = toId(pos[0]);
    const db = ctx.db();
    if (!catalogReady(db)) throw new CatalogMissingError();
    const item = linkItem(db, id, (pos[1] as string).trim().toLowerCase());
    ctx.emit(item, () => `Linked item ${item.id}, ${item.sourceTitle}, to ${item.tconst}.`);
  },
};
