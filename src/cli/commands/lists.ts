/** `screentrackr lists` and `screentrackr list`: your own lists of movies. */
import { addMembers, ListRefError, removeMembers, type RefProblem } from '../../core/list-members.js';
import { createList, deleteList, listLists, renameList, requireList, type List } from '../../core/lists.js';
import { searchMovies } from '../../core/search.js';
import type { LibraryItem } from '../../core/types.js';
import { bool, str, type Command, type Values } from '../command.js';
import { UserError } from '../context.js';
import { itemLine, movieTable, table } from '../format.js';
import { filterFromFlags, search } from './search.js';

const SUBCOMMANDS = ['create', 'add', 'remove', 'show', 'rename', 'delete'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function listsText(all: List[], opts: { width?: number; color?: boolean } = {}): string {
  if (all.length === 0) return 'No lists yet. Make one with `screentrackr list create <name>`.';
  return table(
    all,
    [
      { header: 'LIST', get: (l) => l.name, flex: true, min: 10 },
      { header: 'MOVIES', get: (l) => String(l.count), align: 'right' },
      { header: 'DESCRIPTION', get: (l) => l.description ?? '', flex: true, min: 11 },
    ],
    opts,
  );
}

export const lists: Command = {
  name: 'lists',
  summary: 'Show your lists with their counts',
  usage: 'lists',
  options: {},
  run(ctx, pos) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}". To see one list, use \`screentrackr list show <name>\`.`);
    const all = listLists(ctx.db());
    ctx.emit({ lists: all }, () => listsText(all, { width: ctx.width, color: ctx.color }));
  },
};

function candidate(i: LibraryItem) {
  return { id: i.id, title: i.sourceTitle, year: i.sourceYear, tconst: i.tconst, status: i.status };
}

/** The CLI wording for refs that did not resolve: what each one was, and what to do. */
function refError(err: ListRefError, verb: 'added to' | 'removed from', addMissingFlag: boolean): UserError {
  const lines = err.problems.map((p: RefProblem) => {
    switch (p.reason) {
      case 'ambiguous':
        return `  "${p.ref}" matches ${p.candidates?.length ?? 0} library items. Name one by its id:\n${(p.candidates ?? []).map((i) => `  ${itemLine(i)}`).join('\n')}`;
      case 'not-found':
        return `  "${p.ref}" matches no library item.`;
      case 'not-in-library':
        return `  "${p.ref}" is not in your library.${addMissingFlag ? ' Pass --add-missing to add it as a queue item you do not own.' : ''}`;
      case 'not-in-catalog':
        return `  "${p.ref}" is not in the catalog, so it can't be added.`;
    }
  });
  return new UserError(`Nothing was ${verb} "${err.list}". Fix these and run it again:\n${lines.join('\n')}`, {
    problems: err.problems.map((p) => ({ ref: p.ref, reason: p.reason, ...(p.candidates ? { candidates: p.candidates.map(candidate) } : {}) })),
  });
}

/** Flags that belong to `list show` only (the search filters). */
const SEARCH_FLAGS = Object.keys(search.options);

function refuseFlags(values: Values, sub: Sub, allowed: string[]): void {
  for (const k of [...SEARCH_FLAGS, 'description', 'add-missing']) {
    if (allowed.includes(k)) continue;
    if (values[k] !== undefined && values[k] !== false) throw new UserError(`--${k} does not apply to \`list ${sub}\``);
  }
}

function oneName(rest: string[], sub: Sub, what = '<name>'): string {
  if (rest.length === 0) throw new UserError(`Usage: screentrackr list ${sub} ${what}`);
  if (rest.length > 1) throw new UserError(`\`list ${sub}\` takes one list name. Quote a name with spaces: "Spooky season".`);
  return rest[0] as string;
}

export const list: Command = {
  name: 'list',
  summary: 'Create, fill, show, rename or delete one of your lists',
  usage: 'list <create|add|remove|show|rename|delete> <name> [<id|tconst|title>...]',
  details: [
    'list create <name> [--description <text>]   make a list (names are unique, in any case)',
    'list add <name> <ref>... [--add-missing]      add movies by library id, IMDb id or title',
    'list remove <name> <ref>...                   take movies out (never deletes them)',
    'list show <name> [search filters]             the list as search results, e.g. --unwatched',
    'list rename <name> <new name>',
    'list delete <name>                            delete the list, never the movies',
    '',
    'Quote names and titles with spaces. A reference that matches more than one item (two editions) changes nothing and lists the ids to use.',
    '--add-missing adds an IMDb id you do not have to your library first, as a queue item you do not own.',
  ].join('\n'),
  options: {
    description: { type: 'string', value: '<text>', description: 'With create: a description for the list' },
    'add-missing': { type: 'boolean', description: 'With add: add IMDb ids you do not have to the library (queue, not owned)' },
    ...search.options,
  },
  run(ctx, pos, values) {
    const [sub, ...rest] = pos;
    if (!sub) throw new UserError(`Usage: screentrackr ${list.usage}`);
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new UserError(`Unknown list command "${sub}" (expected ${SUBCOMMANDS.join(', ')}). To see your lists, run \`screentrackr lists\`.`);
    }
    const db = () => ctx.db();
    switch (sub as Sub) {
      case 'create': {
        refuseFlags(values, 'create', ['description']);
        const l = createList(db(), oneName(rest, 'create'), { description: str(values, 'description') ?? null });
        ctx.emit(l, () => `Created the list "${l.name}".`);
        return;
      }
      case 'add': {
        refuseFlags(values, 'add', ['add-missing']);
        const [name, ...refs] = rest;
        if (!name || refs.length === 0) throw new UserError('Usage: screentrackr list add <name> <id|tconst|title>...');
        const addMissing = bool(values, 'add-missing');
        let r;
        try {
          r = addMembers(db(), name, refs, { addMissing });
        } catch (err) {
          if (err instanceof ListRefError) throw refError(err, 'added to', !addMissing);
          throw err;
        }
        const res = r;
        ctx.emit(res, () => {
          const lines = [`Added ${plural(res.added.length, 'movie')} to "${res.list.name}" (${plural(res.list.count, 'movie')} in it now).`];
          if (res.already.length) lines.push(`Already in it: ${res.already.join(', ')}.`);
          for (const i of res.created) lines.push(`Added to your library: ${i.sourceTitle}${i.sourceYear ? ` (${i.sourceYear})` : ''} as item ${i.id}, queue, not owned.`);
          return lines.join('\n');
        });
        return;
      }
      case 'remove': {
        refuseFlags(values, 'remove', []);
        const [name, ...refs] = rest;
        if (!name || refs.length === 0) throw new UserError('Usage: screentrackr list remove <name> <id|tconst|title>...');
        let r;
        try {
          r = removeMembers(db(), name, refs);
        } catch (err) {
          if (err instanceof ListRefError) throw refError(err, 'removed from', false);
          throw err;
        }
        const res = r;
        ctx.emit(res, () => {
          const lines = [`Removed ${plural(res.removed.length, 'movie')} from "${res.list.name}" (${plural(res.list.count, 'movie')} in it now).`];
          if (res.notMember.length) lines.push(`Not in it: ${res.notMember.join(', ')}.`);
          return lines.join('\n');
        });
        return;
      }
      case 'show': {
        refuseFlags(values, 'show', SEARCH_FLAGS);
        const l = requireList(db(), oneName(rest, 'show'));
        const filter = filterFromFlags(values);
        if (filter.lists !== undefined) throw new UserError('`list show` shows one list. To combine lists, use `screentrackr search --list <name> --list <name>`.');
        filter.lists = [l.name];
        const res = searchMovies(db(), filter);
        ctx.emit({ list: l, ...res }, () => {
          const head = `${l.name}: ${plural(l.count, 'movie')}${l.description ? `. ${l.description}` : ''}`;
          if (res.results.length === 0) {
            if (l.count === 0) return `${head}\nNothing in it yet. Add movies with \`screentrackr list add "${l.name}" <id|tconst|title>\`.`;
            return `${head}\n${res.total ? `No results on this page (${res.total} in total).` : 'No movies in it match these filters.'}`;
          }
          const offset = typeof filter.offset === 'number' ? filter.offset : 0;
          return `${head}\n\n${movieTable(res.results, { width: ctx.width, color: ctx.color })}\n\nShowing ${offset + 1}-${offset + res.results.length} of ${res.total}.`;
        });
        return;
      }
      case 'rename': {
        refuseFlags(values, 'rename', []);
        if (rest.length !== 2) throw new UserError('Usage: screentrackr list rename <name> <new name> (quote names with spaces)');
        const before = requireList(db(), rest[0] as string);
        const l = renameList(db(), before.name, rest[1] as string);
        ctx.emit({ ...l, previousName: before.name }, () => `Renamed "${before.name}" to "${l.name}".`);
        return;
      }
      case 'delete': {
        refuseFlags(values, 'delete', []);
        const r = deleteList(db(), oneName(rest, 'delete'));
        ctx.emit(r, () => {
          const was = r.memberships === 1 ? '1 movie was' : `${r.memberships} movies were`;
          return `Deleted the list "${r.list.name}" (${was} in it; the movies stay in your library).`;
        });
        return;
      }
    }
  },
};
