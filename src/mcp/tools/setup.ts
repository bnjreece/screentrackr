/** setup_catalog and catalog_status: build the catalog in the background and follow it. */
import { z } from 'zod';
import type { Db } from '../../core/db.js';
import { matchingPending } from '../../core/setup.js';
import type { SetupJobStatus } from '../setup-job.js';
import { handler, ok, type RegisterTools } from './common.js';

interface CatalogInfo {
  ready: boolean;
  /** A build finished but the library rematch after it did not. */
  matchingPending: boolean;
  builtAt: string | null;
  movies: number | null;
  withCast: boolean | null;
  includeTvMovies: boolean | null;
}

function catalogInfo(db: Db): CatalogInfo {
  const meta = (key: string) =>
    (db.sql.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string | null } | undefined)?.value ?? null;
  const builtAt = meta('catalog_built_at');
  if (!builtAt) return { ready: false, matchingPending: false, builtAt: null, movies: null, withCast: null, includeTvMovies: null };
  const movies = (db.sql.prepare('SELECT COUNT(*) AS n FROM titles').get() as { n: number }).n;
  return {
    ready: true,
    matchingPending: matchingPending(db),
    builtAt,
    movies,
    withCast: meta('catalog_with_cast') === '1',
    includeTvMovies: meta('catalog_include_tv_movies') === '1',
  };
}

function setupText(catalog: CatalogInfo, job: SetupJobStatus): string {
  const lines: string[] = [];
  if (catalog.ready) lines.push(`Catalog ready: ${(catalog.movies ?? 0).toLocaleString('en-US')} movies, built ${catalog.builtAt}.`);
  else lines.push('Catalog not built yet.');
  if (catalog.matchingPending && job.state !== 'running') {
    lines.push('Matching your library to the new catalog did not finish. Call setup_catalog to finish it (this skips the download).');
  }
  if (job.state === 'running') {
    lines.push(`Setup running for ${job.elapsedSeconds ?? 0}s. It usually takes several minutes; check again with catalog_status.`);
    if (job.progress.length) lines.push('Latest progress:', ...job.progress.map((p) => `  ${p.trim()}`));
  } else if (job.state === 'succeeded' && job.result) {
    const r = job.result;
    lines.push(
      r.catalog
        ? `Setup finished in ${job.elapsedSeconds ?? 0}s: ${r.catalog.movies.toLocaleString('en-US')} movies.`
        : `Library matching finished in ${job.elapsedSeconds ?? 0}s.`,
      `Library matching: ${r.matching.matched} matched, ${r.matching.ambiguous} ambiguous, ${r.matching.unmatched} unmatched.`,
      r.credit,
    );
  } else if (job.state === 'failed') {
    lines.push(`Setup failed: ${job.error ?? 'unknown error'}`, 'Call setup_catalog again to retry; finished downloads are reused.');
  } else if (!catalog.ready) {
    lines.push('Call setup_catalog to build it (a one-time download of about 1 GB that takes several minutes).');
  }
  return lines.join('\n');
}

export const register: RegisterTools = (server, { db, setupJob }) => {
  server.registerTool(
    'setup_catalog',
    {
      title: 'Build the movie catalog',
      description:
        'Download the IMDb datasets (about 1 GB, cached in the data folder) and build the local movie catalog, the same as `screentrackr setup`. It runs in the background and takes several minutes: this returns at once, then call catalog_status every 30 seconds or so until it reports finished or failed. If the catalog is already built this does nothing unless refresh is true, which checks IMDb for newer files and rebuilds (or, when the library matching after a build did not finish, it finishes that alone). A failed or interrupted setup can simply be started again; finished downloads are reused. Library changes may fail with "database is locked" while it builds; retry them afterwards. Statuses, ratings, notes and manual links are never changed.',
      inputSchema: {
        refresh: z.boolean().optional().describe('Check IMDb for newer dataset files and rebuild, even if the catalog is already built.'),
        withCast: z.boolean().optional().describe('Load top-billed cast (default true). false builds faster and smaller.'),
        includeTvMovies: z.boolean().optional().describe('Also include TV movies (default false).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler((args) => {
      const catalog = catalogInfo(db);
      if (setupJob.isRunning) {
        const status = setupJob.status();
        return ok({ started: false, catalog, setup: status }, `Setup is already running.\n${setupText(catalog, status)}`);
      }
      if (catalog.ready && !args.refresh && catalog.matchingPending) {
        const status = setupJob.start({ refresh: false, withCast: true, includeTvMovies: false, matchOnly: true });
        return ok(
          { started: true, catalog, setup: status },
          'The catalog is built, but matching your library to it did not finish. Finishing that now in the background (no download). Call catalog_status to follow it.',
        );
      }
      if (catalog.ready && !args.refresh) {
        const status = setupJob.status();
        return ok(
          { started: false, catalog, setup: status },
          `${setupText(catalog, status)}\nNothing to do. Pass refresh: true to check IMDb for newer data and rebuild.`,
        );
      }
      const status = setupJob.start({
        refresh: args.refresh ?? false,
        withCast: args.withCast ?? true,
        includeTvMovies: args.includeTvMovies ?? false,
        matchOnly: false,
      });
      return ok(
        { started: true, catalog, setup: status },
        'Setup started in the background. It downloads about 1 GB and takes several minutes. Call catalog_status to follow it.',
      );
    }),
  );

  server.registerTool(
    'catalog_status',
    {
      title: 'Catalog and setup status',
      description:
        'Whether the movie catalog is built (when, how many movies), and the state of a setup started with setup_catalog: running with its latest progress lines, finished, or failed with the reason.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(() => {
      const catalog = catalogInfo(db);
      const status = setupJob.status();
      return ok({ catalog, setup: status }, setupText(catalog, status));
    }),
  );

};
