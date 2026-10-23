import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_TV_SCRIPT_PATH,
  parseAppleTvJxaOutput,
  readAppleTvLibrary,
} from '../src/core/importers/apple-tv.js';
import { ImportError } from '../src/core/importers/common.js';

// Synthetic sample of what the JXA script prints: made-up titles and ids.
const SAMPLE = JSON.stringify([
  {
    name: 'Night Ferry',
    year: 2014,
    director: 'Dana Fincher',
    genre: 'Thriller',
    duration: 6750.4,
    playedCount: 2,
    playedDate: '2023-07-08T20:00:00.000Z',
    persistentID: 'A1B2C3D4E5F60718',
    dateAdded: '2021-03-04T05:06:07.000Z',
    mediaKind: 'movie',
  },
  {
    name: '  Paper Lanterns ',
    year: 0,
    director: '',
    genre: '',
    duration: 5400,
    playedCount: 0,
    playedDate: null,
    persistentID: '0000AAAA1111BBBB',
    dateAdded: null,
    mediaKind: 'home video',
  },
  {
    name: 'Harbor Lights S1E1',
    year: 2019,
    director: '',
    genre: 'Drama',
    duration: 1800,
    playedCount: 1,
    persistentID: 'FFFF0000FFFF0000',
    dateAdded: '2020-01-01T00:00:00.000Z',
    mediaKind: 'TV show',
  },
]);

describe('parseAppleTvJxaOutput', () => {
  it('maps duration in seconds to whole minutes and a dated play to watched', () => {
    const recs = parseAppleTvJxaOutput(SAMPLE);
    expect(recs).toHaveLength(2);
    const [ferry, lanterns] = recs;
    expect(ferry).toMatchObject({
      sourceTitle: 'Night Ferry',
      sourceYear: 2014,
      sourceDirector: 'Dana Fincher',
      sourceGenre: 'Thriller',
      sourceRuntimeMin: 113,
      status: 'watched',
      watchedAt: '2023-07-08T20:00:00.000Z',
      addedAt: '2021-03-04T05:06:07.000Z',
    });
    expect(lanterns).toMatchObject({
      sourceTitle: 'Paper Lanterns',
      sourceYear: null,
      sourceDirector: null,
      sourceGenre: null,
      sourceRuntimeMin: 90,
    });
    // Unplayed: no status at all, so a merge keeps the existing one.
    expect(lanterns).not.toHaveProperty('status');
    expect(lanterns?.addedAt).toBeUndefined();
  });

  it('a play count with no played date is not proof of watching, so no status is set', () => {
    // Seen on a real cloud library: playedCount is 1 on nearly every track and
    // playedDate is missing everywhere. Trusting the count alone would flip a
    // whole queue to watched on merge.
    const recs = parseAppleTvJxaOutput(
      JSON.stringify([
        { name: 'Quiet Orbit', playedCount: 1, playedDate: null, mediaKind: 'movie' },
        { name: 'Glass Meadow', playedCount: 3, mediaKind: 'movie' },
        { name: 'Copper Tide', playedCount: 1, playedDate: 'not a date', mediaKind: 'movie' },
      ]),
    );
    expect(recs).toHaveLength(3);
    for (const r of recs) {
      expect(r).not.toHaveProperty('status');
      expect(r).not.toHaveProperty('watchedAt');
    }
  });

  it('sets source apple-tv and the persistent id', () => {
    for (const r of parseAppleTvJxaOutput(SAMPLE)) {
      expect(r.source).toBe('apple-tv');
      expect(r.applePersistentId).toMatch(/^[0-9A-F]{16}$/);
    }
    expect(parseAppleTvJxaOutput(SAMPLE)[0]?.applePersistentId).toBe('A1B2C3D4E5F60718');
  });

  it('rejects output that is not a JSON array', () => {
    expect(() => parseAppleTvJxaOutput('not json')).toThrow(ImportError);
    expect(() => parseAppleTvJxaOutput('{"a":1}')).toThrow(ImportError);
  });

  it('skips tracks with no name', () => {
    const recs = parseAppleTvJxaOutput(JSON.stringify([{ name: '', mediaKind: 'movie' }, { name: 'Quiet Orbit' }]));
    expect(recs.map((r) => r.sourceTitle)).toEqual(['Quiet Orbit']);
  });
});

describe('readAppleTvLibrary', () => {
  it('runs the JXA script through the runner and parses its output', async () => {
    let seen = '';
    const recs = await readAppleTvLibrary({
      platform: 'darwin',
      runner: async (script) => {
        seen = script;
        return SAMPLE;
      },
    });
    expect(recs).toHaveLength(2);
    expect(seen).toContain("Application('TV')");
    expect(seen).toBe(readFileSync(APPLE_TV_SCRIPT_PATH, 'utf8'));
  });

  it('rejects after timeoutMs when the TV app never answers, suggesting the paste import', async () => {
    const started = Date.now();
    const err = await readAppleTvLibrary({
      platform: 'darwin',
      timeoutMs: 50,
      runner: () => new Promise<string>(() => {}),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toMatch(/did not answer/i);
    expect((err as Error).message).toMatch(/paste/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('passes an abort signal that fires on timeout so the child can be killed', async () => {
    let signal: AbortSignal | undefined;
    await readAppleTvLibrary({
      platform: 'darwin',
      timeoutMs: 20,
      runner: (_script, opts) => {
        signal = opts?.signal;
        return new Promise<string>(() => {});
      },
    }).catch(() => undefined);
    expect(signal?.aborted).toBe(true);
  });

  it('wraps a runner failure in a helpful ImportError', async () => {
    const err = await readAppleTvLibrary({
      platform: 'darwin',
      runner: async () => {
        throw new Error('execution error: Not authorized to send Apple events to TV. (-1743)');
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toMatch(/Automation/);
  });

  it('throws on a non-macOS platform without running anything', async () => {
    let ran = false;
    await expect(
      readAppleTvLibrary({
        platform: 'linux',
        runner: async () => {
          ran = true;
          return '[]';
        },
      }),
    ).rejects.toThrow('Apple TV import is only available on macOS');
    expect(ran).toBe(false);
  });

  it('the script reads tracks in bulk and keeps only movies', () => {
    const script = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'importers', 'apple-tv.jxa.js'), 'utf8');
    for (const prop of ['name', 'year', 'director', 'genre', 'duration', 'playedCount', 'playedDate', 'persistentID', 'dateAdded', 'mediaKind']) {
      expect(script).toContain(`.${prop}()`);
    }
    expect(script).toContain("'home video'");
    expect(script).toContain('JSON.stringify');
  });
});
