import { existsSync, statSync } from 'node:fs';
import { catalogReady } from '../../core/db.js';
import { dbPath } from '../../core/home.js';
import { SCHEMA_VERSION } from '../../core/schema.js';
import type { Command } from '../command.js';
import { UserError } from '../context.js';
import { keyValues } from '../format.js';

const MIN_NODE = [22, 13] as const;

export const doctor: Command = {
  name: 'doctor',
  summary: 'Check Node, the database, the catalog and the library',
  usage: 'doctor',
  options: {},
  run(ctx, pos) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const db = ctx.db();
    const meta = new Map(
      (db.sql.prepare('SELECT key, value FROM meta').all() as { key: string; value: string | null }[]).map((r) => [r.key, r.value]),
    );
    const count = (q: string) => Number((db.sql.prepare(q).get() as { n: number }).n);
    const builtAt = meta.get('catalog_built_at') ?? null;
    const ready = catalogReady(db);
    const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
    const datasetDates = Object.fromEntries([...meta].filter(([k]) => k.startsWith('dataset_date:')).map(([k, v]) => [k.slice('dataset_date:'.length), v]));
    const path = dbPath(ctx.home);

    const report = {
      nodeVersion: process.version,
      nodeOk: maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]),
      home: ctx.home,
      dbPath: path,
      dbSizeBytes: existsSync(path) ? statSync(path).size : 0,
      schemaVersion: Number(meta.get('schema_version') ?? SCHEMA_VERSION),
      fts: db.fts,
      catalogReady: ready,
      catalogBuiltAt: builtAt,
      catalogAgeDays: builtAt ? Math.floor((Date.now() - Date.parse(builtAt)) / 86_400_000) : null,
      catalogMovies: ready ? count('SELECT COUNT(*) AS n FROM titles') : 0,
      catalogWithCast: meta.get('catalog_with_cast') === '1',
      datasetDates,
      libraryCount: count('SELECT COUNT(*) AS n FROM library_items'),
      libraryMatch: Object.fromEntries(
        (db.sql.prepare('SELECT match_status AS s, COUNT(*) AS n FROM library_items GROUP BY match_status ORDER BY match_status').all() as { s: string; n: number }[]).map(
          (r) => [r.s, Number(r.n)],
        ),
      ),
    };

    ctx.emit(report, () =>
      keyValues([
        ['Node', `${report.nodeVersion}${report.nodeOk ? '' : ` (needs ${MIN_NODE.join('.')} or newer)`}`],
        ['Home', report.home],
        ['Database', `${report.dbPath} (${(report.dbSizeBytes / 1024 / 1024).toFixed(1)} MB)`],
        ['Full-text search', report.fts ? 'available' : 'not available (using a title index)'],
        [
          'Catalog',
          ready
            ? `${report.catalogMovies.toLocaleString('en-US')} movies, built ${builtAt} (${report.catalogAgeDays} days ago)${report.catalogWithCast ? '' : ', no cast'}`
            : 'not built. Run `screentrackr setup`.',
        ],
        ['Library', `${report.libraryCount} items${Object.keys(report.libraryMatch).length ? ` (${Object.entries(report.libraryMatch).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`],
      ]),
    );
  },
};
