/** list_lists, create_list, delete_list, list_add and list_remove: your own lists. Writes take ids or tconsts, never titles. */
import { z } from 'zod';
import { addMembers, ListRefError, removeMembers } from '../../core/list-members.js';
import { createList, deleteList, listLists, MAX_LIST_DESCRIPTION, MAX_LIST_NAME, type List } from '../../core/lists.js';
import { handler, id, itemLine, ok, tconst, ToolInputError, type RegisterTools } from './common.js';

const listName = z.string().trim().min(1).max(MAX_LIST_NAME).describe('The list name (case-insensitive).');

const count = (n: number) => `${n} movie${n === 1 ? '' : 's'}`;
const line = (l: List) => `- ${l.name} (${count(l.count)})${l.description ? `: ${l.description}` : ''}`;

/** The tool wording for refs that did not resolve. */
function refError(err: ListRefError, verb: string): ToolInputError {
  const lines = err.problems.map((p) => {
    const ref = p.ref.startsWith('#') ? `id ${p.ref.slice(1)}` : p.ref;
    switch (p.reason) {
      case 'ambiguous':
        return `${ref} matches ${p.candidates?.length ?? 0} library items (editions). Pass ids instead:\n${(p.candidates ?? []).map((i) => `  ${itemLine(i)}`).join('\n')}`;
      case 'not-found':
        return `${ref} is not in your library.`;
      case 'not-in-library':
        return `${ref} is not in your library. Pass addMissing: true to add it as a queue item you do not own.`;
      case 'not-in-catalog':
        return `${ref} is not in the catalog, so it can't be added.`;
    }
  });
  return new ToolInputError(`Nothing was ${verb} "${err.list}":\n${lines.join('\n')}`);
}

function refs(ids: number[] | undefined, tconsts: string[] | undefined): string[] {
  const out = [...(ids ?? []).map((i) => `#${i}`), ...(tconsts ?? [])];
  if (out.length === 0) throw new ToolInputError('Pass at least one id or tconst.');
  return out;
}

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'list_lists',
    {
      title: 'Your lists',
      description:
        'Your own lists of movies (such as "Halloween"), with how many movies each holds and its description. To see the movies in one, call search_movies with lists: ["<name>"] (any other filter works too).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(() => {
      const lists = listLists(db);
      return ok({ lists }, lists.length ? `${lists.length} list${lists.length === 1 ? '' : 's'}:\n${lists.map(line).join('\n')}` : 'No lists yet.');
    }),
  );

  server.registerTool(
    'create_list',
    {
      title: 'Create a list',
      description: 'Create one of your own lists. Names are unique ignoring case, up to 100 characters. Fill it with list_add.',
      inputSchema: {
        name: listName,
        description: z.string().trim().max(MAX_LIST_DESCRIPTION).optional().describe('A description for the list.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      const l = createList(db, args.name, { description: args.description ?? null });
      return ok(l, `Created the list "${l.name}".`);
    }),
  );

  server.registerTool(
    'delete_list',
    {
      title: 'Delete a list',
      description: 'Delete one of your lists and its memberships. The movies stay in your library. Says how many movies were in it.',
      inputSchema: { name: listName },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      const r = deleteList(db, args.name);
      const was = r.memberships === 1 ? '1 movie was' : `${r.memberships} movies were`;
      return ok(r, `Deleted the list "${r.list.name}" (${was} in it; the movies stay in your library).`);
    }),
  );

  server.registerTool(
    'list_add',
    {
      title: 'Add movies to a list',
      description:
        'Add library movies to one of your lists, by library id or IMDb tconst (never by title). All or nothing: if any id or tconst does not name exactly one library item (a tconst with two editions, say), nothing is added and the error lists the ids to use. addMissing: true adds a tconst you do not have to your library first, as a queue item you do not own.',
      inputSchema: {
        list: listName,
        ids: z.array(id).min(1).max(500).optional(),
        tconsts: z.array(tconst).min(1).max(500).optional(),
        addMissing: z.boolean().optional().describe('Add tconsts you do not have to the library (status queue, not owned).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((args) => {
      let r;
      try {
        r = addMembers(db, args.list, refs(args.ids, args.tconsts), { addMissing: args.addMissing === true });
      } catch (err) {
        if (err instanceof ListRefError) throw refError(err, 'added to');
        throw err;
      }
      const lines = [`Added ${count(r.added.length)} to "${r.list.name}" (${count(r.list.count)} in it now).`];
      if (r.already.length) lines.push(`Already in it: ${r.already.map((i) => `#${i}`).join(', ')}.`);
      for (const i of r.created) lines.push(`Added to your library: ${itemLine(i)}.`);
      return ok(r, lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_remove',
    {
      title: 'Remove movies from a list',
      description: 'Take library items (by id) out of one of your lists. The movies stay in your library. Ids not in the list are reported, not an error.',
      inputSchema: { list: listName, ids: z.array(id).min(1).max(500) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((args) => {
      let r;
      try {
        r = removeMembers(db, args.list, refs(args.ids, undefined));
      } catch (err) {
        if (err instanceof ListRefError) throw refError(err, 'removed from');
        throw err;
      }
      const lines = [`Removed ${count(r.removed.length)} from "${r.list.name}" (${count(r.list.count)} in it now).`];
      if (r.notMember.length) lines.push(`Not in it: ${r.notMember.map((i) => `#${i}`).join(', ')}.`);
      return ok(r, lines.join('\n'));
    }),
  );
};
