import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
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
import { jellyfinDeviceId, mapJellyfinItems, readJellyfinItems, type JellyfinAuth } from '../../core/importers/jellyfin.js';
import { applyImport, detectFormat, FORMATS, parseImportDetailed, type ImportFormat, type ParsedImport } from '../../core/importers/index.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { promptHidden, readStdinSecret } from '../secret.js';

function readBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (err) {
    throw new UserError(`Could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/** Whether the catalog was built with TV movies, so IMDb's TV Movie rows can match. */
function catalogHasTvMovies(db: Db): boolean {
  const row = db.sql.prepare("SELECT value FROM meta WHERE key = 'catalog_include_tv_movies'").get() as { value: string | null } | undefined;
  return row?.value === '1';
}

interface Parsed extends ParsedImport {
  format: ImportFormat | 'apple-tv' | 'jellyfin';
  notices: string[];
  skippedByType?: Record<string, number>;
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
  ctx.log('Reading your movies from the Jellyfin server (read only).');
  const read = await readJellyfinItems({
    url: f.url,
    auth,
    version: packageVersion(),
    deviceId: jellyfinDeviceId(ctx.home),
    ...(f.timeoutMs !== undefined ? { timeoutMs: f.timeoutMs } : {}),
  });
  const res = mapJellyfinItems(read.items, { ratings: f.ratings, strictPlayed: f.strictPlayed });
  return {
    format: 'jellyfin',
    records: res.records,
    warnings: [...read.warnings, ...res.warnings, ...res.skippedSummary],
    notices: [`Read ${read.items.length} items for ${read.userName}.`, ...res.notices],
    skippedByType: res.skippedByType,
  };
}

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv|imdb <file.csv>...> [--format <format>] [--merge | --replace] [--dry-run]',
  details: [
    `Formats: ${FORMATS.join(', ')}. The format is detected when --format is omitted.`,
    "`import apple-tv` (experimental, macOS only) reads the TV app's library directly. Movies with a recorded play date are marked watched; the rest keep their current status.",
    "`import imdb <file.csv>...` reads IMDb CSV exports you downloaded from imdb.com (Your Ratings, your watchlist, check-ins or a list). Rated movies are marked watched with your rating; watchlist movies go in the queue only when they are new; nothing is marked owned. Several files are read together. --as says what a list export is (watchlist by default), --collection names a list's collection, --include-type brings in more than movies (repeatable or comma-separated: " +
      IMDB_INCLUDE_TYPES.join(', ') +
      '), --checkin-dates uses check-in dates as watched dates, --notes-from-description keeps a list row\'s Description as notes.',
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
    url: { type: 'string', value: '<server>', description: 'jellyfin only: your server address, such as http://localhost:8096' },
    user: { type: 'string', value: '<name>', description: 'jellyfin only: whose library to read (and who signs in without a token)' },
    'user-id': { type: 'string', value: '<id>', description: 'jellyfin only, with an admin API key: the user id whose library to read' },
    'token-stdin': { type: 'boolean', description: 'jellyfin only: read the access token from stdin instead of JELLYFIN_TOKEN' },
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
    const jellyfin = file === 'jellyfin';
    const files = imdb ? pos.slice(1) : [file];
    if (imdb && !files.length) throw new UserError('Usage: screentrackr import imdb <file.csv>...');
    if (!imdb && pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    const jf: Omit<JellyfinFlags, 'timeoutMs'> = {
      url: str(values, 'url'),
      user: str(values, 'user'),
      userId: str(values, 'user-id'),
      tokenStdin: bool(values, 'token-stdin'),
      passwordStdin: bool(values, 'password-stdin'),
      ratings: bool(values, 'ratings'),
      strictPlayed: bool(values, 'strict-played'),
    };
    const jellyfinFlags =
      jf.url !== undefined || jf.user !== undefined || jf.userId !== undefined || jf.tokenStdin || jf.passwordStdin || jf.ratings || jf.strictPlayed;
    if (!jellyfin && jellyfinFlags) {
      throw new UserError('--url, --user, --user-id, --token-stdin, --password-stdin, --ratings and --strict-played only apply to `import jellyfin`');
    }
    if (bool(values, 'merge') && bool(values, 'replace')) throw new UserError('Use either --merge or --replace, not both');
    const format = str(values, 'format');
    const timeout = str(values, 'timeout');
    const appleTv = file === 'apple-tv';
    // A server's state is not a whole library: unplayed movies would replace
    // watched ones and ratings left out would be cleared.
    if (jellyfin && bool(values, 'replace')) throw new UserError('--replace does not apply to `import jellyfin`; it always merges. Nothing was changed.');
    if ((appleTv || imdb || jellyfin) && format !== undefined) throw new UserError(`--format does not apply to \`import ${file}\``);
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

    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      const secs = Number(timeout);
      if (!Number.isFinite(secs) || secs <= 0) throw new UserError(`--timeout must be a positive number of seconds (got "${timeout}")`);
      timeoutMs = Math.round(secs * 1000);
    }

    let parsed: Parsed;
    if (appleTv) {
      if (imdbFlags) throw new UserError('--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files');
      ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
      parsed = { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs }), warnings: [], notices: [] };
    } else if (jellyfin) {
      if (imdbFlags) throw new UserError('--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files');
      parsed = await readJellyfin(ctx, { ...jf, timeoutMs });
    } else if (imdb) {
      parsed = parseImdbFiles(ctx.db(), files, imdbOpts);
    } else {
      const bytes = readBytes(file);
      const text = bytes.toString('utf8');
      const fmt = (format as ImportFormat | undefined) ?? detectFormat(text, basename(file));
      if (fmt === 'imdb') {
        parsed = parseImdbFiles(ctx.db(), [file], imdbOpts);
      } else {
        if (imdbFlags) throw new UserError('--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files');
        parsed = { ...parseImportDetailed(text, fmt, basename(file)), notices: [] };
      }
    }

    const replace = bool(values, 'replace');
    // An empty IMDb export (only a header) is "no rows", never "delete everything".
    if (parsed.format === 'imdb' && replace && parsed.records.length === 0) {
      throw new UserError('Nothing to import from the IMDb file, so --replace would empty your library. Nothing was changed.');
    }

    const db = ctx.db();
    for (const n of parsed.notices) ctx.log(n);
    for (const w of parsed.warnings) ctx.log(`Warning: ${w}`);
    if (!catalogReady(db)) ctx.log('The catalog is not built yet, so movies are left unmatched. Run `screentrackr setup` to match them.');
    const dryRun = bool(values, 'dry-run');
    const summary = applyImport(db, parsed.records, { mode: replace ? 'replace' : 'merge', dryRun });

    const extra = parsed.skippedByType ? { skippedByType: parsed.skippedByType } : {};
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
