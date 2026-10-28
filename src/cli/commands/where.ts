/** `screentrackr where`: a JustWatch search link for a movie. Nothing is fetched. */
import { catalogReady, type Db } from '../../core/db.js';
import { resolveRef } from '../../core/library.js';
import { getCatalogMovie } from '../../core/movie.js';
import { CatalogMissingError } from '../../core/search.js';
import type { LibraryItem } from '../../core/types.js';
import { countryForHome, openUrl, whereFor, whereForItem, type CountrySource, type WhereToWatch } from '../../core/where.js';
import { bool, str, type Command } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { itemLine } from '../format.js';

const TCONST = /^tt\d{7,}$/i;

/**
 * The JustWatch country for this run: `--country`, else config.json, else
 * the locale, else us. A config.json that can't be read is reported on
 * stderr and the locale decides, so a broken setting never hides a link.
 */
export function cliCountry(ctx: Ctx, flag?: string): { country: string; from: CountrySource } {
  return countryForHome(ctx.home, { flag, onConfigError: (err) => ctx.log(`Warning: ${err.message} Using the locale's country.`) });
}

const linked = (i: LibraryItem) => i.tconst !== null && (i.matchStatus === 'matched' || i.matchStatus === 'manual');

/** What a ref names for a link: one library item, or the editions of one linked film, or a catalog movie by tconst. */
function resolveWhere(db: Db, ref: string, country: string): WhereToWatch & { tconst: string | null; itemId: number | null } {
  const r = resolveRef(db, ref);
  if (r.kind === 'one') return { ...whereForItem(db, r.item, country), tconst: linked(r.item) ? r.item.tconst : null, itemId: r.item.id };
  if (r.kind === 'many') {
    // Editions of one film are one movie to watch; different movies are ambiguous.
    const first = r.items[0] as LibraryItem;
    if (r.items.every((i) => linked(i) && i.tconst === first.tconst)) return { ...whereForItem(db, first, country), tconst: first.tconst, itemId: null };
    throw new UserError(`"${ref}" matches ${r.items.length} library items. Use one id:\n${r.items.map(itemLine).join('\n')}`, {
      candidates: r.items.map((i) => ({ id: i.id, title: i.sourceTitle, year: i.sourceYear, tconst: i.tconst, status: i.status })),
    });
  }
  if (TCONST.test(ref)) {
    const movie = getCatalogMovie(db, ref);
    if (movie) return { ...whereFor(movie.title, country), tconst: movie.tconst, itemId: null };
    if (!catalogReady(db)) throw new UserError(new CatalogMissingError().message);
  }
  throw new UserError(`No library item or catalog movie matches "${ref}"`);
}

export const where: Command = {
  name: 'where',
  summary: 'Print a JustWatch search link for where to watch a movie',
  usage: 'where <id|tconst|title> [--country <cc>] [--open]',
  details:
    'The link searches JustWatch for the title; screentrackr fetches nothing. --open asks your browser to open it (macOS and Linux).\nCountry: --country, else `screentrackr config set country <cc>`, else your locale\'s region, else us. GB is JustWatch\'s uk.',
  options: {
    country: { type: 'string', value: '<cc>', description: 'Two-letter country, such as us, uk or de' },
    open: { type: 'boolean', description: 'Open the link in your browser' },
  },
  async run(ctx, pos, values) {
    const ref = pos.join(' ').trim();
    if (!ref) throw new UserError('Usage: screentrackr where <id|tconst|title> [--country <cc>] [--open]');
    const { country, from } = cliCountry(ctx, str(values, 'country'));
    const w = resolveWhere(ctx.db(), ref, country);
    const open = bool(values, 'open');
    if (open) {
      try {
        await openUrl(w.url);
      } catch (err) {
        // The link is still the answer: say why it didn't open, and give it.
        throw new UserError(`${(err as Error).message}\n${w.url}`, { url: w.url });
      }
    }
    ctx.emit({ ...w, countryFrom: from, ...(open ? { opened: true } : {}) }, () => `${w.title} on JustWatch (${w.country}):\n${w.url}`);
    if (open && !ctx.json) ctx.log('Opened in your browser.');
    if (from === 'default' && !ctx.json) ctx.log('No country set or found in your locale, so this is the US page. Set yours with `screentrackr config set country <cc>`.');
  },
};
