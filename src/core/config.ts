/**
 * `~/.screentrackr/config.json`: saved, non-secret settings (0.4.0). The
 * JustWatch `country` and the `sync` sources (Plex, Jellyfin, the TV app),
 * with the same options their `import` takes.
 *
 * Never a secret: tokens and passwords come from the environment only
 * (PLEX_TOKEN, JELLYFIN_TOKEN). A key that looks like one is refused with a
 * message saying so, on read and on write, and server URLs go through the
 * importers' own checks (http or https, no user name or password, no query
 * that could hold a token). The schema is strict (unknown keys are refused)
 * and versioned: a file from a newer screentrackr is refused rather than
 * rewritten. Writes are atomic (an owner-only temp file renamed over the old
 * one), so a crash never leaves a half-written file.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LibraryError } from './errors.js';
import { serverBase } from './importers/jellyfin.js';
import { PLEX_UNWATCHED_STATUSES, plexBaseUrl } from './importers/plex.js';

export const CONFIG_FILE = 'config.json';
export const CONFIG_VERSION = 1;
/** Far larger than any real config; a bigger file is not one we wrote. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** A problem with config.json or a setting. A user error (exit 1). */
export class ConfigError extends LibraryError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const SYNC_KINDS = ['plex', 'jellyfin', 'apple-tv'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

const TOKEN_ENV: Record<SyncKind, string | null> = { plex: 'PLEX_TOKEN', jellyfin: 'JELLYFIN_TOKEN', 'apple-tv': null };
const SECRET_KEY_RE = /token|passw(or)?d|api[_-]?key|secret/i;

const timeoutSec = z.number().positive().max(3600);
const name = z.string().trim().min(1).max(200);

const urlChecked = (check: (url: string) => URL) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((u, ctx) => {
      try {
        check(u);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message.replace(/^--url/, 'url') });
      }
    });

export const PlexSyncSourceSchema = z.strictObject({
  kind: z.literal('plex'),
  url: urlChecked(plexBaseUrl),
  sections: z.array(name).min(1).max(50).optional(),
  includeOtherVideos: z.boolean().optional(),
  unwatchedStatus: z.enum(PLEX_UNWATCHED_STATUSES).optional(),
  ratings: z.boolean().optional(),
  history: z.boolean().optional(),
});

export const JellyfinSyncSourceSchema = z.strictObject({
  kind: z.literal('jellyfin'),
  url: urlChecked(serverBase),
  user: name.optional(),
  userId: name.optional(),
  ratings: z.boolean().optional(),
  strictPlayed: z.boolean().optional(),
  timeoutSec: timeoutSec.optional(),
});

export const AppleTvSyncSourceSchema = z.strictObject({
  kind: z.literal('apple-tv'),
  timeoutSec: timeoutSec.optional(),
});

export const SyncSourceSchema = z.discriminatedUnion('kind', [PlexSyncSourceSchema, JellyfinSyncSourceSchema, AppleTvSyncSourceSchema]);

export type PlexSyncSource = z.infer<typeof PlexSyncSourceSchema>;
export type JellyfinSyncSource = z.infer<typeof JellyfinSyncSourceSchema>;
export type AppleTvSyncSource = z.infer<typeof AppleTvSyncSourceSchema>;
export type SyncSource = z.infer<typeof SyncSourceSchema>;

/** A JustWatch path country: two lowercase letters (`us`, `uk`, `de`). */
export const COUNTRY_RE = /^[a-z]{2}$/;

export const ConfigSchema = z
  .strictObject({
    version: z.literal(CONFIG_VERSION),
    country: z.string().regex(COUNTRY_RE, 'Expected two lowercase letters, such as us or uk').optional(),
    sync: z.strictObject({ sources: z.array(SyncSourceSchema).max(SYNC_KINDS.length * 4) }).optional(),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of (c.sync?.sources ?? []).entries()) {
      if (seen.has(s.kind)) ctx.addIssue({ code: 'custom', path: ['sync', 'sources', i], message: `only one ${s.kind} source is supported` });
      seen.add(s.kind);
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function configPath(home: string): string {
  return join(home, CONFIG_FILE);
}

/** Refuse anything that looks like a secret, naming where it is and which variable to use instead. */
function rejectSecrets(data: unknown, path: string[] = [], kind: SyncKind | null = null): void {
  if (Array.isArray(data)) {
    data.forEach((v, i) => rejectSecrets(v, [...path, String(i)], kind));
    return;
  }
  if (typeof data !== 'object' || data === null) return;
  const obj = data as Record<string, unknown>;
  const here = (SYNC_KINDS as readonly string[]).includes(obj.kind as string) ? (obj.kind as SyncKind) : kind;
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEY_RE.test(key)) {
      const env = here ? TOKEN_ENV[here] : null;
      throw new ConfigError(
        `config.json: "${[...path, key].join('.')}" looks like a secret. Tokens and passwords are never stored; ${env ? `set ${env}` : 'set PLEX_TOKEN or JELLYFIN_TOKEN'} in the environment instead.`,
      );
    }
    rejectSecrets(value, [...path, key], here);
  }
}

/** Validate a parsed config.json. Throws ConfigError naming the first problem. */
export function parseConfig(data: unknown): Config {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ConfigError('config.json must hold a JSON object');
  const version = (data as { version?: unknown }).version;
  if (typeof version === 'number' && version > CONFIG_VERSION) {
    throw new ConfigError(`config.json was written by a newer screentrackr (config version ${version}; this one reads ${CONFIG_VERSION}). Upgrade screentrackr.`);
  }
  rejectSecrets(data);
  const parsed = ConfigSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  const keys = issue && 'keys' in issue && Array.isArray(issue.keys) ? ` (${(issue.keys as string[]).join(', ')})` : '';
  throw new ConfigError(`Invalid config.json${where}: ${issue?.message ?? 'unknown error'}${keys}`);
}

/** The saved config, or an empty one (`{ version: 1 }`) when there is no file. Reading never creates it. */
export function loadConfig(home: string): Config {
  const path = configPath(home);
  let text: string;
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) throw new ConfigError(`${path} is too large to be a screentrackr config`);
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: CONFIG_VERSION };
    throw new ConfigError(`Could not read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(`${path} is not valid JSON. Fix it or remove it.`);
  }
  return parseConfig(data);
}

/** Validate and write the config atomically, owner-only (0600). */
export function saveConfig(home: string, config: Config): void {
  const clean = parseConfig(config);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  const tmp = join(home, `.${CONFIG_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new ConfigError(`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/** Read, change and write the config. Returns what was written. */
export function updateConfig(home: string, change: (config: Config) => Config): Config {
  const next = parseConfig(change(loadConfig(home)));
  saveConfig(home, next);
  return next;
}

/** Settings `screentrackr config get|set|unset` takes. */
export const CONFIG_KEYS = ['country'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

function assertKey(key: string): asserts key is ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new ConfigError(`Unknown setting "${key}" (settings: ${CONFIG_KEYS.join(', ')})`);
}

export function getConfigValue(config: Config, key: ConfigKey): string | undefined {
  assertKey(key);
  return config[key];
}

/** A changed copy with `key` set. `country` is lowercased (GB and gb are the same). */
export function setConfigValue(config: Config, key: ConfigKey, value: string): Config {
  assertKey(key);
  const v = value.trim().toLowerCase();
  return parseConfig({ ...config, [key]: v });
}

export function unsetConfigValue(config: Config, key: ConfigKey): Config {
  assertKey(key);
  const next: Record<string, unknown> = { ...config };
  delete next[key];
  return parseConfig(next);
}

/** The saved source of a kind, if any. */
export function syncSource<K extends SyncKind>(config: Config, kind: K): Extract<SyncSource, { kind: K }> | undefined {
  return config.sync?.sources.find((s) => s.kind === kind) as Extract<SyncSource, { kind: K }> | undefined;
}

/** A changed copy with this source added, or replacing the saved one of its kind (in place). */
export function upsertSyncSource(config: Config, source: SyncSource): Config {
  const sources = [...(config.sync?.sources ?? [])];
  const i = sources.findIndex((s) => s.kind === source.kind);
  if (i >= 0) sources[i] = source;
  else sources.push(source);
  return parseConfig({ ...config, sync: { sources } });
}

/** A changed copy without the source of this kind. Throws when there is none. */
export function removeSyncSource(config: Config, kind: SyncKind): Config {
  if (!syncSource(config, kind)) throw new ConfigError(`No ${kind} source is configured`);
  return parseConfig({ ...config, sync: { sources: (config.sync?.sources ?? []).filter((s) => s.kind !== kind) } });
}
