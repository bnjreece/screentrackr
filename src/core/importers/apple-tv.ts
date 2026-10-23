/**
 * Apple TV import on macOS (experimental).
 *
 * Runs `apple-tv.jxa.js` through `osascript -l JavaScript`, which reads the TV
 * app's library and prints the movies as a JSON array.
 *
 * A movie becomes `watched` only when it has a play count and a played date.
 * A cloud library can report a play count of 1 on nearly every track with no
 * played date at all, so the count alone is not proof of watching. Anything
 * else carries no status, so a merge keeps whatever status the library has.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WATCHED_AT_RE } from '../library.js';
import { cleanText, cleanYear, ImportError, type ImportRecord } from './common.js';

/** The JXA script, beside this module in both `src/` and `dist/`. */
export const APPLE_TV_SCRIPT_PATH = fileURLToPath(new URL('./apple-tv.jxa.js', import.meta.url));

export const DEFAULT_APPLE_TV_TIMEOUT_MS = 120_000;

const PASTE_HINT =
  'Apple TV import is experimental. Instead, select your movies in the TV app list view, copy them, paste into a text file and run `screentrackr import <file>`.';

export type AppleTvRunner = (script: string, opts?: { signal?: AbortSignal }) => Promise<string>;

/** One track as the JXA script prints it. */
interface JxaTrack {
  name?: unknown;
  year?: unknown;
  director?: unknown;
  genre?: unknown;
  duration?: unknown;
  playedCount?: unknown;
  playedDate?: unknown;
  persistentID?: unknown;
  dateAdded?: unknown;
  mediaKind?: unknown;
}

const MOVIE_KINDS = new Set(['movie', 'home video']);

/** Parse the JXA script's stdout into import records. Non-movie tracks and tracks without a name are dropped. */
export function parseAppleTvJxaOutput(json: string): ImportRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(json) as unknown;
  } catch {
    throw new ImportError(`The TV app returned something that is not JSON. ${PASTE_HINT}`);
  }
  if (!Array.isArray(data)) throw new ImportError(`The TV app returned an unexpected shape (expected a list of movies). ${PASTE_HINT}`);

  const records: ImportRecord[] = [];
  for (const raw of data as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as JxaTrack;
    if (typeof t.mediaKind === 'string' && !MOVIE_KINDS.has(t.mediaKind)) continue;
    const title = cleanText(t.name);
    if (!title) continue;

    const year = typeof t.year === 'number' && t.year > 0 ? cleanYear(t.year) : null;
    const seconds = typeof t.duration === 'number' && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : null;
    const added = typeof t.dateAdded === 'string' && !Number.isNaN(Date.parse(t.dateAdded)) ? t.dateAdded : undefined;

    const rec: ImportRecord = {
      sourceTitle: title,
      sourceYear: year,
      sourceDirector: cleanText(t.director),
      sourceGenre: cleanText(t.genre),
      sourceRuntimeMin: seconds === null ? null : Math.round(seconds / 60),
      applePersistentId: cleanText(t.persistentID),
      source: 'apple-tv',
    };
    const playedAt = typeof t.playedDate === 'string' && !Number.isNaN(Date.parse(t.playedDate)) ? t.playedDate : null;
    if (typeof t.playedCount === 'number' && t.playedCount > 0 && playedAt && WATCHED_AT_RE.test(playedAt)) {
      rec.status = 'watched';
      rec.watchedAt = playedAt;
    }
    if (added) rec.addedAt = added;
    records.push(rec);
  }
  return records;
}

/** The default runner: `osascript -l JavaScript -e <script>`, killed when `signal` aborts. */
export const osascriptRunner: AppleTvRunner = (script, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { maxBuffer: 256 * 1024 * 1024, signal: opts?.signal, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });

function explain(err: unknown): ImportError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/-1743|not authori[sz]ed/i.test(msg)) {
    return new ImportError(
      `macOS blocked access to the TV app. Allow your terminal under System Settings > Privacy & Security > Automation, then try again. ${PASTE_HINT}`,
    );
  }
  if (/ENOENT/.test(msg)) return new ImportError(`osascript was not found. ${PASTE_HINT}`);
  return new ImportError(`Reading the TV app failed: ${msg}. ${PASTE_HINT}`);
}

/**
 * Read the movies in the TV app's library (macOS only). Rejects with an
 * ImportError when the platform is not macOS, when the TV app does not answer
 * within `timeoutMs`, or when osascript fails.
 */
export async function readAppleTvLibrary(
  opts: { timeoutMs?: number; runner?: AppleTvRunner; platform?: NodeJS.Platform } = {},
): Promise<ImportRecord[]> {
  if ((opts.platform ?? process.platform) !== 'darwin') {
    throw new ImportError('Apple TV import is only available on macOS');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPLE_TV_TIMEOUT_MS;
  const runner = opts.runner ?? osascriptRunner;
  const script = readFileSync(APPLE_TV_SCRIPT_PATH, 'utf8');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ImportError(`The TV app did not answer within ${Math.round(timeoutMs / 1000)}s. ${PASTE_HINT}`));
    }, timeoutMs);
  });

  let stdout: string;
  try {
    stdout = await Promise.race([
      runner(script, { signal: controller.signal }).catch((err: unknown) => {
        if (controller.signal.aborted) return new Promise<never>(() => {}); // the timeout already rejected
        throw explain(err);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return parseAppleTvJxaOutput(stdout);
}
