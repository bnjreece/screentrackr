import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { catalogReady, type Db } from '../../core/db.js';
import { readAppleTvLibrary } from '../../core/importers/apple-tv.js';
import {
  decodeImdbFile,
  IMDB_INCLUDE_TYPES,
  IMDB_LIST_KINDS,
  parseImdb,
  type ImdbIncludeType,
  type ImdbListKind,
  type ImdbOptions,
} from '../../core/importers/imdb.js';
import {
  chooseLooseFiles,
  folderSource,
  looksLikeZip,
  parseLetterboxdExport,
  parseLetterboxdFiles,
  zipSource,
  type LetterboxdOptions,
  type LetterboxdParse,
} from '../../core/importers/letterboxd.js';
import { isExcludedTraktName, MAX_ZIP_BYTES, parseTrakt, readTraktExport, traktFileOf } from '../../core/importers/trakt.js';
import { jellyfinDeviceId, mapJellyfinItems, readJellyfinItems, type JellyfinAuth } from '../../core/importers/jellyfin.js';
import { applyImport, detectFormat, FORMATS, parseImportDetailed, type ImportFormat, type ParsedImport } from '../../core/importers/index.js';
import { listZip } from '../../core/zip.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { promptHidden, readStdinSecret } from '../secret.js';
import { emitPlexDryRun, PLEX_OPTIONS, readPlexImport, rejectPlexFlags, type PlexParsed } from './import-plex.js';

const IMDB_FLAGS_ONLY = '--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files';

function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (err) {
    throw new UserError(`Could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/** The first four bytes of a file (fewer when it is shorter). */
function readHead(file: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(4);
    return buf.subarray(0, readSync(fd, buf, 0, 4, 0));
  } catch (err) {
    throw new UserError(`Could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether the catalog was built with TV movies, so IMDb's TV Movie rows can match. */
function catalogHasTvMovies(db: Db): boolean {
  const row = db.sql.prepare("SELECT value FROM meta WHERE key = 'catalog_include_tv_movies'").get() as { value: string | null } | undefined;
  return row?.value === '1';
}

interface Parsed extends ParsedImport {
  format: ImportFormat | 'apple-tv' | 'plex' | 'jellyfin';
  notices: string[];
  skippedByType?: Record<string, number>;
  /** Extra fields for `--json` output. */
  extra?: Record<string, unknown>;
  plex?: PlexParsed['plex'];
  /** Warnings already printed (still reported in --json output). */
  logged?: string[];
}

/** `import trakt`: Trakt's data export ZIP, its folder, or single files from it. Only allow-listed files are read. */
function parseTraktExport(paths: string[], keepBulkDates: boolean): Parsed {
  const { files, skippedFiles } = readTraktExport(paths);
  const res = parseTrakt(files, { keepBulkDates });
  const notices = [...res.notices];
  if (skippedFiles) notices.push(`Left ${skippedFiles} other file${skippedFiles === 1 ? '' : 's'} in the export unread (only movie history, ratings, watchlist and collection are read).`);
  return {
    format: 'trakt',
    records: res.records,
    warnings: res.warnings,
    notices,
    extra: { skippedTv: res.skippedTv, skippedFiles, exportErrors: res.exportErrors, incomplete: res.incomplete, bulkDated: res.bulkDated },
  };
}

function parseImdbFiles(db: Db, files: string[], opts: ImdbOptions): Parsed {
  const warnings: string[] = [];
  const inputs = files.map((file) => {
    const decoded = decodeImdbFile(readBytes(file));
    if (decoded.warning) warnings.push(`${basename(file)}: ${decoded.warning}`);
    return { name: basename(file), text: decoded.text };
  });
  const includeTypes = new Set<ImdbIncludeType>(opts.includeTypes ?? []);
  if (catalogHasTvMovies(db)) includeTypes.add('tvMovie');
  const res = parseImdb(inputs, { ...opts, includeTypes: [...includeTypes] });
  return {
    format: 'imdb',
    records: res.records,
    warnings: [...warnings, ...res.warnings, ...res.skippedSummary],
    notices: res.notices,
    skippedByType: res.skippedByType,
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What a ZIP or folder given to a plain `import` holds, told from its entry
 * names alone (no entry is inflated, no file inside is opened): a Letterboxd
 * export has a watched.csv, a Trakt export has its allow-listed JSON files.
 * Returns null for a path that is neither a folder nor a ZIP.
 */
function archiveKind(path: string): 'letterboxd' | 'trakt' | null {
  let names: string[];
  if (isDir(path)) {
    names = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(join(dir, d.name), depth + 1);
        else if (d.isFile()) names.push(d.name);
      }
    };
    walk(path, 0);
  } else {
    // Only the first bytes are read to tell a ZIP, and its size is checked
    // before the archive is read to list it.
    if (!looksLikeZip(readHead(path)) && !/\.zip$/i.test(path)) return null;
    const size = statSync(path).size;
    if (size > MAX_ZIP_BYTES) throw new UserError(`${basename(path)}: too large to read (over ${MAX_ZIP_BYTES} bytes). Nothing was imported.`);
    names = listZip(readBytes(path))
      .filter((e) => !e.unsafe)
      .map((e) => basename(e.name.replace(/\\/g, '/')));
  }
  const isLetterboxd = names.some((n) => n.toLowerCase() === 'watched.csv');
  const isTrakt = names.some((n) => traktFileOf(n) !== null);
  if (isLetterboxd && isTrakt) {
    throw new UserError(`${basename(path)} holds both a Letterboxd and a Trakt export. Use \`screentrackr import letterboxd\` or \`screentrackr import trakt\` to say which.`);
  }
  if (isTrakt) return 'trakt';
  if (isLetterboxd) return 'letterboxd';
  throw new UserError(
    `${basename(path)} is a folder or ZIP archive, but not a Letterboxd export (no watched.csv) or a Trakt export (no watched-history, ratings-movies or other Trakt export file). Nothing was imported.`,
  );
}

function fromLetterboxd(res: LetterboxdParse): Parsed {
  return { format: 'letterboxd', records: res.records, warnings: res.warnings, notices: res.notices };
}

/**
 * A Letterboxd export: one ZIP or folder, or loose CSV files from one. Only
 * the files the import needs are opened (see core/importers/letterboxd.ts).
 */
function parseLetterboxdPaths(paths: string[], opts: LetterboxdOptions, detected = false): Parsed {
  const first = paths[0] as string;
  const whole = isDir(first) || (!first.toLowerCase().endsWith('.csv') && looksLikeZip(readHead(first)));
  if (whole) {
    if (paths.length > 1) throw new UserError('Pass one Letterboxd export (a ZIP or a folder) at a time, or its CSV files');
    if (!isDir(first) && statSync(first).size > MAX_ZIP_BYTES) {
      throw new UserError(`${basename(first)}: too large to read (over ${MAX_ZIP_BYTES} bytes). Nothing was imported.`);
    }
    return fromLetterboxd(parseLetterboxdExport(isDir(first) ? folderSource(first) : zipSource(readBytes(first)), opts));
  }
  if (paths.some(isDir)) throw new UserError('Pass one Letterboxd export (a ZIP or a folder) at a time, or its CSV files');
  // Decide from the paths alone which files to open, so a glob over the
  // export never opens profile.csv, comments.csv or deleted/ entries.
  const chosen = chooseLooseFiles(paths, opts, !detected);
  const warnings = [...chosen.warnings];
  const files = chosen.open.map((path) => {
    const decoded = decodeImdbFile(readBytes(path));
    if (decoded.warning) warnings.push(`${basename(path)}: ${decoded.warning}`);
    return { name: basename(path), text: decoded.text };
  });
  const res = fromLetterboxd(parseLetterboxdFiles(files, opts));
  return { ...res, warnings: [...warnings, ...res.warnings], notices: [...chosen.notices, ...res.notices] };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0';
  } catch {
    return '0';
  }
}

interface JellyfinFlags {
  url: string | undefined;
  user: string | undefined;
  userId: string | undefined;
  tokenStdin: boolean;
  passwordStdin: boolean;
  ratings: boolean;
  strictPlayed: boolean;
  timeoutMs: number | undefined;
}

/**
 * `import jellyfin`: the token comes from JELLYFIN_TOKEN or stdin, else the
 * user logs in with a password from stdin or a hidden prompt. Neither is ever
 * stored, printed or passed anywhere but the server's Authorization header.
 */
async function readJellyfin(ctx: Ctx, f: JellyfinFlags): Promise<Parsed> {
  if (!f.url) throw new UserError('Usage: screentrackr import jellyfin --url <server> --user <name>');
  if (f.tokenStdin && f.passwordStdin) throw new UserError('Use either --token-stdin or --password-stdin, not both');
  const envToken = process.env.JELLYFIN_TOKEN;
  if (f.passwordStdin && envToken) throw new UserError('JELLYFIN_TOKEN is set, so --password-stdin is not used. Unset JELLYFIN_TOKEN to sign in with a password.');
  let auth: JellyfinAuth;
  if (f.tokenStdin || envToken) {
    const token = f.tokenStdin ? readStdinSecret('token', '--token-stdin') : (envToken as string);
    if (!token.trim()) throw new UserError(f.tokenStdin ? 'No token on stdin.' : 'JELLYFIN_TOKEN is empty.');
    auth = { token, ...(f.userId ? { userId: f.userId } : {}), ...(f.user ? { userName: f.user } : {}) };
  } else {
    if (f.userId) throw new UserError('--user-id only applies with a token (JELLYFIN_TOKEN or --token-stdin)');
    if (!f.user) throw new UserError('Pass --user <name> to sign in, or set JELLYFIN_TOKEN.');
    let password: string;
    if (f.passwordStdin) password = readStdinSecret('password', '--password-stdin');
    else if (process.stdin.isTTY) password = await promptHidden(`Jellyfin password for ${f.user}: `);
    else throw new UserError('No password: pipe it in with --password-stdin, or set JELLYFIN_TOKEN.');
    auth = { userName: f.user, password };
  }
  // Open the library first, so a library problem stops the import before any request.
  ctx.db();
  ctx.log('Reading your movies from the Jellyfin server (read only).');
  const read = await readJellyfinItems({
    url: f.url,
    auth,
    version: packageVersion(),
    deviceId: jellyfinDeviceId(ctx.home),
    ...(f.timeoutMs !== undefined ? { timeoutMs: f.timeoutMs } : {}),
  });
  // The read's warnings (a session that could not be signed out) are printed
  // now, so a later failure (mapping, the import itself) never hides them.
  for (const w of read.warnings) ctx.log(`Warning: ${w}`);
  const res = mapJellyfinItems(read.items, { ratings: f.ratings, strictPlayed: f.strictPlayed });
  return {
    format: 'jellyfin',
    records: res.records,
    warnings: [...read.warnings, ...res.warnings, ...res.skippedSummary],
    notices: [`Read ${read.items.length} items for ${read.userName}.`, ...res.notices],
    skippedByType: res.skippedByType,
    logged: read.warnings,
  };
}

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv|imdb <file.csv>...|letterboxd <export.zip|folder|file.csv>...|trakt <export.zip|folder>...> [--format <format>] [--merge | --replace] [--dry-run]',
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
    const jf: Omit<JellyfinFlags, 'timeoutMs'> = {
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

    const plain = !trakt && !imdb && !letterboxd && !appleTv && !plex && !jellyfin;
    // The other files of a Trakt export (account settings, other people,
    // comments, lists) are refused by name, before they are opened.
    if (plain && isExcludedTraktName(file)) {
      throw new UserError(
        `${basename(file)}: a Trakt export file ScreenTrackr does not read (only movie history, ratings, watchlist and collection are). It was not opened. Use \`screentrackr import trakt <the export ZIP>\`.`,
      );
    }
    // A Trakt export's ZIP, or one of the files it reads, goes to the bounded
    // Trakt reader, as with `import trakt`.
    // A plain ZIP or folder goes to the reader its entry names point to.
    const plainArchive = plain && format === undefined && traktFileOf(file) === null ? archiveKind(file) : null;
    const traktRoute = trakt || format === 'trakt' || (plain && format === undefined && (traktFileOf(file) !== null || plainArchive === 'trakt'));
    const keepBulkDates = bool(values, 'keep-bulk-dates');
    if (keepBulkDates && !traktRoute) throw new UserError('--keep-bulk-dates only applies to `import trakt`');
    const replace = bool(values, 'replace');
    // A Trakt export can't show that it is complete (a missing file may mean
    // "none" or "failed"), so it never replaces a library: it only merges.
    const traktReplace =
      'A Trakt import only merges: an export cannot show that it is complete, so --replace could drop movies. Nothing was changed. Run it without --replace.';
    if (replace && traktRoute) throw new UserError(traktReplace);

    let parsed: Parsed;
    if (traktRoute) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      // The bounded reader checks each name against the allow-list before opening it.
      parsed = parseTraktExport(files, keepBulkDates);
    } else if (appleTv) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
      parsed = { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs }), warnings: [], notices: [] };
    } else if (jellyfin) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      parsed = await readJellyfin(ctx, { ...jf, timeoutMs });
    } else if (imdb) {
      noLbFlags();
      parsed = parseImdbFiles(ctx.db(), files, imdbOpts);
    } else if (plex) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      const res = await readPlexImport(ctx, values);
      if (res.dryRun) return emitPlexDryRun(ctx, res);
      if (!res.complete && bool(values, 'replace')) {
        throw new UserError(
          'The Plex listing may be incomplete (a library returned fewer movies than it reported, some movies could not be read, or a saved listing has no totals), so --replace could drop movies. Nothing was changed.',
        );
      }
      parsed = res;
    } else if (letterboxd) {
      parsed = parseLetterboxdPaths(files, lbOpts);
    } else if (isDir(file) || looksLikeZip(readHead(file))) {
      // Any other folder or ZIP is read only as a Letterboxd export.
      if (format !== undefined && format !== 'letterboxd') throw new UserError(`${basename(file)} is a folder or ZIP archive, not a ${format} file`);
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      parsed = parseLetterboxdPaths([file], lbOpts);
    } else {
      const bytes = readBytes(file);
      const text = bytes.toString('utf8');
      const fmt = (format as ImportFormat | undefined) ?? detectFormat(text, basename(file));
      if (fmt === 'imdb') {
        noLbFlags();
        parsed = parseImdbFiles(ctx.db(), [file], imdbOpts);
      } else if (fmt === 'letterboxd') {
        if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
        parsed = parseLetterboxdPaths([file], lbOpts, true);
      } else {
        if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
        noLbFlags();
        parsed = { ...parseImportDetailed(text, fmt, basename(file)), notices: [] };
      }
    }

    // An empty IMDb export (only a header) is "no rows", never "delete everything".
    if ((parsed.format === 'imdb' || parsed.format === 'plex') && replace && parsed.records.length === 0) {
      throw new UserError(`Nothing to import from ${parsed.format === 'plex' ? 'Plex' : 'the IMDb file'}, so --replace would empty your library. Nothing was changed.`);
    }
    if (parsed.format === 'letterboxd' && replace && parsed.records.length === 0) {
      throw new UserError('Nothing to import from the Letterboxd export, so --replace would empty your library. Nothing was changed.');
    }
    // Detected from the file's contents (it was read to tell its format).
    if (replace && parsed.format === 'trakt') throw new UserError(traktReplace);

    const db = ctx.db();
    for (const n of parsed.notices) ctx.log(n);
    const logged = new Set(parsed.logged);
    for (const w of parsed.warnings) if (!logged.has(w)) ctx.log(`Warning: ${w}`);
    if (!catalogReady(db)) ctx.log('The catalog is not built yet, so movies are left unmatched. Run `screentrackr setup` to match them.');
    const dryRun = bool(values, 'dry-run');
    const summary = applyImport(db, parsed.records, { mode: replace ? 'replace' : 'merge', dryRun });

    const extra = {
      ...(parsed.skippedByType ? { skippedByType: parsed.skippedByType } : {}),
      ...(parsed.plex ? { plex: parsed.plex } : {}),
      ...parsed.extra,
    };
    ctx.emit({ format: parsed.format, records: parsed.records.length, warnings: parsed.warnings, ...extra, ...summary }, () =>
      [
        dryRun ? `Dry run: nothing was changed. ${parsed.records.length} records (${parsed.format}).` : `Imported ${parsed.records.length} records (${parsed.format}).`,
        dryRun
          ? `Would add ${summary.added}, update ${summary.updated}, leave unchanged ${summary.unchanged}, needs review ${summary.needsReview}.`
          : `Added ${summary.added}, updated ${summary.updated}, unchanged ${summary.unchanged}, needs review ${summary.needsReview}.`,
        summary.backupPath ? `Backup of the previous library: ${summary.backupPath}` : '',
        summary.reviews.length
          ? [
              `Not imported, ${summary.reviews.length} record${summary.reviews.length === 1 ? '' : 's'} that could be more than one item (nothing was changed):`,
              ...summary.reviews.map(
                (v) => `  record ${v.record} "${v.sourceTitle}": items ${v.candidateIds.join(', ')}`,
              ),
              'Add a year, runtime or IMDb id to those records to pick one item, or update the item with `screentrackr set <id>`.',
            ].join('\n')
          : '',
        summary.needsReview ? 'Run `screentrackr match --review` to see the movies that need review.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
};
