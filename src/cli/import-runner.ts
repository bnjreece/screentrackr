/**
 * Each source's import run, apart from the `import` command's flags, so
 * `import` and `sync` run the same code: read a source to records
 * (readFileImport, readAppleTvImport, readPlexImport, readJellyfinImport),
 * apply them (applyParsed), and print the result (emitImportOutcome). The
 * run* functions do the first two for one source and return the outcome
 * without printing it, for `sync`.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { catalogReady, type Db } from '../core/db.js';
import { readAppleTvLibrary } from '../core/importers/apple-tv.js';
import { decodeImdbFile, parseImdb, type ImdbIncludeType, type ImdbOptions } from '../core/importers/imdb.js';
import {
  chooseLooseFiles,
  folderSource,
  looksLikeZip,
  parseLetterboxdExport,
  parseLetterboxdFiles,
  zipSource,
  type LetterboxdOptions,
  type LetterboxdParse,
} from '../core/importers/letterboxd.js';
import { isExcludedTraktName, MAX_ZIP_BYTES, parseTrakt, readTraktExport, traktFileOf } from '../core/importers/trakt.js';
import { jellyfinDeviceId, mapJellyfinItems, readJellyfinItems, type JellyfinAuth } from '../core/importers/jellyfin.js';
import { applyImport, detectFormat, parseImportDetailed, type ImportFormat, type ImportSummary, type ParsedImport } from '../core/importers/index.js';
import { listZip } from '../core/zip.js';
import { readPlexImport, type PlexImportOptions, type PlexParsed } from './commands/import-plex.js';
import { UserError, type Ctx } from './context.js';
import { promptHidden, readStdinSecret } from './secret.js';

export { readPlexImport, type PlexImportOptions };

export const IMDB_FLAGS_ONLY = '--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files';

/** The largest single file (a CSV, a JSON export, a paste) an import reads. */
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Read a whole file, after checking its size, so an oversized file (or a
 * ZIP renamed to .csv) is refused before it is read. `maxBytes` is
 * MAX_ZIP_BYTES for a whole export archive.
 */
function readBytes(file: string, maxBytes = MAX_IMPORT_FILE_BYTES): Buffer {
  try {
    const size = statSync(file).size;
    if (size > maxBytes) throw new UserError(`${basename(file)}: too large to read (over ${maxBytes} bytes). Nothing was imported.`);
    return readFileSync(file);
  } catch (err) {
    if (err instanceof UserError) throw err;
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

/** What one source read gives: its records plus what to print about them. */
export interface ParsedSource extends ParsedImport {
  format: ImportFormat | 'apple-tv' | 'plex' | 'jellyfin';
  notices: string[];
  skippedByType?: Record<string, number>;
  /** Extra fields for `--json` output. */
  extra?: Record<string, unknown>;
  plex?: PlexParsed['plex'];
  /** Warnings already printed (still reported in --json output). */
  logged?: string[];
}
type Parsed = ParsedSource;

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
    // Only the first bytes are read to tell a ZIP; readBytes checks its size
    // before the archive is read to list it.
    if (!looksLikeZip(readHead(path)) && !/\.zip$/i.test(path)) return null;
    names = listZip(readBytes(path, MAX_ZIP_BYTES))
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
    return fromLetterboxd(parseLetterboxdExport(isDir(first) ? folderSource(first) : zipSource(readBytes(first, MAX_ZIP_BYTES)), opts));
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

/** What `import jellyfin` reads, as typed options (from flags, or from a saved sync source). */
export interface JellyfinImportOptions {
  url: string | undefined;
  user: string | undefined;
  userId: string | undefined;
  tokenStdin: boolean;
  passwordStdin: boolean;
  ratings: boolean;
  strictPlayed: boolean;
  timeoutMs: number | undefined;
  /**
   * False under `sync`: never prompt for a password, so a missing
   * JELLYFIN_TOKEN fails this source. Default true.
   */
  interactive?: boolean;
}

/**
 * `import jellyfin`: the token comes from JELLYFIN_TOKEN or stdin, else the
 * user logs in with a password from stdin or a hidden prompt. Neither is ever
 * stored, printed or passed anywhere but the server's Authorization header.
 */
export async function readJellyfinImport(ctx: Ctx, f: JellyfinImportOptions): Promise<ParsedSource> {
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
    if (f.interactive === false) throw new UserError('No Jellyfin token. Set JELLYFIN_TOKEN (a sync never asks for a password).');
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


/** `import <file>`, `import imdb|letterboxd|trakt <files>`: what to read and the flags that steer it. */
export interface FileImportRequest {
  /** `file` is a plain `import <path>`, detected from its contents. */
  target: 'file' | 'imdb' | 'letterboxd' | 'trakt';
  files: string[];
  /** --format, for a plain file. */
  format?: ImportFormat;
  imdb: ImdbOptions;
  /** Whether any IMDb-only flag was given (refused for other formats). */
  imdbFlags: boolean;
  letterboxd: LetterboxdOptions;
  /** Whether any Letterboxd-only flag was given (refused for other formats). */
  letterboxdFlags: boolean;
  keepBulkDates: boolean;
  replace: boolean;
}

/** Read the files of an `import` to records. Throws UserError for a flag the detected format does not take. */
export function readFileImport(ctx: Ctx, req: FileImportRequest): ParsedSource {
  const { format, imdbFlags, replace, keepBulkDates } = req;
  const imdbOpts = req.imdb;
  const lbOpts = req.letterboxd;
  const files = req.files;
  const file = files[0] as string;
  const trakt = req.target === 'trakt';
  const imdb = req.target === 'imdb';
  const letterboxd = req.target === 'letterboxd';
  const noLbFlags = () => {
    if (req.letterboxdFlags) throw new UserError('--owned-list, --with-reviews and --no-watchlist only apply to Letterboxd exports');
  };
  if (letterboxd && imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);

  const plain = req.target === 'file';
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
  if (keepBulkDates && !traktRoute) throw new UserError('--keep-bulk-dates only applies to `import trakt`');
  // A Trakt export can't show that it is complete (a missing file may mean
  // "none" or "failed"), so it never replaces a library: it only merges.
  if (replace && traktRoute) throw new UserError(TRAKT_REPLACE);

  if (traktRoute) {
    if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
    noLbFlags();
    // The bounded reader checks each name against the allow-list before opening it.
    return parseTraktExport(files, keepBulkDates);
  }
  if (imdb) {
    noLbFlags();
    return parseImdbFiles(ctx.db(), files, imdbOpts);
  }
  if (letterboxd) return parseLetterboxdPaths(files, lbOpts);
  if (isDir(file) || looksLikeZip(readHead(file))) {
    // Any other folder or ZIP is read only as a Letterboxd export.
    if (format !== undefined && format !== 'letterboxd') throw new UserError(`${basename(file)} is a folder or ZIP archive, not a ${format} file`);
    if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
    return parseLetterboxdPaths([file], lbOpts);
  }
  const bytes = readBytes(file);
  const text = bytes.toString('utf8');
  const fmt = format ?? detectFormat(text, basename(file));
  if (fmt === 'imdb') {
    noLbFlags();
    return parseImdbFiles(ctx.db(), [file], imdbOpts);
  }
  if (fmt === 'letterboxd') {
    if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
    return parseLetterboxdPaths([file], lbOpts, true);
  }
  if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
  noLbFlags();
  return { ...parseImportDetailed(text, fmt, basename(file)), notices: [] };
}

/** Refused for a Trakt import, from flags or after detection. */
export const TRAKT_REPLACE =
  'A Trakt import only merges: an export cannot show that it is complete, so --replace could drop movies. Nothing was changed. Run it without --replace.';

export interface AppleTvImportOptions {
  /** How long to wait for the TV app (default 120 s). */
  timeoutMs?: number;
}

/** `import apple-tv`: read the TV app's library (macOS only). */
export async function readAppleTvImport(ctx: Ctx, opts: AppleTvImportOptions = {}): Promise<ParsedSource> {
  ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
  return { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs: opts.timeoutMs }), warnings: [], notices: [] };
}

/** One source's import: what was read and what applying it did (or, in a dry run, would do). */
export interface ImportOutcome {
  parsed: ParsedSource;
  summary: ImportSummary;
}

/**
 * Apply parsed records to the library, after the refusals that protect it
 * (a --replace with nothing to import). Prints the source's notices and
 * warnings to stderr. Never prints the result; see emitImportOutcome.
 */
export function applyParsed(ctx: Ctx, parsed: ParsedSource, opts: { replace?: boolean; dryRun?: boolean } = {}): ImportOutcome {
  const replace = opts.replace === true;
  // An empty IMDb export (only a header) is "no rows", never "delete everything".
  if ((parsed.format === 'imdb' || parsed.format === 'plex') && replace && parsed.records.length === 0) {
    throw new UserError(`Nothing to import from ${parsed.format === 'plex' ? 'Plex' : 'the IMDb file'}, so --replace would empty your library. Nothing was changed.`);
  }
  if (parsed.format === 'letterboxd' && replace && parsed.records.length === 0) {
    throw new UserError('Nothing to import from the Letterboxd export, so --replace would empty your library. Nothing was changed.');
  }
  // Detected from the file's contents (it was read to tell its format).
  if (replace && parsed.format === 'trakt') throw new UserError(TRAKT_REPLACE);
  // A server's state is not a whole library: unplayed movies would replace
  // watched ones and ratings left out would be cleared.
  if (replace && parsed.format === 'jellyfin') throw new UserError('--replace does not apply to `import jellyfin`; it always merges. Nothing was changed.');

  const db = ctx.db();
  for (const n of parsed.notices) ctx.log(n);
  const logged = new Set(parsed.logged);
  for (const w of parsed.warnings) if (!logged.has(w)) ctx.log(`Warning: ${w}`);
  if (!catalogReady(db)) ctx.log('The catalog is not built yet, so movies are left unmatched. Run `screentrackr setup` to match them.');
  const summary = applyImport(db, parsed.records, {
    mode: replace ? 'replace' : 'merge',
    dryRun: opts.dryRun === true,
    ...(parsed.lists ? { lists: parsed.lists } : {}),
  });
  return { parsed, summary };
}

/** Print an import's result: the --json object, or the summary lines. */
export function emitImportOutcome(ctx: Ctx, outcome: ImportOutcome, opts: { dryRun?: boolean } = {}): void {
  const { parsed, summary } = outcome;
  const dryRun = opts.dryRun === true;
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
            ...summary.reviews.map((v) => `  record ${v.record} "${v.sourceTitle}": items ${v.candidateIds.join(', ')}`),
            'Add a year, runtime or IMDb id to those records to pick one item, or update the item with `screentrackr set <id>`.',
          ].join('\n')
        : '',
      summary.needsReview ? 'Run `screentrackr match --review` to see the movies that need review.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** Read and apply files (`import <file>` and friends), merging unless `replace`. */
export function runFileImport(ctx: Ctx, req: FileImportRequest, opts: { dryRun?: boolean } = {}): ImportOutcome {
  return applyParsed(ctx, readFileImport(ctx, req), { replace: req.replace, dryRun: opts.dryRun });
}

/** Read the TV app and merge it (sync). */
export async function runAppleTvImport(ctx: Ctx, opts: AppleTvImportOptions & { dryRun?: boolean } = {}): Promise<ImportOutcome> {
  return applyParsed(ctx, await readAppleTvImport(ctx, opts), { dryRun: opts.dryRun });
}

/**
 * Read a Plex server and merge it (sync). Unlike `import plex --dry-run`,
 * which never opens the library, a dry run here runs the import and rolls it
 * back, so it reports what would change.
 */
export async function runPlexImport(ctx: Ctx, opts: PlexImportOptions & { dryRun?: boolean } = {}): Promise<ImportOutcome> {
  return applyParsed(ctx, await readPlexImport(ctx, opts, opts.dryRun === true), { dryRun: opts.dryRun });
}

/** Read a Jellyfin server and merge it (sync: pass interactive false so it never prompts). */
export async function runJellyfinImport(ctx: Ctx, opts: JellyfinImportOptions & { dryRun?: boolean }): Promise<ImportOutcome> {
  return applyParsed(ctx, await readJellyfinImport(ctx, opts), { dryRun: opts.dryRun });
}
