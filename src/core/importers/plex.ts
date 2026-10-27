/**
 * Copyright (c) 2026 Benjamin Reece
 *
 * Plex Media Server: reads the movie libraries of the user's own server,
 * read-only, through its local HTTP API (https://developer.plex.tv/pms/).
 *
 * Rules (each one keeps a Plex import safe for the server and for the library
 * it merges into):
 * - Only GET requests, only to the server URL the user gives, never through a
 *   relay, and redirects are refused (a redirect would carry the token
 *   elsewhere). No request ever carries a parameter that makes the server do
 *   work (checkFiles, async*, skipRefresh, checkFileAvailability,
 *   augmentCount); listings are paged and trimmed with excludeFields.
 * - The token travels only in the X-Plex-Token header, never in a URL. It is
 *   never stored, logged or echoed, and error messages are redacted.
 * - Only titles, years, directors, genres, runtime, collections and ids are
 *   read into records: no summaries, art, file paths or raw payloads.
 * - A movie library is files on disk, so every movie is owned (`owned`).
 * - `viewCount > 0` means watched. Anything else sets no status, only the
 *   status a NEW item gets (`statusIfNew`, someday by default), so an import
 *   never moves an existing item and never floods the queue.
 * - The IMDb id from Plex's Guids (or a legacy IMDb agent guid) is a hint,
 *   checked against the catalog: an automatic match can be wrong.
 * - Descriptive fields only fill blanks on an existing item (`fillOnly`), so
 *   a merge keeps credits and genres another import or the owner set.
 * - Plex's own ids (ratingKey, plex:// guid) are not stored: a ratingKey is
 *   per server and per file, and a guid changes when the owner fixes a match.
 */
import { cleanTconst, cleanText, cleanYear, foldRecords, ImportError, type ImportRecord, type ParsedImport } from './common.js';

export interface PlexTag {
  tag?: unknown;
  id?: unknown;
}

/** One item of a Plex listing, as far as the importer reads it. Unknown fields are ignored. */
export interface PlexMetadata {
  ratingKey?: unknown;
  type?: unknown;
  guid?: unknown;
  title?: unknown;
  year?: unknown;
  duration?: unknown;
  userRating?: unknown;
  viewCount?: unknown;
  lastViewedAt?: unknown;
  viewOffset?: unknown;
  editionTitle?: unknown;
  Guid?: PlexTag[] | unknown;
  Director?: PlexTag[] | unknown;
  Genre?: PlexTag[] | unknown;
  Collection?: PlexTag[] | unknown;
  [key: string]: unknown;
}

export const PLEX_UNWATCHED_STATUSES = ['someday', 'queue', 'skip'] as const;
export type PlexUnwatchedStatus = (typeof PLEX_UNWATCHED_STATUSES)[number];

export const PLEX_DEFAULT_URL = 'http://127.0.0.1:32400';

export interface PlexMapOptions {
  /** What a NEW unwatched movie becomes: someday (default), queue, or skip (not imported). */
  unwatchedStatus?: PlexUnwatchedStatus;
  /** Read Plex star ratings (default true). */
  ratings?: boolean;
}

export interface PlexReadOptions extends PlexMapOptions {
  url: string;
  token: string;
  /** X-Plex-Client-Identifier: one id per install. */
  clientId: string;
  /** X-Plex-Version. */
  version: string;
  /** Section keys or titles to read. Default: every movie section but "Other Videos" ones. */
  sections?: string[];
  includeOtherVideos?: boolean;
  /** Movies per listing request (default 200). */
  pageSize?: number;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface PlexCounts {
  movies: number;
  watched: number;
  unwatched: number;
  skippedUnwatched: number;
  rated: number;
  skipped: number;
}

export interface PlexImport extends ParsedImport {
  counts: PlexCounts;
  notices: string[];
}

export interface PlexSection {
  key: string;
  title: string;
}

const EDITION_WORDS =
  /\b(?:edition|cut|uncut|extended|version|4k|uhd|hd|unrated|rated|theatrical|remaster(?:ed)?|restored|imax|3d|blu ?ray|widescreen|fullscreen|anniversary|subtitled|dubbed)\b/i;
const OTHER_VIDEOS_AGENT = 'tv.plex.agents.none';
const EXCLUDE_FIELDS = 'summary,tagline,thumb,art,banner,theme,composite';
const DETAIL_BATCH = 50;
const MAX_PAGES = 10_000;
/** Parameters that would make the server check files, refresh or analyze. Never sent. */
const FORBIDDEN_PARAMS = /^(?:checkfiles|async.*|skiprefresh|checkfileavailability|augmentcount|x-plex-token)$/i;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const tags = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((t) => cleanText((t as PlexTag | null)?.tag)).filter((s): s is string => s !== null) : [];

const joined = (v: unknown): string | null => {
  const xs = [...new Set(tags(v))];
  return xs.length ? xs.join(', ') : null;
};

/** The IMDb id Plex has for an item: an `imdb://` Guid, else a legacy IMDb agent guid. */
function imdbIdOf(m: PlexMetadata): string | null {
  if (Array.isArray(m.Guid)) {
    for (const g of m.Guid as PlexTag[]) {
      const id = cleanText(g?.id);
      const hit = id && /^imdb:\/\/(tt\d+)$/i.exec(id);
      if (hit) return cleanTconst(hit[1]);
    }
  }
  const legacy = cleanText(m.guid);
  const hit = legacy && /^com\.plexapp\.agents\.imdb:\/\/(tt\d+)/i.exec(legacy);
  return hit ? cleanTconst(hit[1]) : null;
}

/** Local calendar date of an epoch-seconds time, YYYY-MM-DD. */
function localDate(epochSeconds: number): string | null {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime()) || epochSeconds <= 0) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A bulk "mark as watched" stamps every item with one day; such days carry no watch date. */
const BULK_MIN = 5;
const BULK_SHARE = 0.2;

/** Turn Plex listing items into import records. Pure; no network. */
export function mapPlexItems(items: PlexMetadata[], opts: PlexMapOptions = {}): PlexImport {
  const unwatched = opts.unwatchedStatus ?? 'someday';
  if (!(PLEX_UNWATCHED_STATUSES as readonly string[]).includes(unwatched)) {
    throw new ImportError(`Unknown unwatched status "${String(unwatched)}" (expected ${PLEX_UNWATCHED_STATUSES.join(', ')})`);
  }
  const ratings = opts.ratings !== false;
  const warnings: string[] = [];
  const counts: PlexCounts = { movies: 0, watched: 0, unwatched: 0, skippedUnwatched: 0, rated: 0, skipped: 0 };
  let rounded = 0;
  let outOfRange = 0;
  const out: { rec: ImportRecord; edition: string; runtime: number | null }[] = [];

  for (const m of items) {
    if (m === null || typeof m !== 'object' || m.type !== 'movie') {
      counts.skipped++;
      continue;
    }
    const title = cleanText(m.title);
    if (!title) {
      counts.skipped++;
      continue;
    }
    counts.movies++;
    const edition = cleanText(m.editionTitle);
    let sourceTitle = title;
    if (edition) {
      if (EDITION_WORDS.test(edition)) sourceTitle = `${title} (${edition})`;
      else warnings.push(`"${title}": the edition "${edition}" is not a recognized edition name, so it was imported as "${title}"`);
    }
    const duration = num(m.duration);
    const runtime = duration !== null && duration > 0 ? Math.round(duration / 60000) : null;
    const year = num(m.year);
    const rec: ImportRecord = {
      sourceTitle,
      sourceYear: year !== null && Number.isInteger(year) ? cleanYear(year) : null,
      sourceDirector: joined(m.Director),
      sourceGenre: joined(m.Genre),
      sourceRuntimeMin: runtime,
      collection: joined(m.Collection),
      imdbIdHint: imdbIdOf(m),
      owned: true,
      sourceOwnedRaw: 'plex',
      fillOnly: true,
      source: 'plex',
    };

    const views = num(m.viewCount);
    if (views !== null && views > 0) {
      rec.status = 'watched';
      const last = num(m.lastViewedAt);
      const date = last === null ? null : localDate(last);
      if (date) rec.watchedAt = date;
      counts.watched++;
    } else if (unwatched === 'skip') {
      counts.skippedUnwatched++;
      continue;
    } else {
      rec.statusIfNew = unwatched;
      counts.unwatched++;
    }

    if (ratings) {
      const r = num(m.userRating);
      if (r !== null && r !== 0) {
        if (r < 0 || r > 10) outOfRange++;
        else {
          const whole = Math.round(r);
          if (whole !== r) rounded++;
          if (whole >= 1) {
            rec.myRating = whole;
            counts.rated++;
          }
        }
      }
    }
    out.push({ rec, edition: edition?.toLowerCase() ?? '', runtime });
  }
  if (rounded) warnings.push(`${rounded} Plex rating${rounded === 1 ? ' was' : 's were'} not a whole number and ${rounded === 1 ? 'was' : 'were'} rounded`);
  if (outOfRange) warnings.push(`${outOfRange} Plex rating${outOfRange === 1 ? ' was' : 's were'} out of range (0 to 10) and left out`);

  // Bulk-marked watched: one calendar day holding a large share of the dated
  // watched movies is the day they were marked, not watched.
  const dated = out.filter((o) => o.rec.watchedAt);
  const byDay = new Map<string, number>();
  for (const o of dated) byDay.set(o.rec.watchedAt as string, (byDay.get(o.rec.watchedAt as string) ?? 0) + 1);
  for (const [day, n] of byDay) {
    if (n >= BULK_MIN && n > dated.length * BULK_SHARE) {
      for (const o of dated) if (o.rec.watchedAt === day) delete o.rec.watchedAt;
      warnings.push(`${n} movies were last watched on the same day (${day}), which looks like a bulk "mark as watched"; they stay watched, without that date`);
    }
  }

  // One film in two movie libraries is one item; editions (by name, or a
  // runtime more than 3 minutes apart) stay separate.
  const groupOf = new Map<ImportRecord, string>();
  const groups = new Map<string, { runtime: number | null }[]>();
  for (const o of out) {
    const base = o.rec.imdbIdHint ? `imdb:${o.rec.imdbIdHint}|${o.edition}` : null;
    if (!base) continue;
    const list = groups.get(base) ?? [];
    let idx = list.findIndex((g) => g.runtime === null || o.runtime === null || Math.abs(g.runtime - o.runtime) <= 3);
    if (idx < 0) {
      list.push({ runtime: o.runtime });
      idx = list.length - 1;
    }
    groups.set(base, list);
    groupOf.set(o.rec, `${base}#${idx}`);
  }
  const records = foldRecords(
    out.map((o) => o.rec),
    (r) => groupOf.get(r),
    (w) => warnings.push(w),
  );
  return { records, warnings, counts, notices: [] };
}

/** Movies from saved listing JSON: one MediaContainer response, an array of them, or a bare array of items. */
export function parsePlexDump(text: string): PlexMetadata[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new ImportError('The file is not JSON. Save Plex listings as JSON (request them with Accept: application/json).');
  }
  const fromContainer = (x: unknown): PlexMetadata[] | null => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return null;
    const mc = (x as { MediaContainer?: unknown }).MediaContainer ?? x;
    const meta = (mc as { Metadata?: unknown } | null)?.Metadata;
    return Array.isArray(meta) ? (meta as PlexMetadata[]) : null;
  };
  const one = fromContainer(data);
  if (one) return one;
  if (Array.isArray(data)) {
    if (data.every((x) => fromContainer(x) !== null)) return data.flatMap((x) => fromContainer(x) as PlexMetadata[]);
    if (data.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x) && 'type' in x)) return data as PlexMetadata[];
  }
  throw new ImportError('Expected a saved Plex listing: { "MediaContainer": { "Metadata": [...] } }, an array of those, or an array of items.');
}

/** The server URL the user gave, checked: http or https, no credentials, no query string. */
export function plexBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ImportError('--url must be a full server address such as http://127.0.0.1:32400');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImportError('--url must start with http:// or https://');
  if (url.username || url.password) throw new ImportError('--url must not contain a user name or password');
  if (url.search || url.hash) throw new ImportError('--url must not have a query string or fragment (pass the token in PLEX_TOKEN)');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function redact(text: string, token: string): string {
  if (!token) return text;
  let out = text;
  for (const t of new Set([token, encodeURIComponent(token)])) out = out.split(t).join('[redacted]');
  return out;
}

const TOKEN_HELP =
  'Plex refused the token (HTTP 401): it is expired or wrong. Copy a fresh one (https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/); changing your Plex password with "Sign out connected devices" invalidates every token.';

class PlexClient {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly base: URL,
    private readonly opts: PlexReadOptions,
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private fail(message: string): never {
    throw new ImportError(redact(message, this.opts.token));
  }

  async get(path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    for (const [k, v] of Object.entries(params)) {
      if (FORBIDDEN_PARAMS.test(k)) this.fail(`Refusing to send the parameter "${k}" to the Plex server`);
      url.searchParams.set(k, v);
    }
    const where = `${this.base.origin}${this.base.pathname === '/' ? '' : this.base.pathname}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        headers: {
          Accept: 'application/json',
          'X-Plex-Token': this.opts.token,
          'X-Plex-Client-Identifier': this.opts.clientId,
          'X-Plex-Product': 'ScreenTrackr',
          'X-Plex-Version': this.opts.version,
          ...headers,
        },
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: unknown; message?: unknown } };
      const code = typeof e.cause?.code === 'string' ? e.cause.code : e.name === 'TimeoutError' ? 'timed out' : null;
      const detail = code ?? (typeof e.cause?.message === 'string' ? e.cause.message : e.message);
      this.fail(
        `Could not reach the Plex server at ${where} (${detail}). Check --url; if the server requires secure connections, use its https plex.direct address.`,
      );
    }
    if (res.status === 401) this.fail(TOKEN_HELP);
    if (!res.ok) this.fail(`The Plex server answered HTTP ${res.status} for ${url.pathname}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/json/i.test(type)) {
      const kind = /xml/i.test(type) ? 'XML' : /html/i.test(type) ? 'HTML' : type || 'an unknown type';
      this.fail(`The server at ${where} answered with ${kind} instead of JSON. Is --url your Plex Media Server (usually port 32400)?`);
    }
    try {
      return { body: (await res.json()) as unknown, headers: res.headers };
    } catch {
      this.fail(`The Plex server sent JSON that does not parse (${url.pathname})`);
    }
  }
}

const container = (body: unknown): Record<string, unknown> => {
  const mc = (body as { MediaContainer?: unknown } | null)?.MediaContainer;
  return mc !== null && typeof mc === 'object' ? (mc as Record<string, unknown>) : {};
};

async function listSections(client: PlexClient, opts: PlexReadOptions, notices: string[]): Promise<PlexSection[]> {
  const { body } = await client.get('/library/sections/all');
  const dirs = container(body).Directory;
  const all = (Array.isArray(dirs) ? dirs : []).map((d) => {
    const x = d as Record<string, unknown>;
    return { key: cleanText(x.key) ?? '', title: cleanText(x.title) ?? '', type: cleanText(x.type), agent: cleanText(x.agent) };
  });
  const movies = all.filter((s) => s.type === 'movie' && s.key);
  if (opts.sections?.length) {
    return opts.sections.map((want) => {
      const w = want.trim().toLowerCase();
      const hit = all.find((s) => s.key === want.trim()) ?? all.find((s) => s.title.toLowerCase() === w);
      if (!hit) {
        throw new ImportError(
          `No movie library named "${want}" on the server. Movie libraries: ${movies.map((s) => `${s.title} (${s.key})`).join(', ') || 'none'}`,
        );
      }
      if (hit.type !== 'movie') throw new ImportError(`"${hit.title}" is not a movie library (it holds ${hit.type ?? 'something else'})`);
      return { key: hit.key, title: hit.title };
    });
  }
  const picked = movies.filter((s) => opts.includeOtherVideos || s.agent !== OTHER_VIDEOS_AGENT);
  const other = movies.filter((s) => !picked.includes(s));
  if (other.length) {
    notices.push(`Skipped ${other.map((s) => `"${s.title}"`).join(', ')} (Other Videos). Pass --include-other-videos or --section to read ${other.length === 1 ? 'it' : 'them'}.`);
  }
  return picked.map((s) => ({ key: s.key, title: s.title }));
}

async function listMovies(client: PlexClient, section: PlexSection, pageSize: number, warnings: string[]): Promise<PlexMetadata[]> {
  const out: PlexMetadata[] = [];
  const seen = new Set<string>();
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { body, headers } = await client.get(
      `/library/sections/${encodeURIComponent(section.key)}/all`,
      { type: '1', includeGuids: '1', excludeFields: EXCLUDE_FIELDS },
      { 'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(pageSize) },
    );
    const mc = container(body);
    const meta = Array.isArray(mc.Metadata) ? (mc.Metadata as PlexMetadata[]) : [];
    const total = num(mc.totalSize) ?? num(headers.get('X-Plex-Container-Total-Size'));
    let fresh = 0;
    for (const m of meta) {
      const key = cleanText(m?.ratingKey);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(m);
      fresh++;
    }
    // The server may ignore the requested size or not page at all: advance by
    // what came back, and stop on an empty page or one with nothing new.
    if (meta.length === 0 || fresh === 0) {
      if (total !== null && out.length < total) {
        warnings.push(`"${section.title}" returned fewer movies than it reported (${out.length} of ${total})`);
      }
      break;
    }
    start += meta.length;
    if (total !== null ? start >= total : meta.length < pageSize) break;
  }
  return out;
}

/**
 * Fill in Guids, directors and genres for items matched by an agent that the
 * listing returned without them. Only items with a `plex://` guid (matched by
 * the current agent) can have more to give. Never sends a side-effect parameter.
 */
async function fillDetails(client: PlexClient, movies: PlexMetadata[]): Promise<void> {
  const needs = movies.filter(
    (m) =>
      cleanText(m.ratingKey) !== null &&
      /^plex:\/\//.test(cleanText(m.guid) ?? '') &&
      (!Array.isArray(m.Guid) || !Array.isArray(m.Director)),
  );
  for (let i = 0; i < needs.length; i += DETAIL_BATCH) {
    const batch = needs.slice(i, i + DETAIL_BATCH);
    const ids = batch.map((m) => encodeURIComponent(String(m.ratingKey))).join(',');
    const { body } = await client.get(`/library/metadata/${ids}`, { includeGuids: '1', excludeFields: EXCLUDE_FIELDS });
    const meta = container(body).Metadata;
    const byKey = new Map((Array.isArray(meta) ? (meta as PlexMetadata[]) : []).map((m) => [String(m.ratingKey), m]));
    for (const m of batch) {
      const d = byKey.get(String(m.ratingKey));
      if (!d) continue;
      for (const k of ['Guid', 'Director', 'Genre'] as const) if (!Array.isArray(m[k]) && Array.isArray(d[k])) m[k] = d[k];
    }
  }
}

/** Read the movie libraries of a Plex Media Server and map them to import records. */
export async function readPlexLibrary(opts: PlexReadOptions): Promise<PlexImport & { sections: PlexSection[] }> {
  const base = plexBaseUrl(opts.url);
  if (!opts.token) throw new ImportError('No Plex token. Set PLEX_TOKEN.');
  const client = new PlexClient(base, opts);
  const notices: string[] = [];
  const warnings: string[] = [];
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 200, 1000));
  const sections = await listSections(client, opts, notices);
  const movies: PlexMetadata[] = [];
  for (const s of sections) movies.push(...(await listMovies(client, s, pageSize, warnings)));
  const matched = movies.filter((m) => /^plex:\/\//.test(cleanText(m.guid) ?? ''));
  if (matched.length && !matched.some((m) => Array.isArray(m.Guid))) {
    warnings.push(
      'The server returned no external ids (includeGuids was ignored), so they were fetched per movie; movies without an IMDb id are matched by title, year, runtime and director',
    );
  }
  await fillDetails(client, movies);
  const mapped = mapPlexItems(movies, opts);
  return { ...mapped, warnings: [...warnings, ...mapped.warnings], notices: [...notices, ...mapped.notices], sections };
}
