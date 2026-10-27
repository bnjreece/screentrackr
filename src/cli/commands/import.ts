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
import { parseTrakt, readTraktExport } from '../../core/importers/trakt.js';
import { applyImport, detectFormat, FORMATS, parseImportDetailed, type ImportFormat, type ParsedImport } from '../../core/importers/index.js';
import { bool, str, strs, type Command } from '../command.js';
import { UserError } from '../context.js';

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
  /** Extra fields for `--json` output. */
  extra?: Record<string, unknown>;
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

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv|imdb <file.csv>...|trakt <export.zip|folder>...> [--format <format>] [--merge | --replace]',
  details: [
    `Formats: ${FORMATS.join(', ')}. The format is detected when --format is omitted.`,
    "`import apple-tv` (experimental, macOS only) reads the TV app's library directly. Movies with a recorded play date are marked watched; the rest keep their current status.",
    "`import imdb <file.csv>...` reads IMDb CSV exports you downloaded from imdb.com (Your Ratings, your watchlist, check-ins or a list). Rated movies are marked watched with your rating; watchlist movies go in the queue only when they are new; nothing is marked owned. Several files are read together. --as says what a list export is (watchlist by default), --collection names a list's collection, --include-type brings in more than movies (repeatable or comma-separated: " +
      IMDB_INCLUDE_TYPES.join(', ') +
      '), --checkin-dates uses check-in dates as watched dates.',
    "`import trakt <export.zip|folder>` reads the data export you download from Trakt (Settings > Data > Raw export), or files from it. Only movie history, ratings, watchlist, collection and the export's error list are read. Watched movies are marked watched with the latest play's date, watchlist movies go in the queue only when they are new, and only the collection marks a movie owned. Plays logged in bulk (10 or more at the same second) lose their dates unless --keep-bulk-dates. It only merges (--replace is refused). Nothing is fetched from Trakt.",
    '--merge adds new movies and updates fields the file has; it never clears a status or rating the file lacks. A record that fits more than one item is not imported and is listed with the candidate item ids.',
    '--replace backs up your library to backups/ first, then replaces it.',
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
    'keep-bulk-dates': { type: 'boolean', description: 'trakt only: keep the dates of plays logged in bulk' },
  },
  async run(ctx, pos, values) {
    const file = pos[0];
    if (!file) throw new UserError('Usage: screentrackr import <file>');
    const imdb = file === 'imdb';
    const trakt = file === 'trakt';
    const files = imdb || trakt ? pos.slice(1) : [file];
    if (imdb && !files.length) throw new UserError('Usage: screentrackr import imdb <file.csv>...');
    if (trakt && !files.length) throw new UserError('Usage: screentrackr import trakt <trakt-export.zip | folder | file.json>...');
    if (!imdb && !trakt && pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    if (bool(values, 'merge') && bool(values, 'replace')) throw new UserError('Use either --merge or --replace, not both');
    const format = str(values, 'format');
    const timeout = str(values, 'timeout');
    const appleTv = file === 'apple-tv';
    if ((appleTv || imdb || trakt) && format !== undefined) throw new UserError(`--format does not apply to \`import ${file}\``);
    if (!appleTv && timeout !== undefined) throw new UserError('--timeout only applies to `import apple-tv`');
    if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`Unknown format "${format}" (expected ${FORMATS.join(', ')})`);
    }

    const as = str(values, 'as');
    const collection = str(values, 'collection');
    const includeRaw = (strs(values, 'include-type') ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    const checkinDates = bool(values, 'checkin-dates');
    const imdbFlags = as !== undefined || collection !== undefined || includeRaw.length > 0 || checkinDates;
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
    };

    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      const secs = Number(timeout);
      if (!Number.isFinite(secs) || secs <= 0) throw new UserError(`--timeout must be a positive number of seconds (got "${timeout}")`);
      timeoutMs = Math.round(secs * 1000);
    }

    const keepBulkDates = bool(values, 'keep-bulk-dates');
    if (keepBulkDates && !trakt) throw new UserError('--keep-bulk-dates only applies to `import trakt`');
    const replace = bool(values, 'replace');
    // A Trakt export can't show that it is complete (a missing file may mean
    // "none" or "failed"), so it never replaces a library: it only merges.
    const traktReplace =
      'A Trakt import only merges: an export cannot show that it is complete, so --replace could drop movies. Nothing was changed. Run it without --replace.';
    if (replace && (trakt || format === 'trakt')) throw new UserError(traktReplace);

    let parsed: Parsed;
    if (trakt || format === 'trakt') {
      if (imdbFlags) throw new UserError('--as, --collection, --include-type and --checkin-dates only apply to IMDb files');
      // The bounded reader checks each name against the allow-list before opening it.
      parsed = parseTraktExport(files, keepBulkDates);
    } else if (appleTv) {
      if (imdbFlags) throw new UserError('--as, --collection, --include-type and --checkin-dates only apply to IMDb files');
      ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
      parsed = { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs }), warnings: [], notices: [] };
    } else if (imdb) {
      parsed = parseImdbFiles(ctx.db(), files, imdbOpts);
    } else {
      const bytes = readBytes(file);
      const text = bytes.toString('utf8');
      const fmt = (format as ImportFormat | undefined) ?? detectFormat(text, basename(file));
      if (fmt === 'imdb') {
        parsed = parseImdbFiles(ctx.db(), [file], imdbOpts);
      } else {
        if (imdbFlags) throw new UserError('--as, --collection, --include-type and --checkin-dates only apply to IMDb files');
        parsed = { ...parseImportDetailed(text, fmt, basename(file)), notices: [] };
      }
    }

    // An empty IMDb export (only a header) is "no rows", never "delete everything".
    if (parsed.format === 'imdb' && replace && parsed.records.length === 0) {
      throw new UserError('Nothing to import from the IMDb file, so --replace would empty your library. Nothing was changed.');
    }
    // Detected from the file's contents (it was read to tell its format).
    if (replace && parsed.format === 'trakt') throw new UserError(traktReplace);

    const db = ctx.db();
    for (const n of parsed.notices) ctx.log(n);
    for (const w of parsed.warnings) ctx.log(`Warning: ${w}`);
    if (!catalogReady(db)) ctx.log('The catalog is not built yet, so movies are left unmatched. Run `screentrackr setup` to match them.');
    const summary = applyImport(db, parsed.records, { mode: replace ? 'replace' : 'merge' });

    const extra = { ...(parsed.skippedByType ? { skippedByType: parsed.skippedByType } : {}), ...parsed.extra };
    ctx.emit({ format: parsed.format, records: parsed.records.length, warnings: parsed.warnings, ...extra, ...summary }, () =>
      [
        `Imported ${parsed.records.length} records (${parsed.format}).`,
        `Added ${summary.added}, updated ${summary.updated}, unchanged ${summary.unchanged}, needs review ${summary.needsReview}.`,
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
