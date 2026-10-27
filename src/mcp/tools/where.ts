/** where_to_watch: a JustWatch search link for a movie. The tool builds a link and fetches nothing. */
import { z } from 'zod';
import { catalogReady } from '../../core/db.js';
import { getItem } from '../../core/library.js';
import { CatalogMissingError } from '../../core/search.js';
import { countryForHome, whereForItem, whereForTconst } from '../../core/where.js';
import { exactlyOne, handler, id, ok, tconst, ToolInputError, type RegisterTools } from './common.js';

/** The JustWatch country for MCP answers: config.json `country`, else the locale, else us. */
export function mcpCountry(home: string, flag?: string): string {
  return countryForHome(home, { flag }).country;
}

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'where_to_watch',
    {
      title: 'Where to watch',
      description:
        'A JustWatch search link for one movie, by library id or IMDb tconst (exactly one). Only a link: this tool fetches nothing, so it cannot say which services carry the movie; give the user the link. country is a two-letter code such as us, uk or de (GB is uk on JustWatch); it defaults to the saved setting, then the system locale, then us.',
      inputSchema: {
        id: id.optional(),
        tconst: tconst.optional(),
        country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Expected two letters, such as us or uk').optional().describe('Two-letter country, e.g. us, uk, de.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      exactlyOne(args);
      const country = mcpCountry(db.home, args.country);
      let w;
      if (args.id !== undefined) {
        const item = getItem(db, args.id);
        if (!item) throw new ToolInputError(`Item ${args.id} not found`);
        w = whereForItem(db, item, country);
      } else {
        const t = (args.tconst as string).toLowerCase();
        const found = whereForTconst(db, t, country);
        if (!found) throw catalogReady(db) ? new ToolInputError(`No movie ${t} in the catalog or your library`) : new CatalogMissingError();
        w = found;
      }
      return ok(w, `${w.title} on JustWatch (${w.country}): ${w.url}`);
    }),
  );
};
