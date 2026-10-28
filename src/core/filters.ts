/**
 * The one search filter, shared by the CLI and the MCP server. Both validate
 * input with FilterSchema, and core/search.ts compiles the parsed Filter to SQL.
 *
 * Semantics: OR within a list (directors, actors, genres in `any` mode,
 * decades, lists in `any` mode), AND across fields. "Unwatched" means queue,
 * priority or someday.
 */
import { z } from 'zod';
import { STATUSES } from './types.js';

export const SCOPES = ['library', 'all'] as const;
export const GENRE_MODES = ['any', 'all'] as const;
export const SORTS = ['rating', 'votes', 'year', 'runtime', 'title', 'my_rating', 'random'] as const;
export const ORDERS = ['asc', 'desc'] as const;
export const LIST_MODES = ['any', 'all'] as const;
/** `1980s`: the decades a filter accepts, 1880s to 2190s. */
export const DECADE_RE = /^\d{3}0s$/;
export const MIN_DECADE = 1880;
export const MAX_DECADE = 2190;

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
/** Default minVotes for scope `all`, so obscure titles don't flood results. */
export const ALL_SCOPE_MIN_VOTES = 1000;

const name = z.string().trim().min(1).max(200);
const names = z.array(name).min(1).max(50);
const year = z.number().int().min(1800).max(2200);
const minutes = z.number().int().min(0).max(10000);
const decade = z
  .string()
  .trim()
  .regex(DECADE_RE, 'Expected a decade such as 1980s')
  .refine((d) => Number(d.slice(0, 4)) >= MIN_DECADE && Number(d.slice(0, 4)) <= MAX_DECADE, `Decades run from ${MIN_DECADE}s to ${MAX_DECADE}s`);
// Measured as list create measures a name: in characters, after NFC (MAX_LIST_NAME in lists.ts).
const listName = z
  .string()
  .trim()
  .min(1)
  .refine((s) => [...s.normalize('NFC')].length <= 100, 'A list name can be at most 100 characters');

/**
 * The raw field shape, for callers (such as an MCP tool definition) that need
 * a plain object shape. Cross-field rules and defaults live in FilterSchema.
 */
export const FilterShape = {
  scope: z.enum(SCOPES).default('library').describe('library (default): your movies. all: every movie in the catalog.'),
  directors: names.optional().describe('Director names, partial and case-insensitive. OR within the list.'),
  actors: names.optional().describe('Top-billed cast names, partial and case-insensitive. OR within the list.'),
  genres: names.optional().describe('Genres, e.g. Thriller. Matched case-insensitively.'),
  genreMode: z.enum(GENRE_MODES).default('any').describe('any (default): at least one genre. all: every genre.'),
  minRating: z.number().min(0).max(10).optional().describe('Minimum IMDb rating.'),
  minVotes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(`Minimum IMDb votes. Defaults to ${ALL_SCOPE_MIN_VOTES} for scope all and 0 for library.`),
  minRuntime: minutes.optional().describe('Minimum runtime in minutes.'),
  maxRuntime: minutes.optional().describe('Maximum runtime in minutes.'),
  yearFrom: year.optional().describe('Earliest release year, inclusive.'),
  yearTo: year.optional().describe('Latest release year, inclusive.'),
  status: z.array(z.enum(STATUSES)).min(1).optional().describe('Library statuses to include.'),
  unwatched: z.boolean().optional().describe('Only queue, priority or someday.'),
  myRatingMin: z.number().int().min(1).max(10).optional().describe('Minimum personal rating (1 to 10).'),
  notInLibrary: z.boolean().optional().describe('Scope all only: exclude movies in your library. unwatched may be combined with it and changes nothing.'),
  owned: z.boolean().optional().describe('Only library movies you own (true) or do not own (false). With scope all, library movies only.'),
  decades: z.array(decade).min(1).max(50).optional().describe('Release decades such as 1980s, ORed together and ANDed with yearFrom and yearTo.'),
  lists: z.array(listName).min(1).max(50).optional().describe('Your lists by name (case-insensitive): movies in any of them, or all with listMode all.'),
  listMode: z.enum(LIST_MODES).default('any').describe('any (default): in at least one of lists. all: in every one.'),
  neverSeen: z.boolean().optional().describe('Only movies with no recorded play and a status other than watched.'),
  excludeWatched: z
    .boolean()
    .optional()
    .describe('Drop movies you have watched (status watched, or any recorded play, in any edition). Unlike notInLibrary, owned movies you have not watched stay.'),
  maxVotes: z.number().int().min(0).optional().describe('Maximum IMDb votes, for under-seen titles. Movies with no votes are left out.'),
  text: z.string().trim().min(1).max(200).optional().describe('Title search.'),
  sort: z.enum(SORTS).default('rating'),
  order: z.enum(ORDERS).optional().describe('Defaults to asc for title and desc otherwise.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().min(0).default(0),
};

export const FilterSchema = z
  .strictObject(FilterShape)
  .superRefine((f, ctx) => {
    if (f.notInLibrary && f.scope !== 'all') {
      ctx.addIssue({ code: 'custom', path: ['notInLibrary'], message: 'notInLibrary is only valid with scope "all"' });
    }
    // unwatched is allowed: a movie you do not have has no watched status, so it is
    // redundant there. A status or a personal rating would contradict notInLibrary.
    if (f.notInLibrary && (f.status || f.myRatingMin !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['notInLibrary'],
        message: 'notInLibrary cannot be combined with status or myRatingMin',
      });
    }
    if (f.notInLibrary && (f.owned !== undefined || f.lists)) {
      ctx.addIssue({
        code: 'custom',
        path: ['notInLibrary'],
        message: 'notInLibrary cannot be combined with owned or lists (those are library movies)',
      });
    }
    if (f.neverSeen && f.status && f.status.every((s) => s === 'watched')) {
      ctx.addIssue({ code: 'custom', path: ['neverSeen'], message: 'neverSeen contradicts status watched' });
    }
    if (f.minVotes !== undefined && f.maxVotes !== undefined && f.minVotes > f.maxVotes) {
      ctx.addIssue({ code: 'custom', path: ['maxVotes'], message: 'maxVotes is below minVotes' });
    }
    if (f.status && f.unwatched) {
      ctx.addIssue({ code: 'custom', path: ['unwatched'], message: 'Use either status or unwatched, not both' });
    }
    if (f.minRuntime !== undefined && f.maxRuntime !== undefined && f.minRuntime > f.maxRuntime) {
      ctx.addIssue({ code: 'custom', path: ['maxRuntime'], message: 'maxRuntime is below minRuntime' });
    }
    if (f.yearFrom !== undefined && f.yearTo !== undefined && f.yearFrom > f.yearTo) {
      ctx.addIssue({ code: 'custom', path: ['yearTo'], message: 'yearTo is before yearFrom' });
    }
  })
  .transform((f) => ({ ...f, minVotes: f.minVotes ?? (f.scope === 'all' ? ALL_SCOPE_MIN_VOTES : 0) }));

/** A parsed filter, with every default applied. */
export type Filter = z.infer<typeof FilterSchema>;
/** What callers may pass in, before defaults. */
export type FilterInput = z.input<typeof FilterSchema>;
