/**
 * Jellyfin: the movies on the user's own Jellyfin server, read over its REST
 * API (there is no export file). Read only: the importer signs in, lists the
 * user's movies page by page with `GET /Items?userId=`, and signs out again.
 * It talks to the server URL the user passes and nowhere else, and never
 * stores or prints the access token.
 *
 * Rules:
 * - Auth uses the `Authorization: MediaBrowser ... Token="..."` header only
 *   (Jellyfin 12 turned the X-Emby-* headers and `api_key` off). A token comes
 *   from the caller (JELLYFIN_TOKEN, or stdin); otherwise the importer logs in
 *   as the user with `POST /Users/AuthenticateByName` and logs that session
 *   out when it is done. `userId` is always sent, so `UserData` is the user's.
 * - Only `Type: Movie` items come in; virtual items, extras and placeholders
 *   are skipped and counted.
 * - Watched comes only from `UserData.Played`, never from PlayCount or the
 *   play position. Anything else sets no status, so a merge keeps the existing
 *   one and a new item goes to the queue.
 * - `watchedAt` is the local date of `LastPlayedDate`, only for played items,
 *   and dropped when 5 or more played items share a timestamp within 60 s
 *   (a bulk "mark played"). It is the last playback, not the first watch.
 * - Ratings are left out unless asked (`ratings`): then 1 to 10, rounded.
 * - `ProviderIds.Imdb` is a match hint, never a link: an owner can identify a
 *   file as the wrong film. The Jellyfin item id is not stable (moving a
 *   folder recreates items), so it is not stored.
 * - Jellyfin is the owner's own server, so a new item is owned (the default);
 *   a merge never changes an existing item's owned flag. Descriptive fields
 *   only fill blanks on an existing item (`fillOnly`).
 * - Two items with one IMDb id (unmerged versions) come in once: the played
 *   version, else the one played last, taken whole.
 * - Overview, images and file paths are never requested or read.
 */
import { createHash } from 'node:crypto';
import { cleanTconst, cleanText, ImportError, type ImportRecord, type ParsedImport } from './common.js';

export interface JellyfinMapOptions {
  /** Import `UserData.Rating` (rounded to a whole number from 1 to 10). Off by default. */
  ratings?: boolean;
  /** Played items with no known runtime (Jellyfin marks those played on any stop) come in without a status. */
  strictPlayed?: boolean;
}

export interface JellyfinParse extends ParsedImport {
  /** Items skipped, by reason (`BoxSet`, `Virtual`, `extra`, ...). */
  skippedByType: Record<string, number>;
  /** One line describing skippedByType, or nothing. */
  skippedSummary: string[];
  /** Plain notes about how the import read the library. */
  notices: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 100 ns ticks per minute. */
const TICKS_PER_MINUTE = 600_000_000;
/** A bulk "mark played" stamps every item with the time of the click. */
const BULK_MIN_ITEMS = 5;
const BULK_WINDOW_MS = 60_000;

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Milliseconds since the epoch for a Jellyfin date (7 fractional digits, UTC), or null. */
function parseDate(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = ISO_RE.exec(v.trim());
  if (!m) return null;
  const frac = m[2] ? m[2].slice(0, 4) : '';
  const ms = Date.parse(`${m[1]}${frac}${m[3] ?? 'Z'}`);
  return Number.isNaN(ms) ? null : ms;
}

/** The local calendar date (YYYY-MM-DD) of a timestamp. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A provider id by key, case-insensitively (`Imdb`, `imdb`, `IMDB`). */
function providerId(ids: unknown, key: string): unknown {
  if (!isObject(ids)) return undefined;
  const k = Object.keys(ids).find((x) => x.toLowerCase() === key);
  return k === undefined ? undefined : ids[k];
}

function directorsOf(people: unknown): string | null {
  if (!Array.isArray(people)) return null;
  const names: string[] = [];
  for (const p of people) {
    if (!isObject(p) || p.Type !== 'Director') continue;
    const name = cleanText(p.Name);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(', ') : null;
}

function genresOf(genres: unknown): string | null {
  if (!Array.isArray(genres)) return null;
  const out = [...new Set(genres.map(cleanText).filter((g): g is string => g !== null))];
  return out.length ? out.join(', ') : null;
}

function yearOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= 9999 ? v : null;
}

function runtimeOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const min = Math.round(v / TICKS_PER_MINUTE);
  return min > 0 ? min : null;
}

interface Pending {
  record: ImportRecord;
  /** The server's Played flag, whatever status the record got. */
  played: boolean;
  /** The server's LastPlayedDate, played or not. Only picks between versions. */
  lastPlayed: number | null;
  /** The date that may become watchedAt: set only when the record is watched. */
  playedAt: number | null;
}

/**
 * Several versions of one film (the same IMDb id, not merged on the server)
 * come in as one record: a version the server shows as played, else the one
 * with the latest LastPlayedDate, else the first. The chosen version is taken whole, so its own runtime and year
 * decide which library item it is, never another version's.
 */
function pickVersions(pending: Pending[]): ImportRecord[] {
  const best = new Map<string, Pending>();
  const better = (a: Pending, b: Pending) => {
    if (a.played !== b.played) return a.played;
    return (a.lastPlayed ?? -Infinity) > (b.lastPlayed ?? -Infinity);
  };
  for (const p of pending) {
    const key = p.record.imdbIdHint;
    if (!key) continue;
    const have = best.get(key);
    if (!have || better(p, have)) best.set(key, p);
  }
  const out: ImportRecord[] = [];
  const done = new Set<string>();
  for (const p of pending) {
    const key = p.record.imdbIdHint;
    if (!key) out.push(p.record);
    else if (!done.has(key)) {
      done.add(key);
      out.push((best.get(key) as Pending).record);
    }
  }
  return out;
}

/**
 * Map the `Items` of `GET /Items` responses to ImportRecords. Pure: no
 * network, no database.
 */
export function mapJellyfinItems(items: readonly unknown[], opts: JellyfinMapOptions = {}): JellyfinParse {
  const warnings: string[] = [];
  const notices: string[] = [];
  const skipped = new Map<string, number>();
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1);
  const pending: Pending[] = [];
  let unknownRuntimePlayed = 0;
  let rounded = 0;
  let thumbs = 0;
  let outOfRange = 0;
  let unwatched = 0;

  items.forEach((item, i) => {
    if (!isObject(item)) {
      skip('not an item');
      return;
    }
    const type = typeof item.Type === 'string' ? item.Type : 'unknown type';
    if (type !== 'Movie') return skip(type);
    if (item.LocationType === 'Virtual') return skip('missing file (virtual)');
    if (item.ExtraType !== undefined && item.ExtraType !== null) return skip('extra');
    if (item.IsPlaceHolder === true) return skip('placeholder');
    const title = cleanText(item.Name);
    if (!title) {
      warnings.push(`Item ${i + 1}: no name, skipped`);
      return;
    }
    const user = item.UserData;
    if (!isObject(user)) {
      throw new ImportError(
        'The server sent movies without this user\'s watch data (UserData). Sign in as the user, or pass the user id with an API key.',
      );
    }

    const runtime = runtimeOf(item.RunTimeTicks);
    const record: ImportRecord = {
      sourceTitle: title,
      sourceYear: yearOf(item.ProductionYear),
      sourceRuntimeMin: runtime,
      sourceGenre: genresOf(item.Genres),
      sourceDirector: directorsOf(item.People),
      imdbIdHint: cleanTconst(providerId(item.ProviderIds, 'imdb')),
      fillOnly: true,
      source: 'jellyfin',
    };

    let playedAt: number | null = null;
    if (user.Played === true) {
      if (runtime === null) unknownRuntimePlayed++;
      if (!(opts.strictPlayed && runtime === null)) {
        record.status = 'watched';
        playedAt = parseDate(user.LastPlayedDate);
      }
    } else unwatched++;

    if (opts.ratings) {
      const r = user.Rating;
      if (typeof r === 'number' && Number.isFinite(r) && r !== 0) {
        if (r < 1 || r > 10) outOfRange++;
        else {
          const n = Math.round(r);
          if (n !== r) rounded++;
          if (r === 10 || r === 1) thumbs++;
          record.myRating = n;
        }
      }
    }
    pending.push({ record, played: user.Played === true, lastPlayed: parseDate(user.LastPlayedDate), playedAt });
  });

  // A bulk "mark played" gives many items one timestamp: that is the click,
  // not when any of them was watched.
  // An item is in a bulk group when 5 or more played items, it among them,
  // fall within one 60 s span (latest minus earliest).
  // Every played item counts toward a group, including ones --strict-played
  // leaves without a status; only watched records then take a date.
  const dated = pending.filter((p) => p.played && p.lastPlayed !== null).sort((a, b) => (a.lastPlayed as number) - (b.lastPlayed as number));
  const inBulk = new Set<Pending>();
  for (let i = 0, j = 0, marked = 0; i < dated.length; i++) {
    j = Math.max(j, i);
    while (j < dated.length && (dated[j]?.lastPlayed as number) - (dated[i]?.lastPlayed as number) <= BULK_WINDOW_MS) j++;
    if (j - i < BULK_MIN_ITEMS) continue;
    // Each item is added once: windows overlap, so start where the last one ended.
    for (let k = Math.max(i, marked); k < j; k++) inBulk.add(dated[k] as Pending);
    marked = j;
  }
  let bulk = 0;
  for (const p of pending) {
    if (p.playedAt === null) continue;
    if (inBulk.has(p)) bulk++;
    else p.record.watchedAt = localDate(p.playedAt);
  }

  const records = pickVersions(pending);
  if (records.length < pending.length) {
    notices.push(`${pending.length - records.length} movie${pending.length - records.length === 1 ? ' is' : 's are'} on the server more than once (same IMDb id) and came in once.`);
  }

  if (bulk) notices.push(`Left out the watched date of ${bulk} movies marked played together (a bulk "mark played"), since it is not when they were watched.`);
  if (unknownRuntimePlayed) {
    warnings.push(
      opts.strictPlayed
        ? `${unknownRuntimePlayed} played movies have no known runtime, so Jellyfin may have marked them played on any stop; with --strict-played they came in without a status.`
        : `${unknownRuntimePlayed} played movies have no known runtime, so Jellyfin may have marked them played on any stop. Pass --strict-played to leave their status alone.`,
    );
  }
  if (unwatched) notices.push(`${unwatched} movies are not played on the server: a movie you don't have yet goes in the queue, and a movie you have keeps its status.`);
  if (rounded) warnings.push(`${rounded} ratings were not whole numbers and were rounded.`);
  if (thumbs) warnings.push(`${thumbs} ratings are exactly 10 or 1, which is usually a thumbs up or down in Jellyfin rather than a score.`);
  if (outOfRange) warnings.push(`${outOfRange} ratings outside 1 to 10 were left out.`);

  const skippedByType = Object.fromEntries(skipped);
  const total = [...skipped.values()].reduce((a, b) => a + b, 0);
  const skippedSummary = total
    ? [`Skipped ${total} items that are not movies in your library: ${[...skipped].map(([k, v]) => `${k} ${v}`).join(', ')}`]
    : [];
  return { records, warnings, notices, skippedByType, skippedSummary };
}

// ---------------------------------------------------------------------------
// The client.

export type JellyfinAuth =
  /** An access token (JELLYFIN_TOKEN). With an admin API key, pass the user's id or name. */
  | { token: string; userId?: string; userName?: string }
  /** Log in as this user; the session is logged out afterwards. */
  | { userName: string; password: string };

export interface JellyfinReadOptions {
  url: string;
  auth: JellyfinAuth;
  /** screentrackr's version, sent in the Authorization header. */
  version: string;
  /** A stable device id (see jellyfinDeviceId). */
  deviceId: string;
  /** Per request. Default 30 s. */
  timeoutMs?: number;
  /** Items per page. Default 200. */
  pageSize?: number;
  fetch?: typeof fetch;
}

export interface JellyfinRead {
  items: unknown[];
  userName: string;
  warnings: string[];
}

/**
 * The server's base URL: http or https, any path prefix (a reverse proxy's
 * base path), no credentials, query or fragment. The trailing slash is dropped.
 */
export function serverBase(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportError('--url must be the address of your Jellyfin server, such as http://localhost:8096');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImportError('--url must start with http:// or https://');
  if (url.username || url.password) throw new ImportError('--url must not contain a user name or password');
  if (url.search || url.hash) throw new ImportError('--url must not contain a query (?...) or fragment (#...); pass the token in JELLYFIN_TOKEN');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

/** What error messages show of the server: its origin and path, nothing else. */
const shown = (base: URL) => `${base.origin}${base.pathname}`;

/** A stable device id derived from a seed (the data home), so repeated runs are one device on the server. Nothing is stored. */
export function jellyfinDeviceId(seed: string): string {
  return createHash('sha256').update(`screentrackr:${seed}`).digest('hex').slice(0, 32);
}

const HEADER_SAFE = /^[\x21\x23-\x7e]+$/;

function authHeader(o: { version: string; deviceId: string }, token?: string): string {
  const parts = [`Client="screentrackr"`, `Device="screentrackr-cli"`, `DeviceId="${o.deviceId}"`, `Version="${o.version}"`];
  if (token !== undefined) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(', ')}`;
}

/** A system error code (ECONNREFUSED, ENOTFOUND, ...) somewhere in a fetch error's causes. Only the code, never a message. */
function errorCode(err: unknown, depth = 0): string | null {
  if (!isObject(err) && !(err instanceof Error)) return null;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code)) return e.code;
  if (depth > 4) return null;
  for (const next of [e.cause, ...(Array.isArray(e.errors) ? e.errors : [])]) {
    const code = errorCode(next, depth + 1);
    if (code) return code;
  }
  return null;
}

class Client {
  private token: string | undefined;
  constructor(
    private readonly base: URL,
    private readonly o: JellyfinReadOptions,
  ) {}

  setToken(token: string | undefined) {
    this.token = token;
  }

  async request(method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: unknown): Promise<Response> {
    const url = new URL(this.base.href);
    url.pathname = `${this.base.pathname.replace(/\/+$/, '')}${path}`;
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const doFetch = this.o.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        redirect: 'manual',
        headers: {
          Authorization: authHeader(this.o, this.token),
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const e = err as Error;
      const why =
        e.name === 'TimeoutError' || e.name === 'AbortError'
          ? 'it did not answer in time (raise the wait with --timeout <seconds>)'
          : (errorCode(e) ?? 'the connection failed');
      throw new ImportError(`Could not reach the Jellyfin server at ${shown(this.base)}: ${why}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ImportError(
        `The Jellyfin server at ${shown(this.base)} redirected the request (HTTP ${res.status}). Pass the address it redirects to as --url (https:// instead of http://, say).`,
      );
    }
    return res;
  }

  async json(method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    const res = await this.request(method, path, query, body);
    if (!res.ok) throw this.httpError(res, path);
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new ImportError(`The Jellyfin server at ${shown(this.base)} sent a reply to ${path} that is not JSON. Is --url the Jellyfin address?`);
    }
  }

  httpError(res: Response, path: string): ImportError {
    if (res.status === 401 || res.status === 403) {
      return new ImportError(
        `The Jellyfin server at ${shown(this.base)} refused the sign-in (HTTP ${res.status}). Check the user name and password, or the token in JELLYFIN_TOKEN.`,
      );
    }
    return new ImportError(`The Jellyfin server at ${shown(this.base)} answered ${path} with HTTP ${res.status}.`);
  }
}

const ITEM_FIELDS = 'ProviderIds,Genres,People,OriginalTitle,MediaSourceCount';

/**
 * Sign in, read every movie of the user's library, and sign out. The token is
 * only ever sent in the Authorization header to `url`.
 */
export async function readJellyfinItems(o: JellyfinReadOptions): Promise<JellyfinRead> {
  const base = serverBase(o.url);
  const client = new Client(base, o);
  const warnings: string[] = [];
  let loggedIn = false;
  let userId: string;
  let userName: string;

  const LOGOUT_FAILED = 'Could not sign out of the Jellyfin session; sign it out from the Jellyfin dashboard (Devices) or let the server expire it.';
  const logout = async (): Promise<boolean> =>
    !loggedIn ||
    (await client.request('POST', '/Sessions/Logout').then(
      (res) => res.ok,
      () => false,
    ));

  if ('token' in o.auth) {
    const token = o.auth.token.trim();
    if (!token) throw new ImportError('The Jellyfin token is empty.');
    if (!HEADER_SAFE.test(token)) throw new ImportError('The Jellyfin token has characters a token never has (spaces or quotes). Check JELLYFIN_TOKEN.');
    client.setToken(token);
    ({ userId, userName } = await tokenUser(client, o.auth));
  } else {
    const res = await client.json('POST', '/Users/AuthenticateByName', undefined, { Username: o.auth.userName, Pw: o.auth.password });
    const token = isObject(res) && typeof res.AccessToken === 'string' ? res.AccessToken : null;
    const user = isObject(res) && isObject(res.User) ? res.User : null;
    const noSession = `The Jellyfin server at ${shown(base)} did not return a session for that user.`;
    if (!token || !HEADER_SAFE.test(token)) throw new ImportError(noSession);
    client.setToken(token);
    loggedIn = true;
    if (!user || typeof user.Id !== 'string') {
      throw new ImportError((await logout()) ? noSession : `${noSession} ${LOGOUT_FAILED}`);
    }
    userId = user.Id;
    userName = typeof user.Name === 'string' ? user.Name : o.auth.userName;
  }

  let items: unknown[];
  try {
    items = await readAll(client, base, userId, o.pageSize ?? 200);
  } catch (err) {
    // The read failed: still sign out, and say so in the error when that failed too.
    const out = await logout();
    if (!out && err instanceof ImportError) throw new ImportError(`${err.message} ${LOGOUT_FAILED}`);
    throw err;
  }
  if (!(await logout())) warnings.push(LOGOUT_FAILED);
  return { items, userName, warnings };
}

/** Which user a token reads for: its own user, or (an admin API key) the one named. */
async function tokenUser(client: Client, auth: { userId?: string; userName?: string }): Promise<{ userId: string; userName: string }> {
  if (auth.userId) return { userId: auth.userId, userName: auth.userName ?? auth.userId };
  const me = await client.request('GET', '/Users/Me');
  if (me.ok) {
    const body = (await me.json().catch(() => null)) as unknown;
    if (isObject(body) && typeof body.Id === 'string') {
      const name = typeof body.Name === 'string' ? body.Name : body.Id;
      if (auth.userName && auth.userName.toLowerCase() !== name.toLowerCase()) {
        throw new ImportError(`The token signs in as a different Jellyfin user than --user ${JSON.stringify(auth.userName)}. Nothing was read.`);
      }
      return { userId: body.Id, userName: name };
    }
  }
  if (me.status === 401) throw client.httpError(me, '/Users/Me');
  // An admin API key has no user of its own.
  if (!auth.userName) {
    throw new ImportError('The token is not a user session (an API key, say), so pass whose library to read with --user <name> or --user-id <id>.');
  }
  const users = await client.json('GET', '/Users');
  const want = auth.userName.toLowerCase();
  const found = Array.isArray(users) ? users.filter((u) => isObject(u) && typeof u.Name === 'string' && u.Name.toLowerCase() === want) : [];
  if (found.length !== 1 || !isObject(found[0]) || typeof found[0].Id !== 'string') {
    throw new ImportError(`No single Jellyfin user is named ${JSON.stringify(auth.userName)} on that server. Pass --user-id <id> instead.`);
  }
  return { userId: found[0].Id, userName: found[0].Name as string };
}

/** How many times a read is retried when the library changes under it. */
const READ_ATTEMPTS = 3;

/**
 * Every movie, read page by page. A library scan can shift the pages while
 * they are read (an item seen twice, the count changing, fewer items than
 * the count), which would silently leave movies out; such a read is retried,
 * and refused when it never comes back whole.
 */
async function readAll(client: Client, base: URL, userId: string, pageSize: number): Promise<unknown[]> {
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    const read = await readPages(client, base, userId, pageSize);
    if (read.whole) return read.items;
  }
  throw new ImportError(
    `The Jellyfin library at ${shown(base)} kept changing while it was read (a library scan, say), so some movies could be missing. Nothing was imported; run the import again when the scan is done.`,
  );
}

async function readPages(client: Client, base: URL, userId: string, pageSize: number): Promise<{ items: unknown[]; whole: boolean }> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let whole = true;
  let start = 0;
  let total: number | null = null;
  for (let page = 0; total === null || start < total; page++) {
    if (page > 100_000) throw new ImportError(`The Jellyfin server at ${shown(base)} kept sending pages. Nothing was imported.`);
    const res = await client.json('GET', '/Items', {
      userId,
      includeItemTypes: 'Movie',
      recursive: 'true',
      excludeLocationTypes: 'Virtual',
      collapseBoxSetItems: 'false',
      fields: ITEM_FIELDS,
      enableUserData: 'true',
      enableImages: 'false',
      enableTotalRecordCount: 'true',
      sortBy: 'SortName,ProductionYear',
      sortOrder: 'Ascending',
      startIndex: String(start),
      limit: String(pageSize),
    });
    if (!isObject(res) || !Array.isArray(res.Items)) {
      throw new ImportError(`The Jellyfin server at ${shown(base)} sent an item list in a shape screentrackr does not know.`);
    }
    const pageItems = res.Items as unknown[];
    const count = res.TotalRecordCount;
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) {
      if (total !== null && count !== total) whole = false;
      total = count;
    }
    for (const item of pageItems) {
      const id = isObject(item) && typeof item.Id === 'string' ? item.Id : null;
      if (id !== null && seen.has(id)) {
        whole = false;
        continue;
      }
      if (id !== null) seen.add(id);
      items.push(item);
    }
    if (!pageItems.length) break;
    start += pageItems.length;
  }
  if (total !== null && items.length !== total) whole = false;
  return { items, whole };
}
