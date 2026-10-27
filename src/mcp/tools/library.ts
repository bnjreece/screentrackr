/** add_to_library and remove_from_library. */
import { z } from 'zod';
import { catalogReady } from '../../core/db.js';
import { addFromCatalog, getItem, removeItem, resolveRef } from '../../core/library.js';
import { CatalogMissingError } from '../../core/search.js';
import { STATUSES } from '../../core/types.js';
import { handler, id, itemLine, ok, tconst, ToolInputError, type RegisterTools } from './common.js';

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'add_to_library',
    {
      title: 'Add a movie to the library',
      description:
        'Add a catalog movie (by IMDb tconst) to your library, status queue unless given. If the movie is already in your library this fails listing the existing ids; pass newEdition: true to add another edition on purpose.',
      inputSchema: {
        tconst,
        status: z.enum(STATUSES).optional().describe('Initial status (default queue).'),
        newEdition: z.boolean().optional().describe('Add even when the movie is already in your library.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      if (!catalogReady(db)) throw new CatalogMissingError();
      const t = args.tconst.toLowerCase();
      if (!args.newEdition) {
        const existing = resolveRef(db, t);
        const items = existing.kind === 'one' ? [existing.item] : existing.kind === 'many' ? existing.items : [];
        if (items.length) {
          throw new ToolInputError(
            `${t} is already in your library. Pass newEdition: true to add another edition.\n${items.map((i) => `  ${itemLine(i)}`).join('\n')}`,
          );
        }
      }
      const item = addFromCatalog(db, t, args.status ? { status: args.status } : {});
      return ok(item, `Added ${itemLine(item)}.`);
    }),
  );

  server.registerTool(
    'remove_from_library',
    {
      title: 'Remove a library item',
      description: 'Permanently remove one library item by id, including its status, rating, notes, plays and list memberships. This cannot be undone.',
      inputSchema: { id },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      const item = getItem(db, args.id);
      if (!item) throw new ToolInputError(`Item ${args.id} not found`);
      removeItem(db, args.id);
      return ok({ removed: item }, `Removed ${itemLine(item)}.`);
    }),
  );
};
