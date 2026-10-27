/**
 * Where to watch: a JustWatch search link for a movie. Only a link. Nothing
 * here fetches JustWatch or anything else; `openUrl` hands the link to the
 * system browser (`open` on macOS, `xdg-open` on Linux), spawned with the URL
 * as its one argument and never through a shell.
 *
 * The country is JustWatch's own path code. It is two lowercase letters,
 * mostly the ISO 3166 code, except that the United Kingdom is `uk` (GB is
 * mapped). It comes from a `--country` flag, else config.json `country`,
 * else the region of the system locale, else `us`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { Db } from './db.js';
import { ConfigError, COUNTRY_RE, loadConfig } from './config.js';
import { LibraryError } from './errors.js';
import { getItem } from './library.js';
import { getCatalogMovie } from './movie.js';
import { stripTitleSuffixes } from './normalize.js';
import type { LibraryItem } from './types.js';

export const JUSTWATCH_ORIGIN = 'https://www.justwatch.com';
export const DEFAULT_COUNTRY = 'us';
/** ISO codes JustWatch spells differently in its paths. */
export const JUSTWATCH_COUNTRY_MAP: Readonly<Record<string, string>> = { gb: 'uk' };

/** A movie's link, with the title it searches for and the country path it uses. */
export interface WhereToWatch {
  title: string;
  country: string;
  url: string;
}

/** A country code as JustWatch's path uses it: lowercased, mapped (GB is uk), two letters. Throws LibraryError otherwise. */
export function justWatchCountry(code: string): string {
  const c = code.trim().toLowerCase();
  if (!COUNTRY_RE.test(c)) throw new LibraryError(`Country must be two letters, such as us or uk (got "${code}")`);
  return JUSTWATCH_COUNTRY_MAP[c] ?? c;
}

/** The JustWatch search link for a title in a country. Pure: builds a string, fetches nothing. */
export function justWatchUrl(title: string, country: string): string {
  const q = title.trim();
  if (!q) throw new LibraryError('No title to search for');
  return `${JUSTWATCH_ORIGIN}/${justWatchCountry(country)}/search?q=${encodeURIComponent(q)}`;
}

/** A locale's region as two lowercase letters (`en_GB.UTF-8` or `en-GB` gives gb), or null. */
function regionOf(locale: string | undefined): string | null {
  if (!locale) return null;
  const tag = locale.split(/[.@]/)[0]?.replace(/_/g, '-') ?? '';
  if (!tag || tag === 'C' || tag === 'POSIX') return null;
  try {
    const region = new Intl.Locale(tag).region;
    return region && /^[A-Za-z]{2}$/.test(region) ? region.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The region of the system locale: from LC_ALL, LC_MESSAGES or LANG (the
 * first one set, as POSIX reads them), else from the Intl default locale.
 * Null when none names a two-letter region.
 */
export function localeRegion(env: NodeJS.ProcessEnv = process.env, intlLocale: string = Intl.DateTimeFormat().resolvedOptions().locale): string | null {
  const fromEnv = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v !== '');
  return regionOf(fromEnv) ?? regionOf(intlLocale);
}

export type CountrySource = 'flag' | 'config' | 'locale' | 'default';

/**
 * The JustWatch country to use: `flag` (validated, a bad one is an error),
 * else the saved setting, else the locale's region, else us. Mapped for
 * JustWatch either way.
 */
export function resolveCountry(opts: { flag?: string | undefined; saved?: string | undefined; env?: NodeJS.ProcessEnv; intlLocale?: string }): {
  country: string;
  from: CountrySource;
} {
  if (opts.flag !== undefined) return { country: justWatchCountry(opts.flag), from: 'flag' };
  if (opts.saved !== undefined) return { country: justWatchCountry(opts.saved), from: 'config' };
  const region = localeRegion(opts.env ?? process.env, opts.intlLocale);
  if (region) return { country: justWatchCountry(region), from: 'locale' };
  return { country: DEFAULT_COUNTRY, from: 'default' };
}

/** The saved `country` in config.json, if any. Throws ConfigError for a config that can't be read. */
export function savedCountry(home: string): string | undefined {
  return loadConfig(home).country;
}

/**
 * The country for a data home: `flag` when given (config.json is not read
 * then), else as `resolveCountry` decides. A config.json that can't be read
 * does not stop a link: `onConfigError` hears about it and the locale decides.
 */
export function countryForHome(
  home: string,
  opts: { flag?: string | undefined; onConfigError?: (err: Error) => void; env?: NodeJS.ProcessEnv } = {},
): { country: string; from: CountrySource } {
  if (opts.flag !== undefined) return resolveCountry({ flag: opts.flag });
  let saved: string | undefined;
  try {
    saved = savedCountry(home);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    opts.onConfigError?.(err);
  }
  return resolveCountry({ saved, ...(opts.env ? { env: opts.env } : {}) });
}

/**
 * The title a JustWatch search should use: the catalog's primary title for a
 * linked item, else the source title without edition tags or a trailing year
 * (case kept).
 */
export function whereTitle(t: { linked: boolean; catalogTitle: string | null; sourceTitle: string }): string {
  if (t.linked && t.catalogTitle) return t.catalogTitle;
  return stripTitleSuffixes(t.sourceTitle);
}

const isLinked = (i: Pick<LibraryItem, 'tconst' | 'matchStatus'>) => i.tconst !== null && (i.matchStatus === 'matched' || i.matchStatus === 'manual');

/** The link for a library item. */
export function whereForItem(db: Db, item: LibraryItem, country: string): WhereToWatch {
  const linked = isLinked(item);
  const catalogTitle = linked ? (getCatalogMovie(db, item.tconst as string)?.title ?? null) : null;
  return whereFor(whereTitle({ linked, catalogTitle, sourceTitle: item.sourceTitle }), country);
}

/**
 * The link for an IMDb id: the catalog's title when the catalog has it, else
 * the title of a library item linked to it. Null when neither knows it.
 */
export function whereForTconst(db: Db, tconst: string, country: string): WhereToWatch | null {
  const movie = getCatalogMovie(db, tconst);
  if (movie) return whereFor(movie.title, country);
  const item = db.sql
    .prepare("SELECT id FROM library_items WHERE tconst = ? AND match_status IN ('matched', 'manual') ORDER BY id LIMIT 1")
    .get(tconst.trim().toLowerCase()) as { id: number } | undefined;
  const found = item ? getItem(db, Number(item.id)) : null;
  return found ? whereForItem(db, found, country) : null;
}

/** The link for a title already chosen (a catalog title, or a search result's title). */
export function whereFor(title: string, country: string): WhereToWatch {
  const c = justWatchCountry(country);
  return { title, country: c, url: justWatchUrl(title, c) };
}

/** The command that opens a URL in the browser on this platform, or null where `--open` is not supported. */
export function openerFor(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

interface SpawnedChild {
  once(event: 'spawn', fn: () => void): unknown;
  once(event: 'error', fn: (err: Error) => void): unknown;
  once(event: 'exit', fn: (code: number | null, signal: string | null) => void): unknown;
  unref(): void;
}
type SpawnFn = (command: string, args: string[], options: { stdio: 'ignore'; detached: boolean; shell: false }) => SpawnedChild;

/** How long `openUrl` waits for the opener to report failure before taking it as handed off. */
export const OPENER_WAIT_MS = 3000;

/**
 * Hand a JustWatch link to the system browser. The URL is the opener's only
 * argument and no shell runs, so nothing in it can become a command or an
 * option. Anything but a JustWatch https link is refused. `open` and
 * `xdg-open` normally exit at once: a nonzero exit (no browser, say) is an
 * error. An opener still running after `waitMs` (some xdg-open setups run the
 * browser in the foreground) is left running and taken as handed off.
 */
export function openUrl(url: string, opts: { platform?: NodeJS.Platform; spawn?: SpawnFn; waitMs?: number } = {}): Promise<void> {
  if (!url.startsWith(`${JUSTWATCH_ORIGIN}/`)) return Promise.reject(new LibraryError('Only a JustWatch link can be opened'));
  const command = openerFor(opts.platform ?? process.platform);
  if (!command) return Promise.reject(new LibraryError('--open works on macOS and Linux. Open the link yourself.'));
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const waitMs = opts.waitMs ?? OPENER_WAIT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (err?: LibraryError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    let child: SpawnedChild;
    try {
      child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false });
    } catch (err) {
      settle(new LibraryError(`Could not run ${command}: ${(err as Error).message}`));
      return;
    }
    child.once('spawn', () => {
      timer = setTimeout(() => {
        child.unref();
        settle();
      }, waitMs);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) settle();
      else settle(new LibraryError(`${command} could not open the link (${code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`}). Open it yourself.`));
    });
    child.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      settle(new LibraryError(code === 'ENOENT' ? `${command} was not found. Open the link yourself.` : `Could not run ${command}: ${err.message}`));
    });
  });
}
