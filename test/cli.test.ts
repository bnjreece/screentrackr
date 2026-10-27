/* eslint-disable no-control-regex */
/**
 * End-to-end CLI tests: each spawns the built `node dist/cli/index.js` against
 * a temp home. A template home is seeded once by running the real `setup`
 * over the synthetic fixture datasets (copied into cache/, so nothing touches
 * the network), then copied fresh for each test.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { table } from '../src/cli/format.js';
import { openDb } from '../src/core/db.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const PASTE = join(import.meta.dirname, 'fixtures', 'import', 'apple-paste.txt');
const CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';
const ANSI = new RegExp(String.fromCharCode(27) + "\\[");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { home?: string; env?: Record<string, string | undefined>; input?: string } = {}): Run {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...opts.env };
  // Never let a test fall back to the real ~/.screentrackr.
  if (!('SCREENTRACKR_HOME' in (opts.env ?? {}))) env.SCREENTRACKR_HOME = join(tmp, 'never-used-home');
  const res = spawnSync(process.execPath, [CLI, ...(opts.home ? ['--home', opts.home] : []), ...args], {
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: opts.input ?? '',
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json<T = Record<string, unknown>>(r: Run): T {
  expect(r.stderr, 'stderr').not.toMatch(/Error:.*\n\s+at /);
  return JSON.parse(r.stdout) as T;
}

let tmp: string;
let template: string;
let setupRun: Run;
let home: string;
let n = 0;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-cli-'));
  template = join(tmp, 'template');
  mkdirSync(join(template, 'cache'), { recursive: true });
  cpSync(IMDB, join(template, 'cache'), { recursive: true });
  setupRun = run(['setup'], { home: template });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  home = join(tmp, `home-${++n}`);
  cpSync(template, home, { recursive: true });
});

function importPaste(): Run {
  const r = run(['import', PASTE], { home });
  expect(r.code, r.stderr).toBe(0);
  return r;
}

function itemIds(title: string): number[] {
  const db = openDb(home);
  try {
    return (db.sql.prepare('SELECT id FROM library_items WHERE source_title = ? ORDER BY id').all(title) as { id: number }[]).map(
      (r) => r.id,
    );
  } finally {
    db.close();
  }
}

describe('global flags', () => {
  it('--version prints the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('--help lists the commands and exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['setup', 'import', 'search', 'show', 'add', 'remove', 'set', 'match', 'link', 'stats', 'export', 'doctor']) {
      expect(r.stdout).toContain(c);
    }
    expect(r.stdout).not.toContain('—');
  });

  it('search --help shows the search flags', () => {
    const r = run(['search', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--director');
    expect(r.stdout).toContain('--not-in-library');
  });

  it('an unknown command or flag is a user error (exit 1)', () => {
    expect(run(['frobnicate'], { home }).code).toBe(1);
    const r = run(['search', '--bogus'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/bogus/);
  });

  it('SCREENTRACKR_HOME is honored when --home is absent', () => {
    const r = run(['doctor', '--json'], { env: { SCREENTRACKR_HOME: home } });
    expect(r.code).toBe(0);
    expect(json<{ home: string }>(r).home).toBe(home);
  });

  it('an unexpected error exits 2', () => {
    const broken = join(tmp, 'broken-home');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'screentrackr.db'), 'this is not a sqlite database, just text padding '.repeat(20));
    const r = run(['doctor'], { home: broken });
    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

describe('setup', () => {
  it('builds the catalog from the cache, logs progress to stderr and prints the credit line', () => {
    expect(setupRun.code, setupRun.stderr).toBe(0);
    expect(setupRun.stdout).toContain(CREDIT);
    expect(setupRun.stderr).toMatch(/title\.basics/);
    // Progress belongs on stderr, not mixed into stdout.
    expect(setupRun.stdout).not.toMatch(/Loading title\./);
  });

  it('--json prints the catalog stats and the credit', () => {
    const r = run(['setup', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const out = json<{ catalog: { movies: number }; credit: string }>(r);
    expect(out.catalog.movies).toBe(30);
    expect(out.credit).toBe(CREDIT);
  });
});

describe('search', () => {
  it('search --director fincher --min-rating 7.5 --json prints total and results', () => {
    importPaste();
    const r = run(['search', '--director', 'fincher', '--min-rating', '7.5', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const out = json<{ total: number; results: { tconst: string }[] }>(r);
    expect(out.total).toBe(2);
    expect(out.results.map((x) => x.tconst).sort()).toEqual(['tt9000003', 'tt9000004']);
  });

  it('maps repeatable and range flags onto the filter', () => {
    const r = run(
      ['search', '--scope', 'all', '--director', 'fincher', '--director', 'villeneuve', '--genre', 'thriller', '--min-rating', '7.5', '--max-runtime', '120', '--json'],
      { home },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(json<{ results: { tconst: string }[] }>(r).results.map((x) => x.tconst).sort()).toEqual(['tt9000004', 'tt9000018']);

    const years = run(['search', '--scope', 'all', '--year', '2010-2016', '--sort', 'year', '--order', 'asc', '--json'], { home });
    const ys = json<{ results: { year: number }[] }>(years).results.map((x) => x.year);
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every((y) => y >= 2010 && y <= 2016)).toBe(true);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);

    const single = run(['search', '--scope', 'all', '--year', '2016', '--json'], { home });
    expect(json<{ results: { year: number }[] }>(single).results.map((x) => x.year)).toEqual([2016]);

    const both = run(['search', '--scope', 'all', '--genre', 'crime', '--genre', 'drama', '--all-genres', '--json', '--limit', '200'], { home });
    const bothOut = json<{ results: { genres: string[] }[] }>(both);
    expect(bothOut.results.length).toBeGreaterThan(0);
    for (const x of bothOut.results) expect(x.genres).toEqual(expect.arrayContaining(['Crime', 'Drama']));
  });

  it('--unwatched and --not-in-library narrow the results', () => {
    importPaste();
    run(['set', 'Quiet Ledger', '--status', 'watched'], { home });
    const unwatched = json<{ results: { tconst: string }[] }>(run(['search', '--director', 'fincher', '--unwatched', '--json'], { home }));
    expect(unwatched.results.map((x) => x.tconst)).toEqual(['tt9000004']);

    const notOwned = json<{ results: { tconst: string; library: unknown }[] }>(
      run(['search', '--scope', 'all', '--director', 'fincher', '--not-in-library', '--json', '--limit', '50'], { home }),
    );
    const ts = notOwned.results.map((x) => x.tconst);
    expect(ts).not.toContain('tt9000003');
    expect(ts).not.toContain('tt9000004');
    expect(ts).toContain('tt9000020');

    // The README's owner query, phrased as "haven't watched and don't own", is accepted as is.
    const r = run(['search', '--scope', 'all', '--director', 'fincher', '--not-in-library', '--unwatched', '--json', '--limit', '50'], { home });
    expect(r.code).toBe(0);
    expect(json<{ results: { tconst: string }[] }>(r).results.map((x) => x.tconst).sort()).toEqual([...ts].sort());
  });

  it('table output has a header row and no ANSI codes when not a TTY', () => {
    importPaste();
    const r = run(['search', '--director', 'fincher'], { home });
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/TITLE/);
    expect(lines[0]).toMatch(/YEAR/);
    expect(lines[0]).toMatch(/RATING/);
    expect(r.stdout).toContain('Quiet Ledger');
    expect(r.stdout).not.toMatch(ANSI);
  });

  it('a bad number or an invalid filter is a user error', () => {
    const r1 = run(['search', '--min-rating', 'high'], { home });
    expect(r1.code).toBe(1);
    expect(r1.stderr).toMatch(/--min-rating/);
    const r2 = run(['search', '--sort', 'bogus'], { home });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/sort/);
    const r3 = run(['search', '--not-in-library'], { home });
    expect(r3.code).toBe(1);
    expect(r3.stderr).toMatch(/notInLibrary/);
  });

  it('search --scope all on an empty home exits 1 with the catalog message', () => {
    const empty = join(tmp, `empty-${n}`);
    const r = run(['search', '--scope', 'all'], { home: empty });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Catalog not built. Run `screentrackr setup`.');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('library search works before setup, from source fields', () => {
    const empty = join(tmp, `nocat-${n}`);
    expect(run(['import', PASTE], { home: empty }).code).toBe(0);
    const out = json<{ results: { title: string; library: { matchStatus: string } }[] }>(
      run(['search', '--director', 'fincher', '--json'], { home: empty }),
    );
    expect(out.results.length).toBe(2);
    expect(out.results.every((x) => x.library.matchStatus === 'unmatched')).toBe(true);
  });
});

describe('import', () => {
  it('prints an added/updated/unchanged/needs-review summary, and a second run is all unchanged', () => {
    const r = importPaste();
    expect(r.stdout).toMatch(/Added 6/);
    expect(r.stdout).toMatch(/updated 0/);
    expect(r.stdout).toMatch(/unchanged 0/);
    expect(r.stdout).toMatch(/needs review \d+/);

    const again = run(['import', PASTE, '--json'], { home });
    expect(again.code).toBe(0);
    expect(json<{ added: number; unchanged: number }>(again)).toMatchObject({ added: 0, unchanged: 6 });
  });

  it('lists a record that fits several items instead of guessing', () => {
    const file = join(tmp, `ambiguous-${n}.csv`);
    writeFileSync(file, 'title,year\nCopperline Avenue,1980\nCopperline Avenue,2020\n');
    expect(run(['import', file], { home }).code).toBe(0);
    const ids = itemIds('Copperline Avenue');
    writeFileSync(file, 'title,rating\nCopperline Avenue,3\n');
    const r = run(['import', file], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`record 1 "Copperline Avenue": items ${ids.join(', ')}`);
    const j = json<{ reviews: unknown[] }>(run(['import', file, '--json'], { home }));
    expect(j.reviews).toEqual([{ record: 1, sourceTitle: 'Copperline Avenue', candidateIds: ids }]);
  });

  it('--replace reports the backup path', () => {
    importPaste();
    const r = run(['import', PASTE, '--replace', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const out = json<{ backupPath: string }>(r);
    expect(existsSync(out.backupPath)).toBe(true);
  });

  it('a missing file or --merge with --replace is a user error', () => {
    expect(run(['import', join(tmp, 'nope.txt')], { home }).code).toBe(1);
    expect(run(['import', PASTE, '--merge', '--replace'], { home }).code).toBe(1);
    expect(run(['import'], { home }).code).toBe(1);
  });
});

describe('import imdb', () => {
  const EXPORTS = join(import.meta.dirname, 'fixtures', 'imdb-export');
  const RATINGS = join(EXPORTS, 'ratings.csv');
  const WATCHLIST = join(EXPORTS, 'watchlist.csv');

  it('reads several exports together, counts skipped title types, and a repeat changes nothing', () => {
    const r = run(['import', 'imdb', WATCHLIST, RATINGS, '--as', 'watchlist', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const out = json<{ format: string; added: number; skippedByType: Record<string, number> }>(r);
    expect(out).toMatchObject({ format: 'imdb', added: 7 });
    expect(out.skippedByType).toEqual({ 'TV Series': 1, 'TV Movie': 1, 'TV Episode': 1, Short: 1 });
    const again = json<{ added: number; updated: number; unchanged: number }>(
      run(['import', 'imdb', WATCHLIST, RATINGS, '--as', 'watchlist', '--json'], { home }),
    );
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 7 });
    const text = run(['import', 'imdb', RATINGS], { home });
    expect(text.stderr).toMatch(/Skipped 2 rows that are not a movie: TV Episode 1, Short 1/);
  }, 60_000);

  it('detects an IMDb export passed to plain import, and notes how a list file was read', () => {
    const r = run(['import', RATINGS, '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(json<{ format: string; added: number }>(r)).toMatchObject({ format: 'imdb', added: 5 });
    const list = run(['import', WATCHLIST], { home });
    expect(list.code, list.stderr).toBe(0);
    expect(list.stderr).toMatch(/read as your watchlist/);
  }, 60_000);

  it('never empties the library from a header-only export under --replace', () => {
    importPaste();
    const before = run(['export'], { home }).stdout;
    const r = run(['import', 'imdb', join(EXPORTS, 'ratings-empty.csv'), '--replace'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was changed/);
    expect(JSON.parse(run(['export'], { home }).stdout).items).toEqual(JSON.parse(before).items);
    expect(run(['import', 'imdb', join(EXPORTS, 'ratings-empty.csv'), '--json'], { home }).code).toBe(0);
  }, 60_000);

  it('--dry-run reports what an import would do and changes nothing', () => {
    importPaste();
    const before = run(['export'], { home }).stdout;
    const r = run(['import', 'imdb', RATINGS, '--dry-run', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(json<{ dryRun: boolean; added: number }>(r)).toMatchObject({ dryRun: true });
    const text = run(['import', 'imdb', RATINGS, '--replace', '--dry-run'], { home });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/Dry run: nothing was changed/);
    expect(text.stdout).toMatch(/Would add \d+/);
    expect(text.stdout).not.toMatch(/Backup of the previous library/);
    expect(JSON.parse(run(['export'], { home }).stdout).items).toEqual(JSON.parse(before).items);
  }, 60_000);

  it('rejects flags that do not apply', () => {
    for (const args of [
      ['import', PASTE, '--notes-from-description'],
      ['import', 'imdb'],
      ['import', 'imdb', RATINGS, '--format', 'csv'],
      ['import', 'imdb', WATCHLIST, '--as', 'favorites'],
      ['import', 'imdb', WATCHLIST, '--collection', 'Shelf'],
      ['import', 'imdb', WATCHLIST, '--as', 'watchlist', '--checkin-dates'],
      ['import', 'imdb', RATINGS, '--include-type', 'tvSeries'],
      ['import', PASTE, '--as', 'watchlist'],
      ['import', 'imdb', join(tmp, 'missing.csv')],
      ['import', 'imdb', PASTE],
    ]) {
      const r = run(args, { home });
      expect(r.code, args.join(' ')).toBe(1);
    }
  }, 60_000);
});

describe('import apple-tv', () => {
  it('rejects flags that do not apply, before touching the TV app', () => {
    for (const args of [
      ['import', 'apple-tv', '--format', 'csv'],
      ['import', 'apple-tv', '--timeout', '0'],
      ['import', 'apple-tv', '--timeout', 'soon'],
      ['import', PASTE, '--timeout', '5'],
    ]) {
      const r = run(args, { home });
      expect(r.code, args.join(' ')).toBe(1);
    }
  });

  it('the build ships the JXA script beside the importer', () => {
    expect(existsSync(join(ROOT, 'dist', 'core', 'importers', 'apple-tv.jxa.js'))).toBe(true);
  });

  it.runIf(process.platform !== 'darwin')('fails with a clear message off macOS', () => {
    const r = run(['import', 'apple-tv'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Apple TV import is only available on macOS');
  });

  it('import --help mentions apple-tv', () => {
    const r = run(['import', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('apple-tv');
    expect(r.stdout).not.toContain('\u2014');
  });
});

describe('show, set, add, remove, link', () => {
  it('set "<duplicated title>" --status watched exits 1 and lists both candidate ids', () => {
    importPaste();
    const ids = itemIds('The Glass Harbor');
    expect(ids).toHaveLength(2);
    const r = run(['set', 'The Glass Harbor', '--status', 'watched'], { home });
    expect(r.code).toBe(1);
    for (const id of ids) expect(r.stderr).toContain(String(id));

    const j = run(['set', 'The Glass Harbor', '--status', 'watched', '--json'], { home });
    expect(j.code).toBe(1);
    const err = json<{ error: { candidates: { id: number }[] } }>(j);
    expect(err.error.candidates.map((c) => c.id)).toEqual(ids);
    // Nothing was written.
    for (const id of ids) {
      expect(json<{ item: { status: string } }>(run(['show', String(id), '--json'], { home })).item.status).toBe('queue');
    }
  });

  it('set <id> --rating 8 then show <id> --json shows myRating 8', () => {
    importPaste();
    const [id] = itemIds('Quiet Ledger');
    const s = run(['set', String(id), '--rating', '8'], { home });
    expect(s.code, s.stderr).toBe(0);
    const out = json<{ item: { myRating: number }; movie: { tconst: string; directors: string[] } }>(
      run(['show', String(id), '--json'], { home }),
    );
    expect(out.item.myRating).toBe(8);
    expect(out.movie.tconst).toBe('tt9000003');
    expect(out.movie.directors).toEqual(['Dana Fincher']);

    expect(run(['set', String(id), '--clear-rating'], { home }).code).toBe(0);
    expect(json<{ item: { myRating: number | null } }>(run(['show', String(id), '--json'], { home })).item.myRating).toBeNull();
  });

  it('set validates its input', () => {
    importPaste();
    const [id] = itemIds('Quiet Ledger');
    expect(run(['set', String(id), '--rating', '11'], { home }).code).toBe(1);
    expect(run(['set', String(id), '--status', 'bogus'], { home }).code).toBe(1);
    expect(run(['set', String(id), '--rating', '8', '--clear-rating'], { home }).code).toBe(1);
    expect(run(['set', String(id)], { home }).code).toBe(1);
    expect(run(['set', '99999', '--status', 'watched'], { home }).code).toBe(1);
    const ok = run(['set', String(id), '--status', 'watched', '--era', '2010s', '--watched-at', '2016-05-01', '--json'], { home });
    expect(ok.code, ok.stderr).toBe(0);
    expect(json<{ status: string; watchedEra: string; watchedAt: string }>(ok)).toMatchObject({
      status: 'watched',
      watchedEra: '2010s',
      watchedAt: '2016-05-01',
    });
  });

  it('show works for a catalog tconst outside the library and as a table', () => {
    const r = run(['show', 'tt9000020', '--json'], { home });
    expect(r.code, r.stderr).toBe(0);
    const out = json<{ item: unknown; movie: { title: string; rating: number } }>(r);
    expect(out.item).toBeNull();
    expect(out.movie).toMatchObject({ title: 'A Room Downstairs', rating: 8.1 });

    const t = run(['show', 'tt9000020'], { home });
    expect(t.code).toBe(0);
    expect(t.stdout).toContain('A Room Downstairs');
    expect(run(['show', 'Nothing Like This'], { home }).code).toBe(1);
  });

  it('add by tconst, add by an ambiguous title, then remove', () => {
    const a = run(['add', 'tt9000020', '--status', 'priority', '--json'], { home });
    expect(a.code, a.stderr).toBe(0);
    const item = json<{ id: number; status: string; tconst: string }>(a);
    expect(item).toMatchObject({ status: 'priority', tconst: 'tt9000020' });

    const amb = run(['add', 'Seven Lanterns', '--json'], { home });
    expect(amb.code).toBe(1);
    const cands = json<{ error: { candidates: { tconst: string }[] } }>(amb).error.candidates.map((c) => c.tconst).sort();
    expect(cands).toEqual(['tt9000004', 'tt9000026']);

    const byYear = run(['add', 'Seven Lanterns', '--year', '2021', '--json'], { home });
    expect(byYear.code, byYear.stderr).toBe(0);
    expect(json<{ tconst: string }>(byYear).tconst).toBe('tt9000026');

    const rm = run(['remove', String(item.id)], { home });
    expect(rm.code, rm.stderr).toBe(0);
    expect(run(['show', String(item.id)], { home }).code).toBe(1);
    expect(run(['remove', String(item.id)], { home }).code).toBe(1);
    expect(run(['remove', 'Seven Lanterns'], { home }).code).toBe(1);
  });

  it('add refuses a movie already in the library unless --new-edition', () => {
    const first = run(['add', 'tt9000020', '--json'], { home });
    expect(first.code, first.stderr).toBe(0);
    const firstId = json<{ id: number }>(first).id;

    const again = run(['add', 'tt9000020', '--json'], { home });
    expect(again.code).toBe(1);
    expect(json<{ error: { candidates: { id: number }[] } }>(again).error.candidates.map((c) => c.id)).toEqual([firstId]);
    const text = run(['add', 'A Room Downstairs'], { home });
    expect(text.code).toBe(1);
    expect(text.stderr).toContain('--new-edition');
    expect(text.stderr).toContain(String(firstId));

    const edition = run(['add', 'tt9000020', '--new-edition', '--json'], { home });
    expect(edition.code, edition.stderr).toBe(0);
    expect(json<{ id: number }>(edition).id).not.toBe(firstId);
  });

  it('add needs a catalog', () => {
    const empty = join(tmp, `noadd-${n}`);
    const r = run(['add', 'tt9000020'], { home: empty });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Catalog not built');
  });
});

describe('an unverified IMDb hint is not an identity', () => {
  const HINTED = 'title,status,rating,imdb_id\nThe Glass Harbor (1978),watched,8,tt9000002\n';
  const item = (h: string) =>
    json<{ item: { id: number; status: string; myRating: number | null; matchStatus: string; tconst: string | null } }>(
      run(['show', 'The Glass Harbor (1978)', '--json'], { home: h }),
    ).item;

  it('before setup, a wrongly hinted item is not reachable by that tconst, only by id and title', () => {
    const bare = join(tmp, `hint-bare-${n}`);
    const file = join(tmp, `hint-${n}.csv`);
    writeFileSync(file, HINTED);
    const imp = run(['import', file], { home: bare });
    expect(imp.code, imp.stderr).toBe(0);
    expect(item(bare)).toMatchObject({ status: 'watched', myRating: 8, matchStatus: 'unmatched', tconst: 'tt9000002' });

    const set = run(['set', 'tt9000002', '--status', 'watched', '--rating', '2'], { home: bare });
    expect(set.code).toBe(1);
    expect(item(bare).myRating).toBe(8);
    expect(run(['show', 'tt9000002', '--json'], { home: bare }).code).toBe(1);

    // The item's own id and source title still reach it.
    const { id } = item(bare);
    expect(run(['set', String(id), '--rating', '9'], { home: bare }).code).toBe(0);
    expect(item(bare).myRating).toBe(9);
    expect(run(['set', 'The Glass Harbor (1978)', '--rating', '7'], { home: bare }).code).toBe(0);
    expect(item(bare).myRating).toBe(7);
    expect(run(['remove', String(id)], { home: bare }).code).toBe(0);
  });

  it('after setup, an unresolved item is not reached by its hinted tconst or that movie\'s catalog title', () => {
    const db = openDb(home);
    const id = Number(
      db.sql
        .prepare(
          "INSERT INTO library_items (tconst, source_title, status, my_rating, match_status, source) VALUES ('tt9000002', 'Glasshaven Quay', 'watched', 8, 'unmatched', 'csv')",
        )
        .run().lastInsertRowid,
    );
    db.close();
    const rating = () => json<{ item: { myRating: number } }>(run(['show', String(id), '--json'], { home })).item.myRating;

    expect(run(['set', 'tt9000002', '--rating', '2'], { home }).code).toBe(1);
    expect(run(['set', 'The Glass Harbor', '--rating', '2'], { home }).code).toBe(1);
    expect(rating()).toBe(8);
    // show by tconst shows the catalog movie, not the unresolved item.
    const byTconst = json<{ item: unknown; movie: { tconst: string } }>(run(['show', 'tt9000002', '--json'], { home }));
    expect(byTconst).toMatchObject({ item: null, movie: { tconst: 'tt9000002' } });
    // show by id does not present the unchecked hint's catalog record as the movie.
    expect(json<{ movie: unknown }>(run(['show', String(id), '--json'], { home })).movie).toBeNull();
    expect(run(['set', 'Glasshaven Quay', '--rating', '6'], { home }).code).toBe(0);
    expect(rating()).toBe(6);
  });
});

describe('match and link', () => {
  it('match --review lists unresolved items with their candidates; link resolves one', () => {
    const db = openDb(home);
    db.sql
      .prepare(
        "INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Seven Lanterns', 'queue', 'unmatched', 'manual')",
      )
      .run();
    db.close();

    const m = run(['match', '--json'], { home });
    expect(m.code, m.stderr).toBe(0);
    expect(json<{ ambiguous: number }>(m).ambiguous).toBe(1);

    const rev = run(['match', '--review', '--json'], { home });
    expect(rev.code, rev.stderr).toBe(0);
    const items = json<{ items: { id: number; matchStatus: string; candidates: { tconst: string; title: string; year: number; directors: string[]; votes: number | null }[] }[] }>(rev).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.matchStatus).toBe('ambiguous');
    expect(items[0]!.candidates.map((c) => c.tconst).sort()).toEqual(['tt9000004', 'tt9000026']);
    const c04 = items[0]!.candidates.find((c) => c.tconst === 'tt9000004')!;
    expect(c04).toMatchObject({ title: 'Seven Lanterns', year: 1995, directors: ['Dana Fincher'], votes: 750000 });

    const table = run(['match', '--review'], { home });
    expect(table.stdout).toContain('tt9000026');
    expect(table.stdout).not.toMatch(ANSI);

    const link = run(['link', String(items[0]!.id), 'tt9000026', '--json'], { home });
    expect(link.code, link.stderr).toBe(0);
    expect(json<{ matchStatus: string; tconst: string }>(link)).toMatchObject({ matchStatus: 'manual', tconst: 'tt9000026' });
    expect(json<{ items: unknown[] }>(run(['match', '--review', '--json'], { home })).items).toHaveLength(0);

    expect(run(['link', String(items[0]!.id), 'tt0000000'], { home }).code).toBe(1);
  });
});

describe('stats, export, doctor', () => {
  it('stats --json and the table', () => {
    importPaste();
    const s = json<{ total: number; byStatus: Record<string, number> }>(run(['stats', '--json'], { home }));
    expect(s.total).toBe(6);
    expect(s.byStatus.queue).toBe(6);
    const t = run(['stats'], { home });
    expect(t.code).toBe(0);
    expect(t.stdout).toMatch(/queue/);
  });

  it('export writes ScreenTrackr JSON v1 to stdout or --out', () => {
    importPaste();
    const r = run(['export'], { home });
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout) as { format: string; version: number; items: unknown[] };
    expect(data).toMatchObject({ format: 'screentrackr-library', version: 1 });
    expect(data.items).toHaveLength(6);

    const out = join(home, 'out.json');
    const w = run(['export', '--out', out], { home });
    expect(w.code, w.stderr).toBe(0);
    expect(w.stdout).toContain(out);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { items: unknown[] }).items).toHaveLength(6);
  });

  it('doctor --json reports catalogReady, fts, nodeVersion and libraryCount', () => {
    importPaste();
    const d = json<{ catalogReady: boolean; fts: boolean; nodeVersion: string; libraryCount: number; dbPath: string }>(
      run(['doctor', '--json'], { home }),
    );
    expect(d.catalogReady).toBe(true);
    expect(typeof d.fts).toBe('boolean');
    expect(d.nodeVersion).toBe(process.version);
    expect(d.libraryCount).toBe(6);
    expect(d.dbPath).toBe(join(home, 'screentrackr.db'));

    const empty = json<{ catalogReady: boolean; libraryCount: number }>(run(['doctor', '--json'], { home: join(tmp, `doc-${n}`) }));
    expect(empty).toMatchObject({ catalogReady: false, libraryCount: 0 });
    const t = run(['doctor'], { home });
    expect(t.code).toBe(0);
    expect(t.stdout).toMatch(/Node/);
  });
});

describe('table formatter', () => {
  const rows = [{ t: 'A Very Long Movie Title That Goes On', y: '1999', d: 'Somebody With A Long Name' }];
  const cols = [
    { header: 'TITLE', get: (r: (typeof rows)[number]) => r.t, flex: true, min: 8 },
    { header: 'YEAR', get: (r: (typeof rows)[number]) => r.y, align: 'right' as const },
    { header: 'DIRECTOR', get: (r: (typeof rows)[number]) => r.d, flex: true, min: 8 },
  ];

  it('fits flexible columns to the width with an ellipsis, keeping fixed columns whole', () => {
    const out = table(rows, cols, { width: 40 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
    expect(out).toContain('1999');
    expect(out).toContain('\u2026');
  });

  it('never truncates without a width, and styles headers only with color', () => {
    expect(table(rows, cols)).toContain('A Very Long Movie Title That Goes On');
    expect(table(rows, cols)).not.toMatch(ANSI);
    expect(table(rows, cols, { color: true })).toMatch(ANSI);
  });
});

describe('terminal safety', () => {
  it('strips escape sequences from imported titles in table output and errors', () => {
    const evil = join(tmp, `evil-${n}.txt`);
    const title = 'Spoof\u001b]0;owned\u0007\u001b[2J Title';
    writeFileSync(evil, `${title}\t\t1:40:00\tNobody Real\t\tDrama\t1\n`);
    expect(run(['import', evil], { home }).code).toBe(0);
    const listed = run(['search', '--text', 'Spoof'], { home });
    expect(listed.stdout).toContain('Spoof');
    expect(listed.stdout).not.toMatch(/[\u0007\u001b]/);
    const shown = run(['show', 'Spoof Title'], { home });
    expect(shown.stdout + shown.stderr).not.toMatch(/[\u0007\u001b]/);
  });
});

describe('mcp startup errors', () => {
  it('never write to stdout, even with --json', () => {
    const r = run(['mcp', '--json', 'extra'], { home });
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Error/);
    expect(r.code).not.toBe(0);
  });
});

describe('a year in a title reference on the command line', () => {
  const importCsv = (body: string) => {
    const file = join(tmp, `year-${n}.csv`);
    writeFileSync(file, body);
    const r = run(['import', file], { home });
    expect(r.code, r.stderr).toBe(0);
  };

  it('set with a conflicting title year never changes the only same-titled item', () => {
    importCsv('title,year,status\nThe Glass Harbor,1978,queue\n');
    const [id] = itemIds('The Glass Harbor') as [number];
    const status = () => json<{ item: { status: string } }>(run(['show', String(id), '--json'], { home })).item.status;
    for (const ref of ['The Glass Harbor (2009)', 'The Glass Harbor (2009) (4K)']) {
      const r = run(['set', ref, '--status', 'watched'], { home });
      expect(r.code, ref).toBe(1);
      expect(r.stderr).toContain('No library item matches');
      expect(run(['show', ref], { home }).code, ref).toBe(1);
    }
    expect(status()).toBe('queue');
    expect(run(['set', 'The Glass Harbor (1978) (4K)', '--status', 'watched'], { home }).code).toBe(0);
    expect(status()).toBe('watched');
  });

  it('add with a conflicting title year never adds the only same-titled catalog movie', () => {
    for (const ref of ['Night Ferry (2026)', 'Night Ferry (2026) (Special Edition)']) {
      const r = run(['add', ref], { home });
      expect(r.code, ref).toBe(1);
      expect(r.stderr).toContain('No catalog movie is titled');
    }
    expect(itemIds('Night Ferry')).toEqual([]);
    const ok = run(['add', 'Night Ferry (2002) (4K)', '--json'], { home });
    expect(ok.code, ok.stderr).toBe(0);
    expect(json<{ tconst: string }>(ok).tconst).toBe('tt9000010');
  });
});

describe('error output', () => {
  it('SCREENTRACKR_DEBUG stack output is sanitized for the terminal', () => {
    const evil = join(tmp, `evil-${n}\u001b]0;pwned\u0007\u202ehome`);
    writeFileSync(evil, 'not a directory');
    const r = run(['stats'], { home: join(evil, 'sub'), env: { SCREENTRACKR_DEBUG: '1' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unexpected error');
    expect(r.stderr).toMatch(/\n\s+at /);
    expect(r.stderr).not.toMatch(/[\u001b\u0007\u202e]/);
  });
});

describe('export --out file permissions', () => {
  it('an existing file ends up owner-only, with nothing left behind', () => {
    importPaste();
    const dir = join(tmp, `perm-${n}`);
    mkdirSync(dir);
    const out = join(dir, 'library.json');
    writeFileSync(out, 'old contents');
    chmodSync(out, 0o644);
    const r = run(['export', '--out', out], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { items: unknown[] }).items).toHaveLength(6);
    expect(readdirSync(dir)).toEqual(['library.json']);
    // A new file is owner-only too.
    const fresh = join(dir, 'fresh.json');
    expect(run(['export', '--out', fresh], { home }).code).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it('a failed write leaves the existing file and no temp file', () => {
    importPaste();
    const dir = join(tmp, `perm-dir-${n}`);
    mkdirSync(join(dir, 'library.json'), { recursive: true });
    const r = run(['export', '--out', join(dir, 'library.json')], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Could not write');
    expect(readdirSync(dir)).toEqual(['library.json']);
  });
});
