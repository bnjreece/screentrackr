/**
 * `screentrackr import`: the flags, their checks, and the routing to a
 * source. Reading and applying each source is in ../import-runner.ts, which
 * `sync` shares.
 */
import { FORMATS, type ImportFormat } from '../../core/importers/index.js';
import { IMDB_INCLUDE_TYPES, IMDB_LIST_KINDS, type ImdbListKind, type ImdbOptions } from '../../core/importers/imdb.js';
import type { LetterboxdOptions } from '../../core/importers/letterboxd.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError } from '../context.js';
import {
  applyParsed,
  emitImportOutcome,
  IMDB_FLAGS_ONLY,
  readAppleTvImport,
  readFileImport,
  readJellyfinImport,
  readPlexImport,
  type JellyfinImportOptions,
  type ParsedSource,
} from '../import-runner.js';
import { emitPlexDryRun, PLEX_OPTIONS, plexOptionsFromFlags, rejectPlexFlags } from './import-plex.js';

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv|imdb <file.csv>...|letterboxd <export.zip|folder|file.csv>...|trakt <export.zip|folder>...|plex|jellyfin> [--format <format>] [--merge | --replace] [--dry-run]',
  details: [
    `Formats: ${FORMATS.join(', ')}. The format is detected when --format is omitted.`,
    "`import apple-tv` (experimental, macOS only) reads the TV app's library directly. Movies with a recorded play date are marked watched; the rest keep their current status.",
    "`import imdb <file.csv>...` reads IMDb CSV exports you downloaded from imdb.com (Your Ratings, your watchlist, check-ins or a list). Rated movies are marked watched with your rating; watchlist movies go in the queue only when they are new; nothing is marked owned. Several files are read together. --as says what a list export is (watchlist by default), --collection names a list's collection, --include-type brings in more than movies (repeatable or comma-separated: " +
      IMDB_INCLUDE_TYPES.join(', ') +
      '), --checkin-dates uses check-in dates as watched dates, --notes-from-description keeps a list row\'s Description as notes.',
    "`import letterboxd <export.zip|folder|file.csv>...` reads the export you downloaded from letterboxd.com (Settings, Data). Watched and rated films are marked watched, with half stars stored times two (1 to 10); the watched date comes from your diary; watchlist films go in the queue only when they are new; nothing is marked owned unless you name a list with --owned-list <slug> (repeatable). --with-reviews takes your latest review as notes for movies with none; --no-watchlist leaves the watchlist out.",
    "`import trakt <export.zip|folder>` reads the data export you download from Trakt (Settings > Data > Raw export), or files from it. Only movie history, ratings, watchlist, collection and the export's error list are read. Watched movies are marked watched with the latest play's date, watchlist movies go in the queue only when they are new, and only the collection marks a movie owned. Plays logged in bulk (10 or more at the same second) lose their dates unless --keep-bulk-dates. It only merges (--replace is refused). A plain `import` of the export ZIP or one of those files does the same, and refuses the export's other files without opening them. Nothing is fetched from Trakt.",
    "`import plex [--url <server>] [--section <name|key>]...` reads the movie libraries of your own Plex Media Server, read-only, with the token from PLEX_TOKEN (never stored). Every movie is marked owned; movies Plex counts as played are marked watched, with your Plex rating unless --no-ratings; new unwatched movies get --unwatched-status (someday by default; skip leaves them out) and existing ones keep their status. With --dry-run, plex shows the counts it read and never opens your library.",
    '`import jellyfin --url <server> --user <name>` reads your movies from your own Jellyfin server, read only. The token comes from JELLYFIN_TOKEN (or --token-stdin); without one you sign in with your password (prompted, or --password-stdin) and the session is signed out afterwards. Nothing is stored. Played movies are marked watched; the rest keep their status (a new one goes in the queue). --ratings brings in your Jellyfin ratings.',
    '--merge adds new movies and updates fields the file has; it never clears a status or rating the file lacks. A record that fits more than one item is not imported and is listed with the candidate item ids.',
    '--replace backs up your library to backups/ first, then replaces it.',
    '--dry-run reports what the import would add, update and leave for review, and changes nothing (no backup either).',
  ].join('\n'),
  options: {
    format: { type: 'string', value: '<format>', description: `One of ${FORMATS.join(', ')}` },
    merge: { type: 'boolean', description: 'Merge into the library (the default)' },
    replace: { type: 'boolean', description: 'Replace the library, after a backup' },
    timeout: {
      type: 'string',
      value: '<seconds>',
      description: 'apple-tv: how long to wait for the TV app (default 120); jellyfin: per request (default 30)',
    },
    as: { type: 'string', value: `<${IMDB_LIST_KINDS.join('|')}>`, description: 'imdb only: what an IMDb list export is (default watchlist)' },
    collection: { type: 'string', value: '<name>', description: 'imdb --as list only: collection name for the list (fills a blank collection)' },
    'include-type': {
      type: 'string',
      multiple: true,
      value: '<type>',
      description: `imdb only: also bring in ${IMDB_INCLUDE_TYPES.join(', ')} (repeatable)`,
    },
    'checkin-dates': { type: 'boolean', description: 'imdb --as checkins only: use check-in dates as watched dates' },
    'owned-list': {
      type: 'string',
      multiple: true,
      value: '<slug>',
      description: 'letterboxd only: mark the films of this list (lists/<slug>.csv in the export) owned (repeatable)',
    },
    'with-reviews': { type: 'boolean', description: 'letterboxd only: use your latest review as notes for movies with no notes' },
    'no-watchlist': { type: 'boolean', description: 'letterboxd only: leave the watchlist out' },
    'keep-bulk-dates': { type: 'boolean', description: 'trakt only: keep the dates of plays logged in bulk' },
    ...PLEX_OPTIONS,
    url: { type: 'string', value: '<server>', description: 'plex and jellyfin only: your server address (plex default http://127.0.0.1:32400; jellyfin: required, such as http://localhost:8096)' },
    'token-stdin': { type: 'boolean', description: 'plex and jellyfin only: read the token from stdin instead of PLEX_TOKEN or JELLYFIN_TOKEN' },
    user: { type: 'string', value: '<name>', description: 'jellyfin only: whose library to read (and who signs in without a token)' },
    'user-id': { type: 'string', value: '<id>', description: 'jellyfin only, with an admin API key: the user id whose library to read' },
    'password-stdin': { type: 'boolean', description: 'jellyfin only: read the password from stdin instead of prompting' },
    ratings: { type: 'boolean', description: 'jellyfin only: also import your ratings (left out by default)' },
    'strict-played': { type: 'boolean', description: 'jellyfin only: played movies with no known runtime get no status' },
    'notes-from-description': { type: 'boolean', description: "imdb only: use a list row's Description as the movie's notes (fills blank notes)" },
    'dry-run': { type: 'boolean', description: 'Show what the import would do without changing anything' },
  },
  async run(ctx, pos, values) {
    const file = pos[0];
    if (!file) throw new UserError('Usage: screentrackr import <file>');
    const imdb = file === 'imdb';
    const letterboxd = file === 'letterboxd';
    const trakt = file === 'trakt';
    const files = imdb || letterboxd || trakt ? pos.slice(1) : [file];
    if (imdb && !files.length) throw new UserError('Usage: screentrackr import imdb <file.csv>...');
    if (letterboxd && !files.length) throw new UserError('Usage: screentrackr import letterboxd <export.zip|folder|file.csv>...');
    if (trakt && !files.length) throw new UserError('Usage: screentrackr import trakt <trakt-export.zip | folder | file.json>...');
    if (!imdb && !letterboxd && !trakt && pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    const jellyfin = file === 'jellyfin';
    const plex = file === 'plex';
    const jf: Omit<JellyfinImportOptions, 'timeoutMs'> = {
      url: str(values, 'url'),
      user: str(values, 'user'),
      userId: str(values, 'user-id'),
      tokenStdin: bool(values, 'token-stdin'),
      passwordStdin: bool(values, 'password-stdin'),
      ratings: bool(values, 'ratings'),
      strictPlayed: bool(values, 'strict-played'),
    };
    // --url and --token-stdin are shared by `import plex` and `import jellyfin`.
    if (!jellyfin && !plex && (jf.url !== undefined || jf.tokenStdin)) {
      throw new UserError('--url and --token-stdin only apply to `import plex` and `import jellyfin`');
    }
    const jellyfinOnlyFlags = jf.user !== undefined || jf.userId !== undefined || jf.passwordStdin || jf.ratings || jf.strictPlayed;
    if (!jellyfin && jellyfinOnlyFlags) {
      throw new UserError('--user, --user-id, --password-stdin, --ratings and --strict-played only apply to `import jellyfin`');
    }
    if (bool(values, 'merge') && bool(values, 'replace')) throw new UserError('Use either --merge or --replace, not both');
    const format = str(values, 'format');
    const timeout = str(values, 'timeout');
    const appleTv = file === 'apple-tv';
    if (!plex) rejectPlexFlags(values, ['url', 'token-stdin']);
    // A server's state is not a whole library: unplayed movies would replace
    // watched ones and ratings left out would be cleared.
    if (jellyfin && bool(values, 'replace')) throw new UserError('--replace does not apply to `import jellyfin`; it always merges. Nothing was changed.');
    if ((appleTv || imdb || letterboxd || trakt || plex || jellyfin) && format !== undefined) throw new UserError(`--format does not apply to \`import ${file}\``);
    if (!appleTv && !jellyfin && timeout !== undefined) throw new UserError('--timeout only applies to `import apple-tv` and `import jellyfin`');
    if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`Unknown format "${format}" (expected ${FORMATS.join(', ')})`);
    }

    const as = str(values, 'as');
    const collection = str(values, 'collection');
    const includeRaw = (strs(values, 'include-type') ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    const checkinDates = bool(values, 'checkin-dates');
    const notesFromDescription = bool(values, 'notes-from-description');
    const imdbFlags = as !== undefined || collection !== undefined || includeRaw.length > 0 || checkinDates || notesFromDescription;
    if (as !== undefined && !(IMDB_LIST_KINDS as readonly string[]).includes(as)) {
      throw new UserError(`--as expects ${IMDB_LIST_KINDS.join(', ')} (got "${as}")`);
    }
    const includeTypes = includeRaw.map((t) => {
      const known = IMDB_INCLUDE_TYPES.find((k) => k.toLowerCase() === t.toLowerCase());
      if (!known) throw new UserError(`--include-type expects ${IMDB_INCLUDE_TYPES.join(', ')} (got "${t}")`);
      return known;
    });
    if (collection !== undefined && as !== 'list') throw new UserError('--collection only applies with --as list');
    if (collection !== undefined && !collection.trim()) throw new UserError('--collection needs a name');
    if (checkinDates && as !== 'checkins') throw new UserError('--checkin-dates only applies with --as checkins');
    const imdbOpts: ImdbOptions = {
      ...(as ? { as: as as ImdbListKind } : {}),
      ...(collection ? { collection } : {}),
      includeTypes,
      checkinDates,
      notesFromDescription,
    };

    const ownedLists = strs(values, 'owned-list') ?? [];
    const lbOpts: LetterboxdOptions = { withReviews: bool(values, 'with-reviews'), watchlist: !bool(values, 'no-watchlist'), ownedLists };
    const lbFlags = ownedLists.length > 0 || bool(values, 'with-reviews') || bool(values, 'no-watchlist');
    const noLbFlags = () => {
      if (lbFlags) throw new UserError('--owned-list, --with-reviews and --no-watchlist only apply to Letterboxd exports');
    };
    if (letterboxd && imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);

    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      const secs = Number(timeout);
      if (!Number.isFinite(secs) || secs <= 0) throw new UserError(`--timeout must be a positive number of seconds (got "${timeout}")`);
      timeoutMs = Math.round(secs * 1000);
    }

    const keepBulkDates = bool(values, 'keep-bulk-dates');
    const replace = bool(values, 'replace');
    const dryRun = bool(values, 'dry-run');
    const source = appleTv || jellyfin || plex;
    if (keepBulkDates && source) throw new UserError('--keep-bulk-dates only applies to `import trakt`');

    let parsed: ParsedSource;
    if (appleTv) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      parsed = await readAppleTvImport(ctx, { timeoutMs });
    } else if (jellyfin) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      parsed = await readJellyfinImport(ctx, { ...jf, timeoutMs });
    } else if (plex) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      const res = await readPlexImport(ctx, plexOptionsFromFlags(values), dryRun);
      // `import plex --dry-run` shows what it read and never opens your library.
      if (res.dryRun) return emitPlexDryRun(ctx, res);
      if (!res.complete && replace) {
        throw new UserError(
          'The Plex listing may be incomplete (a library returned fewer movies than it reported, some movies could not be read, or a saved listing has no totals), so --replace could drop movies. Nothing was changed.',
        );
      }
      parsed = res;
    } else {
      parsed = readFileImport(ctx, {
        target: imdb ? 'imdb' : letterboxd ? 'letterboxd' : trakt ? 'trakt' : 'file',
        files,
        ...(format !== undefined ? { format: format as ImportFormat } : {}),
        imdb: imdbOpts,
        imdbFlags,
        letterboxd: lbOpts,
        letterboxdFlags: lbFlags,
        keepBulkDates,
        replace,
      });
    }
    emitImportOutcome(ctx, applyParsed(ctx, parsed, { replace, dryRun }), { dryRun });
  },
};
