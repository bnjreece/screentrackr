/**
 * `screentrackr sync`: save import sources (Plex, Jellyfin, the TV app) in
 * config.json and re-run them as merge imports with one command. Each
 * source runs the same code its `import` does (../import-runner.ts); one
 * failing never stops the others. Tokens come from the environment only and
 * are never saved, printed or put in the launchd plist.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  removeSyncSource,
  SYNC_KINDS,
  syncSource,
  updateConfig,
  upsertSyncSource,
  type AppleTvSyncSource,
  type JellyfinSyncSource,
  type PlexSyncSource,
  type SyncKind,
  type SyncSource,
} from '../../core/config.js';
import { serverBase } from '../../core/importers/jellyfin.js';
import { PLEX_DEFAULT_URL, PLEX_UNWATCHED_STATUSES, plexBaseUrl, type PlexUnwatchedStatus } from '../../core/importers/plex.js';
import { DEFAULT_EVERY, isNpxPath, launchdPlan, parseEvery, shellQuote } from '../../core/launchd.js';
import { openDb, type Db } from '../../core/db.js';
import { dbPath } from '../../core/home.js';
import { SCHEMA_VERSION } from '../../core/schema.js';
import { acquireSetupLock, SetupBusyError } from '../../core/setup.js';
import { sqlite } from '../../core/sqlite.js';
import {
  acquireSyncLock,
  readSyncStatus,
  recordSyncRun,
  runSyncSources,
  syncTotals,
  tokenEnvOf,
  type LastRun,
  type SourceResult,
  type SourceRunOutput,
} from '../../core/sync.js';
import { bool, str, strs, type Command, type Values } from '../command.js';
import { UserError, type Ctx } from '../context.js';
import { runAppleTvImport, runJellyfinImport, runPlexImport, type PlexImportOptions } from '../import-runner.js';

const KINDS = SYNC_KINDS.join('|');
const NO_SOURCES = `No sync sources. Add one with \`screentrackr sync add <${KINDS}>\` (see \`screentrackr sync --help\`).`;

/** The flags each subcommand (and each kind of `sync add`) takes. */
const ADD_FLAGS: Record<SyncKind, readonly string[]> = {
  plex: ['url', 'section', 'include-other-videos', 'unwatched-status', 'no-ratings', 'history'],
  jellyfin: ['url', 'user', 'user-id', 'ratings', 'strict-played', 'timeout'],
  'apple-tv': ['timeout'],
};
const SUB_FLAGS: Record<string, readonly string[]> = {
  run: ['only', 'dry-run'],
  list: [],
  remove: [],
  status: [],
  launchd: ['every', 'wrapper'],
};

const OPTIONS = {
  url: { type: 'string', value: '<server>', description: `add plex|jellyfin: the server address (plex default ${PLEX_DEFAULT_URL})` },
  section: { type: 'string', multiple: true, value: '<name|key>', description: 'add plex: read this movie library only (repeatable)' },
  'include-other-videos': { type: 'boolean', description: 'add plex: also read "Other Videos" libraries' },
  'unwatched-status': {
    type: 'string',
    value: `<${PLEX_UNWATCHED_STATUSES.join('|')}>`,
    description: 'add plex: status for new unwatched movies (default someday; skip leaves them out)',
  },
  'no-ratings': { type: 'boolean', description: 'add plex: do not read Plex star ratings' },
  history: { type: 'boolean', description: "add plex: also read Plex's play history" },
  user: { type: 'string', value: '<name>', description: 'add jellyfin: whose library to read' },
  'user-id': { type: 'string', value: '<id>', description: 'add jellyfin, with an admin API key: the user id whose library to read' },
  ratings: { type: 'boolean', description: 'add jellyfin: also import your Jellyfin ratings' },
  'strict-played': { type: 'boolean', description: 'add jellyfin: played movies with no known runtime get no status' },
  timeout: { type: 'string', value: '<seconds>', description: 'add jellyfin|apple-tv: per request (jellyfin, default 30) or for the TV app (default 120)' },
  only: { type: 'string', value: `<${KINDS}>`, description: 'Run one saved source only' },
  'dry-run': { type: 'boolean', description: 'Show what each source would change, changing nothing' },
  every: { type: 'string', value: '<interval>', description: `launchd: how often to sync, such as 30m, 6h or 1d (default ${DEFAULT_EVERY})` },
  wrapper: { type: 'boolean', description: 'launchd: print only the Keychain wrapper script' },
} as const;

function used(values: Values): string[] {
  return Object.keys(OPTIONS).filter((k) => {
    const v = values[k];
    return v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0);
  });
}

function onlyFlags(values: Values, allowed: readonly string[], where: string): void {
  const bad = used(values).find((k) => !allowed.includes(k));
  if (bad) throw new UserError(`--${bad} does not apply to ${where}`);
}

function kindOf(value: string | undefined, usage: string): SyncKind {
  if (value === undefined) throw new UserError(`Usage: screentrackr ${usage}`);
  if (!(SYNC_KINDS as readonly string[]).includes(value)) throw new UserError(`Unknown source "${value}" (expected ${SYNC_KINDS.join(', ')})`);
  return value as SyncKind;
}

function timeoutSec(values: Values): number | undefined {
  const t = str(values, 'timeout');
  if (t === undefined) return undefined;
  const secs = Number(t);
  if (!Number.isFinite(secs) || secs <= 0) throw new UserError(`--timeout must be a positive number of seconds (got "${t}")`);
  if (secs > 3600) throw new UserError('--timeout must be at most 3600 seconds');
  return secs;
}

/** A source from `sync add` flags, checked the way `import` checks them. */
function sourceFromFlags(kind: SyncKind, values: Values): SyncSource {
  onlyFlags(values, ADD_FLAGS[kind], kind);
  if (kind === 'plex') {
    const url = str(values, 'url') ?? PLEX_DEFAULT_URL;
    plexBaseUrl(url);
    const unwatched = str(values, 'unwatched-status');
    if (unwatched !== undefined && !(PLEX_UNWATCHED_STATUSES as readonly string[]).includes(unwatched)) {
      throw new UserError(`--unwatched-status expects ${PLEX_UNWATCHED_STATUSES.join(', ')} (got "${unwatched}")`);
    }
    const sections = strs(values, 'section');
    const s: PlexSyncSource = {
      kind,
      url,
      ...(sections ? { sections } : {}),
      includeOtherVideos: bool(values, 'include-other-videos'),
      ...(unwatched !== undefined ? { unwatchedStatus: unwatched as PlexUnwatchedStatus } : {}),
      ratings: !bool(values, 'no-ratings'),
      history: bool(values, 'history'),
    };
    return s;
  }
  if (kind === 'jellyfin') {
    const url = str(values, 'url');
    if (!url) throw new UserError('Usage: screentrackr sync add jellyfin --url <server> [--user <name>]');
    serverBase(url);
    const user = str(values, 'user');
    const userId = str(values, 'user-id');
    const t = timeoutSec(values);
    const s: JellyfinSyncSource = {
      kind,
      url,
      ...(user !== undefined ? { user } : {}),
      ...(userId !== undefined ? { userId } : {}),
      ratings: bool(values, 'ratings'),
      strictPlayed: bool(values, 'strict-played'),
      ...(t !== undefined ? { timeoutSec: t } : {}),
    };
    return s;
  }
  const t = timeoutSec(values);
  const s: AppleTvSyncSource = { kind, ...(t !== undefined ? { timeoutSec: t } : {}) };
  return s;
}

function describeSource(s: SyncSource): string {
  if (s.kind === 'plex') {
    const bits = [
      s.sections?.length ? `sections ${s.sections.join(', ')}` : 'all movie libraries',
      s.includeOtherVideos ? 'other videos' : '',
      s.unwatchedStatus ? `new unwatched: ${s.unwatchedStatus}` : '',
      s.ratings === false ? 'no ratings' : 'ratings',
      s.history ? 'history' : '',
    ].filter(Boolean);
    return `${s.url}  (${bits.join('; ')})`;
  }
  if (s.kind === 'jellyfin') {
    const bits = [
      s.user ? `user ${s.user}` : s.userId ? `user id ${s.userId}` : 'the token\'s user',
      s.ratings ? 'ratings' : 'no ratings',
      s.strictPlayed ? 'strict played' : '',
      s.timeoutSec !== undefined ? `timeout ${s.timeoutSec} s` : '',
    ].filter(Boolean);
    return `${s.url}  (${bits.join('; ')})`;
  }
  return `the TV app${s.timeoutSec !== undefined ? `  (timeout ${s.timeoutSec} s)` : ''}`;
}

function tokenNote(kind: SyncKind): string {
  const env = tokenEnvOf(kind);
  if (!env) return '';
  return `${env} is ${process.env[env]?.trim() ? 'set' : 'not set'}`;
}

/** Run one saved source as a merge import, with the options its `import` takes. Never prompts. */
async function runSource(ctx: Ctx, s: SyncSource, dryRun: boolean): Promise<SourceRunOutput> {
  let outcome;
  if (s.kind === 'plex') {
    // `history` is passed on for the Plex history reader (it is ignored until that reader exists).
    const opts: PlexImportOptions & { history?: boolean } = {
      url: s.url,
      ...(s.sections ? { sections: s.sections } : {}),
      includeOtherVideos: s.includeOtherVideos === true,
      ...(s.unwatchedStatus ? { unwatchedStatus: s.unwatchedStatus } : {}),
      ratings: s.ratings !== false,
      tokenStdin: false,
      ...(s.history ? { history: true } : {}),
    };
    outcome = await runPlexImport(ctx, { ...opts, dryRun });
  } else if (s.kind === 'jellyfin') {
    outcome = await runJellyfinImport(ctx, {
      url: s.url,
      user: s.user,
      userId: s.userId,
      tokenStdin: false,
      passwordStdin: false,
      ratings: s.ratings === true,
      strictPlayed: s.strictPlayed === true,
      timeoutMs: s.timeoutSec !== undefined ? Math.round(s.timeoutSec * 1000) : undefined,
      interactive: false,
      dryRun,
    });
  } else {
    outcome = await runAppleTvImport(ctx, { ...(s.timeoutSec !== undefined ? { timeoutMs: Math.round(s.timeoutSec * 1000) } : {}), dryRun });
  }
  return { records: outcome.parsed.records.length, summary: outcome.summary };
}

function resultLine(r: SourceResult, dryRun: boolean): string {
  if (!r.ok) return `${r.kind}: failed${r.unexpected ? ' unexpectedly' : ''}: ${r.error ?? 'unknown error'}`;
  const counts = dryRun
    ? `Would add ${r.added}, update ${r.updated}, leave unchanged ${r.unchanged}, needs review ${r.needsReview}.`
    : `Added ${r.added}, updated ${r.updated}, unchanged ${r.unchanged}, needs review ${r.needsReview}.`;
  const ambiguous = r.ambiguous ? ` ${r.ambiguous} not imported (each could be more than one item; run \`screentrackr import\` for that source to see them).` : '';
  return `${r.kind}: ${r.records} records. ${counts}${ambiguous}`;
}

function hasFts5(): boolean {
  const probe = new sqlite.DatabaseSync(':memory:');
  try {
    probe.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

/**
 * Whether opening the library (openDb) would change it before any import
 * runs: a migration, setting WAL mode, or creating the full-text index this
 * runtime supports. Read without changing anything.
 */
function openWouldChange(path: string): boolean {
  const raw = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const table = (name: string) => Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
    if (!table('meta')) return true;
    const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (Number(row?.value ?? 0) < SCHEMA_VERSION) return true;
    const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode?.toLowerCase() !== 'wal') return true;
    return !table('titles_fts') && hasFts5();
  } finally {
    raw.close();
  }
}

/**
 * The context a dry run imports through, so it changes nothing: opening the
 * library must not create it or migrate it (both commit before the import's
 * rollback). With no library yet, the dry run runs against an empty one in a
 * temporary folder, removed afterwards. A library that opening would change
 * (an older schema, not in WAL mode, or missing the full-text index) is
 * refused: it is updated the first time it is opened for real.
 */
function dryRunContext(ctx: Ctx): { ctx: Ctx; cleanup: () => void } {
  const path = dbPath(ctx.home);
  if (existsSync(path)) {
    if (openWouldChange(path)) {
      throw new UserError(
        'Your library needs a one-time update when it is next opened (it was made by an older screentrackr, or copied, or built where full-text search was missing), and a dry run must not make it. Run `screentrackr doctor` once (it opens and updates the library), then try the dry run again.',
      );
    }
    return { ctx, cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'screentrackr-dry-run-'));
  let db: Db | undefined;
  const dry: Ctx = {
    ...ctx,
    json: ctx.json,
    db: () => (db ??= openDb(tmp)),
    close: () => ctx.close(),
  };
  return {
    ctx: dry,
    cleanup: () => {
      db?.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function runAll(ctx: Ctx, values: Values): Promise<void> {
  onlyFlags(values, SUB_FLAGS.run as readonly string[], '`sync`');
  const config = loadConfig(ctx.home);
  const only = str(values, 'only');
  const dryRun = bool(values, 'dry-run');
  let sources = config.sync?.sources ?? [];
  if (only !== undefined) {
    const kind = kindOf(only, 'sync --only <kind>');
    const s = syncSource(config, kind);
    if (!s) throw new UserError(`No ${kind} source is configured. Add it with \`screentrackr sync add ${kind}\`.`);
    sources = [s];
  }
  if (!sources.length) throw new UserError(NO_SOURCES);

  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  const release = acquireSyncLock(ctx.home);
  let releaseSetup: (() => void) | undefined;
  let cleanup = () => {};
  try {
    // Held for the whole sync, so a setup can't start swapping the catalog
    // while an import is matching against it.
    try {
      releaseSetup = acquireSetupLock(ctx.home);
    } catch (err) {
      if (err instanceof SetupBusyError) throw new UserError('Setup is running; try again when it finishes.');
      throw err;
    }
    const dry = dryRun ? dryRunContext(ctx) : { ctx, cleanup };
    cleanup = dry.cleanup;
    const runCtx = dry.ctx;
    const results = await runSyncSources(sources, (s) => runSource(runCtx, s, dryRun), {
      before: (s) => {
        if (!ctx.json) ctx.out(`== ${s.kind} ==`);
      },
      after: (r) => {
        if (!ctx.json) ctx.out(resultLine(r, dryRun));
        if (dryRun) return;
        try {
          recordSyncRun(ctx.db(), r);
        } catch (err) {
          ctx.log(`Warning: could not record the ${r.kind} run for \`sync status\`: ${(err as Error).message}`);
        }
      },
    });
    const total = syncTotals(results);
    const failed = results.filter((r) => !r.ok);
    const result = { dryRun, ok: failed.length === 0, sources: results, total, failed: failed.map((r) => r.kind) };
    const text = [
      `Total: ${dryRun ? 'would add' : 'added'} ${total.added}, ${dryRun ? 'update' : 'updated'} ${total.updated}, unchanged ${total.unchanged}, needs review ${total.needsReview}.` +
        (failed.length ? ` ${failed.length} of ${results.length} sources failed.` : ''),
      dryRun ? 'Dry run: nothing was changed.' : '',
      !dryRun && total.needsReview ? 'Run `screentrackr match --review` to see the movies that need review.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (!failed.length) {
      ctx.emit(result, () => text);
      return;
    }
    if (!ctx.json) ctx.out(text);
    const message = `${failed.length} of ${results.length} sources failed: ${failed.map((r) => r.kind).join(', ')}`;
    // A bug in one source (not a server or setup problem) is an unexpected
    // error (exit 2). Only a UserError carries details, so the reasons go in
    // the message.
    if (failed.some((r) => r.unexpected)) throw new Error(`${message} (${failed.map((r) => `${r.kind}: ${r.error ?? 'unknown error'}`).join('; ')})`);
    throw new UserError(message, { sync: result });
  } finally {
    cleanup();
    releaseSetup?.();
    release();
  }
}

function add(ctx: Ctx, pos: string[], values: Values): void {
  const kind = kindOf(pos[1], `sync add <${KINDS}> [options]`);
  if (pos.length > 2) throw new UserError(`Unexpected argument "${pos[2]}"`);
  const runFlag = used(values).find((k) => [...SUB_FLAGS.run as readonly string[], ...(SUB_FLAGS.launchd as readonly string[])].includes(k));
  if (runFlag) throw new UserError(`--${runFlag} does not apply to \`sync add\``);
  const source = sourceFromFlags(kind, values);
  const replaced = syncSource(loadConfig(ctx.home), kind) !== undefined;
  updateConfig(ctx.home, (c) => upsertSyncSource(c, source));
  const env = tokenEnvOf(kind);
  ctx.emit({ saved: source, replaced }, () =>
    [
      `Saved the ${kind} source${replaced ? ' (it replaced the saved one)' : ''}: ${describeSource(source)}.`,
      env ? `It reads its token from ${env} when it runs; nothing secret is saved.` : '',
      'Run `screentrackr sync` to sync it now.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function list(ctx: Ctx): void {
  const sources = loadConfig(ctx.home).sync?.sources ?? [];
  const rows = sources.map((s) => ({ ...s, tokenEnv: tokenEnvOf(s.kind), tokenSet: Boolean(tokenEnvOf(s.kind) && process.env[tokenEnvOf(s.kind) as string]?.trim()) }));
  ctx.emit({ sources: rows }, () =>
    sources.length
      ? sources.map((s) => `${s.kind.padEnd(9)} ${describeSource(s)}${tokenNote(s.kind) ? `  ${tokenNote(s.kind)}` : ''}`).join('\n')
      : NO_SOURCES,
  );
}

function remove(ctx: Ctx, pos: string[]): void {
  const kind = kindOf(pos[1], `sync remove <${KINDS}>`);
  if (pos.length > 2) throw new UserError(`Unexpected argument "${pos[2]}"`);
  updateConfig(ctx.home, (c) => removeSyncSource(c, kind));
  ctx.emit({ removed: kind }, () => `Removed the ${kind} source.`);
}

function lastRunText(kind: SyncKind, last: LastRun | null): string {
  if (!last) return `${kind}: never run`;
  if (last.ok) {
    return `${kind}: last run ${last.at} ok: added ${last.added ?? 0}, updated ${last.updated ?? 0}, unchanged ${last.unchanged ?? 0}, needs review ${last.needsReview ?? 0}`;
  }
  return `${kind}: last run ${last.at} failed: ${last.error ?? 'unknown error'}${last.lastOkAt ? ` (last success ${last.lastOkAt})` : ''}`;
}

function status(ctx: Ctx): void {
  const sources = loadConfig(ctx.home).sync?.sources ?? [];
  if (!sources.length) {
    ctx.emit({ sources: [] }, () => NO_SOURCES);
    return;
  }
  const rows = readSyncStatus(
    ctx.db(),
    sources.map((s) => s.kind),
  );
  ctx.emit({ sources: rows }, () => rows.map((r) => lastRunText(r.kind, r.lastRun)).join('\n'));
}

/** Where the plist points: the installed CLI (dist/cli/index.js) and node, real paths. An object so tests can stand in. */
export const launchdPaths = {
  cli(): string {
    return realpathSync(fileURLToPath(new URL('../index.js', import.meta.url)));
  },
  node(): string {
    return realpathSync(process.execPath);
  },
};

function launchd(ctx: Ctx, values: Values): void {
  const sources = loadConfig(ctx.home).sync?.sources ?? [];
  if (!sources.length) throw new UserError(NO_SOURCES);
  const cli = launchdPaths.cli();
  if (isNpxPath(cli)) {
    throw new UserError(
      '`sync launchd` needs an installed screentrackr: npx runs it from a cache folder that changes and gets cleared. Run `npm install -g screentrackr`, then `screentrackr sync launchd`.',
    );
  }
  const every = str(values, 'every');
  const intervalSec = parseEvery(every ?? DEFAULT_EVERY);
  const tokenEnvs = sources.map((s) => tokenEnvOf(s.kind)).filter((e): e is string => e !== null);
  const defaultHome = join(homedir(), '.screentrackr');
  const rerun = `screentrackr${ctx.home !== defaultHome ? ` --home ${shellQuote(ctx.home)}` : ''} sync launchd${every !== undefined ? ` --every ${every.trim()}` : ''}`;
  const plan = launchdPlan({ nodePath: launchdPaths.node(), cliPath: cli, home: ctx.home, userHome: homedir(), intervalSec, tokenEnvs, rerun });
  if (bool(values, 'wrapper')) {
    if (!plan.wrapper) throw new UserError('No saved source needs a token, so there is no wrapper: the plist runs screentrackr directly.');
    ctx.emit({ wrapperPath: plan.wrapperPath, wrapper: plan.wrapper }, () => plan.wrapper as string);
    return;
  }
  if (process.platform !== 'darwin') ctx.log('Note: launchd is macOS only. On other systems, run `screentrackr sync` from cron or a systemd timer.');
  ctx.emit(plan, () => plan.plist);
  if (!ctx.json) {
    ctx.log('Nothing was written or installed. To install it:');
    plan.steps.forEach((s, i) => ctx.log(`  ${i + 1}. ${s}`));
    if (plan.wrapper) ctx.log(`The plist runs ${plan.wrapperPath}, which reads the tokens from your login Keychain (\`--wrapper\` prints it).`);
  }
}

export const sync: Command = {
  name: 'sync',
  summary: 'Re-import your saved sources (Plex, Jellyfin, the TV app)',
  usage: `sync [add <${KINDS}> | list | remove <kind> | status | launchd [--every <interval>] [--wrapper]] [--only <kind>] [--dry-run]`,
  details: [
    'Save a source once, with the options its `import` takes, then run them all with `screentrackr sync`:',
    '  screentrackr sync add plex --url http://127.0.0.1:32400 [--section Movies] [--history] [--no-ratings] [--unwatched-status someday]',
    '  screentrackr sync add jellyfin --url http://localhost:8096 [--user <name>] [--ratings]',
    '  screentrackr sync add apple-tv [--timeout 120]',
    'Sources are saved in config.json in the data home (owner-only). Tokens never are: Plex reads PLEX_TOKEN and Jellyfin JELLYFIN_TOKEN when the sync runs, and a sync never prompts, so a missing token fails that source.',
    '`sync` runs each saved source in order as a merge import (never --replace) and prints a block per source, then a total. A source that fails (a server down, a missing token) does not stop the others. It exits 0 when every source succeeded and 1 when any failed. --dry-run shows what each would change and changes nothing.',
    '`sync status` shows each source\'s last run. `sync list` and `sync remove <kind>` manage the saved sources.',
    '`sync launchd` prints a macOS LaunchAgent plist (on stdout) and the commands to install it (on stderr). It never writes the plist or runs launchctl. When a source needs a token, the plist runs a small wrapper (`--wrapper` prints it) that reads the token from your login Keychain.',
  ].join('\n'),
  options: OPTIONS,
  async run(ctx, pos, values) {
    const sub = pos[0];
    if (sub === undefined) return runAll(ctx, values);
    if (sub === 'add') return add(ctx, pos, values);
    if (!(sub in SUB_FLAGS) || sub === 'run') throw new UserError(`Unknown sync command "${sub}" (expected add, list, remove, status or launchd)`);
    onlyFlags(values, SUB_FLAGS[sub] as readonly string[], `\`sync ${sub}\``);
    if (sub !== 'remove' && pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    if (sub === 'list') return list(ctx);
    if (sub === 'remove') return remove(ctx, pos);
    if (sub === 'status') return status(ctx);
    return launchd(ctx, values);
  },
};
