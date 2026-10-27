/**
 * `screentrackr import plex`: the CLI side of the Plex importer (token, flags,
 * the per-install client id). The importer itself is core/importers/plex.ts.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Db } from '../../core/db.js';
import type { ParsedImport } from '../../core/importers/common.js';
import {
  mapPlexItems,
  parsePlexDump,
  PLEX_DEFAULT_URL,
  PLEX_UNWATCHED_STATUSES,
  readPlexLibrary,
  type PlexCounts,
  type PlexUnwatchedStatus,
} from '../../core/importers/plex.js';
import { bool, str, strs, type OptionSpec, type Values } from '../command.js';
import type { Ctx } from '../context.js';
import { UserError } from '../context.js';

/** The largest saved listing `--from-file` reads. */
const MAX_LISTING_BYTES = 256 * 1024 * 1024;

export const PLEX_OPTIONS: Record<string, OptionSpec> = {
  url: { type: 'string', value: '<server>', description: `plex only: your Plex Media Server (default ${PLEX_DEFAULT_URL})` },
  section: { type: 'string', multiple: true, value: '<name|key>', description: 'plex only: read this movie library only (repeatable)' },
  'include-other-videos': { type: 'boolean', description: 'plex only: also read "Other Videos" libraries' },
  'unwatched-status': {
    type: 'string',
    value: `<${PLEX_UNWATCHED_STATUSES.join('|')}>`,
    description: 'plex only: status for new unwatched movies (default someday; skip leaves them out)',
  },
  'no-ratings': { type: 'boolean', description: 'plex only: do not read Plex star ratings' },
  'token-stdin': { type: 'boolean', description: 'plex only: read the token from stdin instead of PLEX_TOKEN' },
  'from-file': { type: 'string', value: '<file.json>', description: 'plex only: read saved listing JSON instead of a server' },
};

/**
 * Throws when a Plex-only flag is used with another import. (--dry-run is
 * shared by every import and defined in import.ts; `shared` names flags
 * another import also takes, such as --url and --token-stdin for Jellyfin,
 * which import.ts checks itself.)
 */
export function rejectPlexFlags(values: Values, shared: readonly string[] = []): void {
  const used = Object.keys(PLEX_OPTIONS).filter((k) => !shared.includes(k) && values[k] !== undefined && values[k] !== false);
  if (used.length) throw new UserError(`${used.map((k) => `--${k}`).join(', ')} only appl${used.length === 1 ? 'ies' : 'y'} to \`import plex\``);
}

export interface PlexParsed extends ParsedImport {
  format: 'plex';
  notices: string[];
  plex: PlexCounts;
  dryRun: boolean;
  /** False when a library returned fewer movies than it reported, or a saved listing can't show it is whole. */
  complete: boolean;
}

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0';
  }
}

/**
 * One X-Plex-Client-Identifier per install, kept in the database (it is not a
 * secret). A dry run never opens the database, so it uses a one-off id.
 */
function clientId(ctx: Ctx, dryRun: boolean): string {
  if (dryRun) return randomUUID();
  const db: Db = ctx.db();
  const row = db.sql.prepare("SELECT value FROM meta WHERE key = 'plex_client_id'").get() as { value: string | null } | undefined;
  if (row?.value) return row.value;
  const id = randomUUID();
  db.sql.prepare("INSERT INTO meta (key, value) VALUES ('plex_client_id', ?) ON CONFLICT(key) DO NOTHING").run(id);
  return id;
}

function readToken(values: Values): string {
  const fromStdin = bool(values, 'token-stdin');
  const env = process.env.PLEX_TOKEN?.trim();
  if (fromStdin && env) throw new UserError('Use either PLEX_TOKEN or --token-stdin, not both');
  let token: string | undefined = env;
  if (fromStdin) {
    // Typed or pasted into a terminal, the token would stay on screen and in scrollback.
    if (process.stdin.isTTY) throw new UserError('--token-stdin reads a piped token, e.g. `op read ... | screentrackr import plex --token-stdin`; it does not read from a terminal');
    try {
      token = readFileSync(0, 'utf8').trim();
    } catch {
      throw new UserError('Could not read the token from stdin');
    }
  }
  if (!token) {
    throw new UserError(
      'No Plex token. Set PLEX_TOKEN (or pipe it in with --token-stdin). To find yours, see https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/',
    );
  }
  // A header value: printable ASCII only. Never echo it.
  if (!/^[\x21-\x7e]+$/.test(token)) throw new UserError('The Plex token has characters a token cannot have (check PLEX_TOKEN)');
  return token;
}

export async function readPlexImport(ctx: Ctx, values: Values): Promise<PlexParsed> {
  const unwatched = str(values, 'unwatched-status') ?? 'someday';
  if (!(PLEX_UNWATCHED_STATUSES as readonly string[]).includes(unwatched)) {
    throw new UserError(`--unwatched-status expects ${PLEX_UNWATCHED_STATUSES.join(', ')} (got "${unwatched}")`);
  }
  const mapOpts = { unwatchedStatus: unwatched as PlexUnwatchedStatus, ratings: !bool(values, 'no-ratings') };
  const dryRun = bool(values, 'dry-run');
  const file = str(values, 'from-file');
  const sections = strs(values, 'section');
  const url = str(values, 'url');

  let res: { records: ParsedImport['records']; warnings: string[]; notices: string[]; counts: PlexCounts };
  let complete: boolean;
  if (file !== undefined) {
    if (url !== undefined || sections || bool(values, 'include-other-videos') || bool(values, 'token-stdin')) {
      throw new UserError('--from-file reads a saved listing, so --url, --section, --include-other-videos and --token-stdin do not apply');
    }
    let text: string;
    try {
      // A saved listing larger than this is not one Plex wrote; refuse it before reading.
      if (statSync(file).size > MAX_LISTING_BYTES) throw new UserError(`${file}: too large to read (over ${MAX_LISTING_BYTES} bytes)`);
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(`Could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    const dump = parsePlexDump(text);
    res = mapPlexItems(dump.movies, mapOpts);
    complete = dump.complete && res.counts.unreadable === 0;
  } else {
    const token = readToken(values);
    const read = await readPlexLibrary({
      ...mapOpts,
      url: url ?? PLEX_DEFAULT_URL,
      token,
      clientId: clientId(ctx, dryRun),
      version: version(),
      ...(sections ? { sections } : {}),
      includeOtherVideos: bool(values, 'include-other-videos'),
    });
    res = read;
    complete = read.complete;
    if (read.sections.length) res.notices.unshift(`Reading Plex libraries: ${read.sections.map((s) => `"${s.title}"`).join(', ')}.`);
  }
  const c = res.counts;
  const notices = [
    ...res.notices,
    `Plex: ${c.movies} movies, ${c.watched} watched, ${c.unwatched} unwatched` +
      (c.unwatched ? ` (new ones become ${unwatched})` : '') +
      (c.skippedUnwatched ? `, ${c.skippedUnwatched} unwatched left out` : '') +
      (c.rated ? `, ${c.rated} rated` : '') +
      (c.skipped ? `, ${c.skipped} other items skipped` : '') +
      '.',
  ];
  return { format: 'plex', records: res.records, warnings: res.warnings, notices, plex: c, dryRun, complete };
}

/** Print a dry run: what was read, nothing written. */
export function emitPlexDryRun(ctx: Ctx, parsed: PlexParsed): void {
  for (const n of parsed.notices) ctx.log(n);
  for (const w of parsed.warnings) ctx.log(`Warning: ${w}`);
  ctx.emit({ format: 'plex', dryRun: true, records: parsed.records.length, plex: parsed.plex, warnings: parsed.warnings }, () =>
    `Dry run: ${parsed.records.length} records would be imported from Plex. Nothing was written.`,
  );
}
