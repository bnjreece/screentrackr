/**
 * `screentrackr export`: the library as ScreenTrackr JSON v1 (the default),
 * or as files for Letterboxd's and Trakt's own importers. Read-only on the
 * library. Files are owner-only, written to a temp file and renamed into
 * place. Nothing is ever uploaded.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { exportLibrary } from '../../core/export.js';
import { loadExportSources } from '../../core/exporters/common.js';
import { LETTERBOXD_WHATS, letterboxdCsv, type LetterboxdWhat } from '../../core/exporters/letterboxd.js';
import { TRAKT_WHATS, traktCsv, type TraktWhat } from '../../core/exporters/trakt.js';
import { requireList } from '../../core/lists.js';
import { bool, str, type Command, type Values } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { safeJson } from '../sanitize.js';

const FORMATS = ['json-v1', 'letterboxd', 'trakt'] as const;
type Format = (typeof FORMATS)[number];

const LETTERBOXD_UPLOAD: Record<LetterboxdWhat, string> = {
  watched: 'Upload each file at letterboxd.com/import/ (your watched films and diary).',
  watchlist: 'Upload each file with the import on your watchlist page, letterboxd.com/watchlist/.',
  list: 'Upload each file with the import when you create a list at letterboxd.com/list/new/, or on the edit page of a list you have.',
};

/** Owner-only temp files beside each destination, then renamed over them: a failed write leaves nothing half-written. */
function writeOwnerOnly(files: { path: string; content: string }[]): void {
  const temps: string[] = [];
  try {
    for (const f of files) {
      const tmp = join(dirname(f.path), `.${basename(f.path)}.${process.pid}.${Date.now()}.tmp`);
      temps.push(tmp);
      writeFileSync(tmp, f.content, { mode: 0o600, flag: 'wx' });
    }
    files.forEach((f, i) => renameSync(temps[i] as string, f.path));
  } catch (err) {
    for (const t of temps) rmSync(t, { force: true });
    const at = files.length === 1 ? (files[0] as { path: string }).path : dirname((files[0] as { path: string }).path);
    throw new UserError(`Could not write ${at}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

function refuse(values: Values, format: Format, keys: string[], hint = ''): void {
  for (const k of keys) {
    if (values[k] !== undefined && values[k] !== false) throw new UserError(`--${k} does not apply to --format ${format}${hint}`);
  }
}

function exportJson(ctx: Ctx, values: Values): void {
  refuse(values, 'json-v1', ['out-dir', 'what', 'list', 'lists-as-tags']);
  const data = exportLibrary(ctx.db());
  const out = str(values, 'out');
  if (!out) {
    ctx.out(safeJson(data));
    return;
  }
  const path = resolve(out);
  writeOwnerOnly([{ path, content: `${JSON.stringify(data, null, 2)}\n` }]);
  ctx.emit({ path, items: data.items.length }, () => `Exported ${data.items.length} items to ${path}`);
}

function exportLetterboxd(ctx: Ctx, values: Values): void {
  refuse(values, 'letterboxd', ['out'], ' (Letterboxd files are split; use --out-dir <dir>)');
  const outDir = str(values, 'out-dir');
  if (!outDir) throw new UserError('--format letterboxd needs --out-dir <dir> (files are split below 1 MB each)');
  const listArg = str(values, 'list');
  const whatArg = str(values, 'what') ?? (listArg !== undefined ? 'list' : 'watched');
  if (!(LETTERBOXD_WHATS as readonly string[]).includes(whatArg)) throw new UserError(`--what must be one of ${LETTERBOXD_WHATS.join(', ')} for --format letterboxd`);
  const what = whatArg as LetterboxdWhat;
  if (what === 'list' && listArg === undefined) throw new UserError('--what list needs --list <name>');
  if (what !== 'list' && listArg !== undefined) throw new UserError('--list goes with --what list');
  const tags = bool(values, 'lists-as-tags');
  if (tags && what !== 'watched') throw new UserError('--lists-as-tags goes with --what watched (Letterboxd keeps tags only on diary entries)');
  const db = ctx.db();
  const list = listArg === undefined ? undefined : requireList(db, listArg).name;
  const res = letterboxdCsv(loadExportSources(db), { what, list, listsAsTags: tags });
  const dir = resolve(outDir);
  const notices: string[] = [];
  if (res.skipped) notices.push(`${res.skipped} movie${res.skipped === 1 ? '' : 's'} with no title or id left out.`);
  if (!res.files.length) {
    ctx.emit({ format: 'letterboxd', what, dir, files: [], rows: 0, skipped: res.skipped, notices }, () => [`Nothing to export: no movies for --what ${what}${list ? ` (list "${list}")` : ''}. No file written.`, ...notices].join('\n'));
    return;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new UserError(`Could not create ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const files = res.files.map((f) => ({ path: join(dir, f.name), content: f.content, rows: f.rows }));
  writeOwnerOnly(files);
  const stale = join(dir, `letterboxd-${what}-${files.length + 1}.csv`);
  if (existsSync(stale)) notices.push(`${basename(stale)} in ${dir} is from an earlier export and was not replaced; don't upload it with these.`);
  if (tags) notices.push('Tags are written on dated diary rows only: Letterboxd keeps tags only on diary entries.');
  ctx.emit(
    { format: 'letterboxd', what, dir, files: files.map((f) => ({ path: f.path, rows: f.rows, bytes: Buffer.byteLength(f.content, 'utf8') })), rows: res.rows, skipped: res.skipped, notices },
    () =>
      [
        `Wrote ${res.rows} row${res.rows === 1 ? '' : 's'} to ${files.length} file${files.length === 1 ? '' : 's'} in ${dir}:`,
        ...files.map((f) => `  ${basename(f.path)} (${f.rows} row${f.rows === 1 ? '' : 's'})`),
        ...notices,
        LETTERBOXD_UPLOAD[what],
        'screentrackr never uploads anything itself.',
      ].join('\n'),
  );
}

function exportTrakt(ctx: Ctx, values: Values): void {
  refuse(values, 'trakt', ['out-dir'], ' (Trakt takes one file; use --out <file>)');
  refuse(values, 'trakt', ['list', 'lists-as-tags']);
  const out = str(values, 'out');
  if (!out) throw new UserError('--format trakt needs --out <file.csv>');
  const whatArg = str(values, 'what') ?? 'all';
  if (!(TRAKT_WHATS as readonly string[]).includes(whatArg)) throw new UserError(`--what must be one of ${TRAKT_WHATS.join(', ')} for --format trakt`);
  const what = whatArg as TraktWhat;
  const res = traktCsv(loadExportSources(ctx.db()), { what });
  const path = resolve(out);
  const total = res.rows.history + res.rows.ratings + res.rows.watchlist;
  const notices: string[] = [];
  if (res.skipped) notices.push(`${res.skipped} movie${res.skipped === 1 ? '' : 's'} with no id and no year left out (Trakt's importer can't match ${res.skipped === 1 ? 'it' : 'them'}).`);
  if (res.dateless) notices.push(`${res.dateless} play${res.dateless === 1 ? '' : 's'} with no date written with watched_at "unknown".`);
  if (!total) {
    ctx.emit({ format: 'trakt', what, path: null, rows: res.rows, skipped: res.skipped, dateless: res.dateless, notices }, () => [`Nothing to export: no rows for --what ${what}. No file written.`, ...notices].join('\n'));
    return;
  }
  writeOwnerOnly([{ path, content: res.content }]);
  ctx.emit({ format: 'trakt', what, path, rows: res.rows, skipped: res.skipped, dateless: res.dateless, notices }, () =>
    [
      `Wrote ${path}: ${res.rows.history} history, ${res.rows.ratings} ratings, ${res.rows.watchlist} watchlist row${res.rows.watchlist === 1 ? '' : 's'}.`,
      ...notices,
      "Upload it with the import in Trakt's settings on app.trakt.tv. screentrackr never uploads anything itself.",
    ].join('\n'),
  );
}

export const exportCmd: Command = {
  name: 'export',
  summary: 'Export your library as ScreenTrackr JSON v1, or as files for Letterboxd or Trakt to import',
  usage: 'export [--format json-v1|letterboxd|trakt] [--out <file>] [--out-dir <dir>] [--what <what>] [--list <name>] [--lists-as-tags]',
  details: [
    'json-v1 (the default) prints to stdout unless --out is given.',
    'letterboxd writes letterboxd-<what>-1.csv and so on to --out-dir; --what watched (default), watchlist or list (with --list <name>).',
    'trakt writes one CSV to --out; --what all (default), history, ratings or watchlist.',
    'Exports never include IMDb ratings, votes or genres, and nothing is uploaded.',
  ].join('\n'),
  options: {
    format: { type: 'string', short: 'f', value: '<format>', description: 'json-v1 (default), letterboxd or trakt' },
    out: { type: 'string', short: 'o', value: '<file>', description: 'Write to this file (json-v1: instead of stdout; trakt: required)' },
    'out-dir': { type: 'string', value: '<dir>', description: 'Directory for the Letterboxd files (required for letterboxd)' },
    what: { type: 'string', value: '<what>', description: 'letterboxd: watched, watchlist or list; trakt: all, history, ratings or watchlist' },
    list: { type: 'string', value: '<name>', description: 'The list to export with --what list (letterboxd)' },
    'lists-as-tags': { type: 'boolean', description: "Put each movie's lists in Tags on its diary rows (letterboxd)" },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const format = str(values, 'format') ?? 'json-v1';
    if (!(FORMATS as readonly string[]).includes(format)) throw new UserError(`--format must be one of ${FORMATS.join(', ')}`);
    if (format === 'letterboxd') exportLetterboxd(ctx, values);
    else if (format === 'trakt') exportTrakt(ctx, values);
    else exportJson(ctx, values);
  },
};
