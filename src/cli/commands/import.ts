import { readFileSync, statSync } from 'node:fs';
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
import {
  folderSource,
  looksLikeZip,
  parseLetterboxdExport,
  parseLetterboxdFiles,
  zipSource,
  type LetterboxdOptions,
  type LetterboxdParse,
} from '../../core/importers/letterboxd.js';
import { applyImport, detectFormat, FORMATS, parseImportDetailed, type ImportFormat, type ParsedImport } from '../../core/importers/index.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError } from '../context.js';

const IMDB_FLAGS_ONLY = '--as, --collection, --include-type, --checkin-dates and --notes-from-description only apply to IMDb files';

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
  format: ImportFormat | 'apple-tv';
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

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fromLetterboxd(res: LetterboxdParse): Parsed {
  return { format: 'letterboxd', records: res.records, warnings: res.warnings, notices: res.notices };
}

/**
 * A Letterboxd export: one ZIP or folder, or loose CSV files from one. Only
 * the files the import needs are opened (see core/importers/letterboxd.ts).
 */
function parseLetterboxdPaths(paths: string[], opts: LetterboxdOptions): Parsed {
  const first = paths[0] as string;
  const whole = isDir(first) || (!first.toLowerCase().endsWith('.csv') && looksLikeZip(readBytes(first)));
  if (whole) {
    if (paths.length > 1) throw new UserError('Pass one Letterboxd export (a ZIP or a folder) at a time, or its CSV files');
    return fromLetterboxd(parseLetterboxdExport(isDir(first) ? folderSource(first) : zipSource(readBytes(first)), opts));
  }
  const warnings: string[] = [];
  const files = paths.map((path) => {
    if (isDir(path)) throw new UserError('Pass one Letterboxd export (a ZIP or a folder) at a time, or its CSV files');
    const decoded = decodeImdbFile(readBytes(path));
    if (decoded.warning) warnings.push(`${basename(path)}: ${decoded.warning}`);
    return { name: basename(path), text: decoded.text };
  });
  const res = fromLetterboxd(parseLetterboxdFiles(files, opts));
  return { ...res, warnings: [...warnings, ...res.warnings] };
}

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv|imdb <file.csv>...|letterboxd <export.zip|folder|file.csv>...> [--format <format>] [--merge | --replace] [--dry-run]',
  details: [
    `Formats: ${FORMATS.join(', ')}. The format is detected when --format is omitted.`,
    "`import apple-tv` (experimental, macOS only) reads the TV app's library directly. Movies with a recorded play date are marked watched; the rest keep their current status.",
    "`import imdb <file.csv>...` reads IMDb CSV exports you downloaded from imdb.com (Your Ratings, your watchlist, check-ins or a list). Rated movies are marked watched with your rating; watchlist movies go in the queue only when they are new; nothing is marked owned. Several files are read together. --as says what a list export is (watchlist by default), --collection names a list's collection, --include-type brings in more than movies (repeatable or comma-separated: " +
      IMDB_INCLUDE_TYPES.join(', ') +
      '), --checkin-dates uses check-in dates as watched dates, --notes-from-description keeps a list row\'s Description as notes.',
    "`import letterboxd <export.zip|folder|file.csv>...` reads the export you downloaded from letterboxd.com (Settings, Data). Watched and rated films are marked watched, with half stars stored times two (1 to 10); the watched date comes from your diary; watchlist films go in the queue only when they are new; nothing is marked owned unless you name a list with --owned-list <slug> (repeatable). --with-reviews takes your latest review as notes for movies with none; --no-watchlist leaves the watchlist out.",
    '--merge adds new movies and updates fields the file has; it never clears a status or rating the file lacks. A record that fits more than one item is not imported and is listed with the candidate item ids.',
    '--replace backs up your library to backups/ first, then replaces it.',
    '--dry-run reports what the import would add, update and leave for review, and changes nothing (no backup either).',
  ].join('\n'),
  options: {
    format: { type: 'string', value: '<format>', description: `One of ${FORMATS.join(', ')}` },
    merge: { type: 'boolean', description: 'Merge into the library (the default)' },
    replace: { type: 'boolean', description: 'Replace the library, after a backup' },
    timeout: { type: 'string', value: '<seconds>', description: 'apple-tv only: how long to wait for the TV app (default 120)' },
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
    'notes-from-description': { type: 'boolean', description: "imdb only: use a list row's Description as the movie's notes (fills blank notes)" },
    'dry-run': { type: 'boolean', description: 'Show what the import would do without changing anything' },
  },
  async run(ctx, pos, values) {
    const file = pos[0];
    if (!file) throw new UserError('Usage: screentrackr import <file>');
    const imdb = file === 'imdb';
    const letterboxd = file === 'letterboxd';
    const files = imdb || letterboxd ? pos.slice(1) : [file];
    if (imdb && !files.length) throw new UserError('Usage: screentrackr import imdb <file.csv>...');
    if (letterboxd && !files.length) throw new UserError('Usage: screentrackr import letterboxd <export.zip|folder|file.csv>...');
    if (!imdb && !letterboxd && pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    if (bool(values, 'merge') && bool(values, 'replace')) throw new UserError('Use either --merge or --replace, not both');
    const format = str(values, 'format');
    const timeout = str(values, 'timeout');
    const appleTv = file === 'apple-tv';
    if ((appleTv || imdb || letterboxd) && format !== undefined) throw new UserError(`--format does not apply to \`import ${file}\``);
    if (!appleTv && timeout !== undefined) throw new UserError('--timeout only applies to `import apple-tv`');
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

    let parsed: Parsed;
    if (appleTv) {
      if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
      noLbFlags();
      ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
      parsed = { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs }), warnings: [], notices: [] };
    } else if (imdb) {
      noLbFlags();
      parsed = parseImdbFiles(ctx.db(), files, imdbOpts);
    } else if (letterboxd) {
      parsed = parseLetterboxdPaths(files, lbOpts);
    } else if (isDir(file) || looksLikeZip(readBytes(file))) {
      // A folder or ZIP is read only as a Letterboxd export.
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
        parsed = parseLetterboxdPaths([file], lbOpts);
      } else {
        if (imdbFlags) throw new UserError(IMDB_FLAGS_ONLY);
        noLbFlags();
        parsed = { ...parseImportDetailed(text, fmt, basename(file)), notices: [] };
      }
    }

    const replace = bool(values, 'replace');
    // An empty IMDb export (only a header) is "no rows", never "delete everything".
    if (parsed.format === 'imdb' && replace && parsed.records.length === 0) {
      throw new UserError('Nothing to import from the IMDb file, so --replace would empty your library. Nothing was changed.');
    }
    if (parsed.format === 'letterboxd' && replace && parsed.records.length === 0) {
      throw new UserError('Nothing to import from the Letterboxd export, so --replace would empty your library. Nothing was changed.');
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
