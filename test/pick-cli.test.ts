/**
 * End-to-end tests for Track D's commands: pick, where, config, the new
 * search flags and whereToWatch on show. Each spawns the built CLI against a
 * temp home seeded from the synthetic fixture catalog; nothing touches the
 * network, and `where --open` runs a fake opener from PATH.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { addFromCatalog } from '../src/core/library.js';
import { addToList, createList } from '../src/core/lists.js';
import { pickMovies } from '../src/core/pick.js';
import { addViewing } from '../src/core/viewings.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A US locale unless a test says otherwise, so the default country is predictable. */
const LOCALE = { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: undefined, LANG: 'en_US.UTF-8' };

function run(args: string[], opts: { env?: Record<string, string | undefined> } = {}): Run {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...LOCALE, ...opts.env };
  env.SCREENTRACKR_HOME = join(tmp, 'never-used-home');
  const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', input: '', timeout: 60_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json<T = Record<string, unknown>>(r: Run): T {
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
}

let tmp: string;
let template: string;
let home: string;
let n = 0;
let ids: Record<string, number>;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-pick-cli-'));
  template = join(tmp, 'template');
  mkdirSync(join(template, 'cache'), { recursive: true });
  cpSync(IMDB, join(template, 'cache'), { recursive: true });
  home = template;
  const r = run(['setup']);
  expect(r.code, r.stderr).toBe(0);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  home = join(tmp, `home-${++n}`);
  cpSync(template, home, { recursive: true });
  const db = openDb(home);
  try {
    ids = {
      w03: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
      q04: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
      p20: addFromCatalog(db, 'tt9000020', { status: 'priority' }).id,
      q07: addFromCatalog(db, 'tt9000007', { status: 'queue' }).id,
      q09: addFromCatalog(db, 'tt9000009', { status: 'queue', owned: false }).id,
      q05: addFromCatalog(db, 'tt9000005', { status: 'queue' }).id,
      s11: addFromCatalog(db, 'tt9000011', { status: 'someday' }).id,
    };
  } finally {
    db.close();
  }
});

interface PickOut {
  total: number;
  picks: { tconst: string | null; title: string; whereToWatch: string; library: { id: number; status: string } | null }[];
  priorityOnly?: boolean;
  matched?: number;
}

describe('pick', () => {
  it('picks one unwatched library movie, with a where-to-watch link and "picked from"', () => {
    const r = run(['pick', '--seed', '3']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Picked from 6 movies\./);
    expect(r.stdout).toMatch(/Where to watch:\n {2}.+ {2}https:\/\/www\.justwatch\.com\/us\/search\?q=/);
    const out = json<PickOut>(run(['pick', '--seed', '3', '--json']));
    expect(out.total).toBe(6);
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0]!.library!.status).not.toBe('watched');
    expect(out.picks[0]!.whereToWatch).toMatch(/^https:\/\/www\.justwatch\.com\/us\/search\?q=/);
  });

  it('gives the same picks as the core (and so as MCP) for the same seed', () => {
    const cli = json<PickOut>(run(['pick', '--seed', '99', '-n', '4', '--genre', 'Drama', '--json']));
    const db = openDb(home);
    try {
      const core = pickMovies(db, { seed: 99, count: 4, genres: ['Drama'] });
      expect(cli).toEqual(JSON.parse(JSON.stringify(core)));
    } finally {
      db.close();
    }
  });

  it('takes the search filters: --owned, --decade, --max-runtime, --list, --never-seen', () => {
    const owned = json<PickOut>(run(['pick', '--not-owned', '-n', '10', '--json']));
    expect(owned.picks.map((p) => p.tconst)).toEqual(['tt9000009']);
    const decade = json<PickOut>(run(['pick', '--decade', '1980s', '--decade', '1990s', '-n', '10', '--json']));
    expect(decade.picks.map((p) => p.tconst).sort()).toEqual(['tt9000004', 'tt9000011']);
    const db = openDb(home);
    try {
      createList(db, 'Halloween');
      addToList(db, 'Halloween', [ids.q07!, ids.w03!]);
      addViewing(db, ids.q05!, { watchedAt: '2025-03-01', source: 'manual', sourceRef: 'manual:00000000000000aa' });
    } finally {
      db.close();
    }
    expect(json<PickOut>(run(['pick', '--list', 'halloween', '-n', '10', '--json'])).picks.map((p) => p.tconst)).toEqual(['tt9000007']);
    const never = json<PickOut>(run(['pick', '--never-seen', '-n', '10', '--json'])).picks.map((p) => p.tconst);
    expect(never).not.toContain('tt9000005');
    expect(never).toHaveLength(5);
  });

  it('--any-status includes watched movies, and --priority-first prefers priority', () => {
    const all = json<PickOut>(run(['pick', '--any-status', '-n', '10', '--json']));
    expect(all.total).toBe(7);
    const prio = json<PickOut>(run(['pick', '--priority-first', '-n', '3', '--seed', '1', '--json']));
    expect(prio).toMatchObject({ total: 1, priorityOnly: true, matched: 6 });
    expect(prio.picks.map((p) => p.tconst)).toEqual(['tt9000020']);
    expect(run(['pick', '--priority-first', '--seed', '1']).stdout).toMatch(/Picked from 1 priority movie \(6 match in all\)\./);
  });

  it('--scope all picks catalog movies you have not watched', () => {
    const r = json<PickOut>(run(['pick', '--scope', 'all', '--min-rating', '8.5', '-n', '10', '--json']));
    // tt9000003 (8.6) is watched; tt9000024 (8.5) is not in the library.
    expect(r.picks.map((p) => p.tconst)).toEqual(['tt9000024']);
    expect(r.picks[0]!.library).toBeNull();
  });

  it('says so when nothing fits, exit 0, with total 0 and no picks', () => {
    const r = run(['pick', '--genre', 'Western']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('No movie fits these filters.');
    expect(json(run(['pick', '--genre', 'Western', '--json']))).toEqual({ total: 0, picks: [] });
  });

  it('refuses a bad count, a bad seed, sort flags and stray arguments', () => {
    for (const args of [
      ['pick', '-n', '0'],
      ['pick', '-n', '11'],
      ['pick', '--seed', 'x'],
      ['pick', '--seed', '-1'],
      ['pick', '--any-status', '--status', 'queue'],
      ['pick', 'Night Ferry'],
      ['pick', '--list', 'Nope'],
      ['pick', '--owned', '--not-owned'],
    ]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/^Error: /);
    }
    expect(run(['pick', '--sort', 'rating']).code).toBe(1);
  });

  it('uses the saved country for its links', () => {
    expect(run(['config', 'set', 'country', 'de']).code).toBe(0);
    const out = json<PickOut>(run(['pick', '--seed', '1', '--json']));
    expect(out.picks[0]!.whereToWatch).toMatch(/^https:\/\/www\.justwatch\.com\/de\/search\?q=/);
  });
});

describe('search: the 0.4.0 flags', () => {
  interface SearchOut {
    total: number;
    results: { tconst: string | null }[];
  }
  const tconsts = (r: Run) => json<SearchOut>(r).results.map((x) => x.tconst).sort();

  it('maps --owned, --not-owned, --decade, --list, --all-lists, --never-seen, --exclude-watched and --max-votes', () => {
    expect(tconsts(run(['search', '--not-owned', '--json']))).toEqual(['tt9000009']);
    expect(tconsts(run(['search', '--owned', '--decade', '1990s', '--json']))).toEqual(['tt9000003', 'tt9000004']);
    const db = openDb(home);
    try {
      createList(db, 'A');
      createList(db, 'B');
      addToList(db, 'A', [ids.q07!, ids.w03!]);
      addToList(db, 'B', [ids.q07!]);
      addViewing(db, ids.q05!, { watchedAt: '2025-03-01', source: 'manual', sourceRef: 'manual:00000000000000bb' });
    } finally {
      db.close();
    }
    expect(tconsts(run(['search', '--list', 'A', '--list', 'B', '--json']))).toEqual(['tt9000003', 'tt9000007']);
    expect(tconsts(run(['search', '--list', 'A', '--list', 'B', '--all-lists', '--json']))).toEqual(['tt9000007']);
    expect(tconsts(run(['search', '--never-seen', '--json']))).not.toContain('tt9000005');
    const ex = tconsts(run(['search', '--scope', 'all', '--exclude-watched', '--min-votes', '0', '--json']));
    expect(ex).not.toContain('tt9000003');
    expect(ex).not.toContain('tt9000005');
    // An owned movie you have not watched stays (unlike --not-in-library).
    expect(ex).toContain('tt9000004');
    expect(tconsts(run(['search', '--scope', 'all', '--min-votes', '1000', '--max-votes', '3200', '--json']))).toEqual(['tt9000011', 'tt9000013', 'tt9000023']);
  });

  it('runs the README discovery recipes', () => {
    const horror = run(['search', '--scope', 'all', '--genre', 'Horror', '--decade', '1970s', '--decade', '1980s', '--min-rating', '7.3', '--min-votes', '25000', '--exclude-watched', '--sort', 'votes', '--json']);
    expect(horror.code, horror.stderr).toBe(0);
    const gems = json<SearchOut>(run(['search', '--scope', 'all', '--min-rating', '7.0', '--min-votes', '2000', '--max-votes', '50000', '--exclude-watched', '--json']));
    expect(gems.results.map((r) => r.tconst).sort()).toEqual(['tt9000001', 'tt9000005', 'tt9000011', 'tt9000022', 'tt9000027']);
  });

  it('refuses contradictions with a message', () => {
    for (const args of [
      ['search', '--owned', '--not-owned'],
      ['search', '--all-lists'],
      ['search', '--decade', '1985s'],
      ['search', '--decade', '1870s'],
      ['search', '--max-votes', 'x'],
      ['search', '--scope', 'all', '--not-in-library', '--owned'],
      ['search', '--never-seen', '--status', 'watched'],
      ['search', '--list', 'Missing'],
    ]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/^Error: /);
    }
  });
});

describe('where', () => {
  interface WhereOut {
    title: string;
    country: string;
    url: string;
    countryFrom: string;
    tconst: string | null;
    itemId: number | null;
    opened?: boolean;
  }

  it('prints the JustWatch link for a library movie by id, title or tconst', () => {
    const r = run(['where', String(ids.p20)]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('A Room Downstairs on JustWatch (us):\nhttps://www.justwatch.com/us/search?q=A%20Room%20Downstairs\n');
    expect(json<WhereOut>(run(['where', 'Salt & Signal', '--json']))).toMatchObject({
      title: 'Salt & Signal',
      url: 'https://www.justwatch.com/us/search?q=Salt%20%26%20Signal',
      tconst: 'tt9000005',
      itemId: ids.q05,
      countryFrom: 'locale',
    });
    // A catalog movie you don't have.
    expect(json<WhereOut>(run(['where', 'tt9000024', '--json']))).toMatchObject({ title: 'The Slow Planet', itemId: null, tconst: 'tt9000024' });
  });

  it('treats editions of one film as one movie, but refuses different movies with one title', () => {
    const db = openDb(home);
    try {
      addFromCatalog(db, 'tt9000004', { status: 'watched' });
      addFromCatalog(db, 'tt9000001', { status: 'queue' });
      addFromCatalog(db, 'tt9000002', { status: 'queue' });
    } finally {
      db.close();
    }
    expect(json<WhereOut>(run(['where', 'tt9000004', '--json']))).toMatchObject({ title: 'Seven Lanterns', itemId: null });
    const amb = run(['where', 'The Glass Harbor']);
    expect(amb.code).toBe(1);
    expect(amb.stderr).toMatch(/matches 2 library items/);
  });

  it('uses --country, then config, then the locale, then us', () => {
    expect(json<WhereOut>(run(['where', String(ids.p20), '--country', 'GB', '--json']))).toMatchObject({ country: 'uk', countryFrom: 'flag' });
    expect(json<WhereOut>(run(['where', String(ids.p20), '--json'], { env: { LC_ALL: 'de_DE.UTF-8' } }))).toMatchObject({ country: 'de', countryFrom: 'locale' });
    expect(run(['config', 'set', 'country', 'fr']).code).toBe(0);
    expect(json<WhereOut>(run(['where', String(ids.p20), '--json'], { env: { LC_ALL: 'de_DE.UTF-8' } }))).toMatchObject({ country: 'fr', countryFrom: 'config' });
    const bad = run(['where', String(ids.p20), '--country', 'usa']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/two letters/);
  });

  it('falls back to the locale with a warning when config.json is broken', () => {
    writeFileSync(join(home, 'config.json'), '{broken');
    const r = run(['where', String(ids.p20)]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('/us/search?q=');
    expect(r.stderr).toMatch(/Warning: .*not valid JSON/);
  });

  it('refuses no ref and an unknown movie', () => {
    expect(run(['where']).code).toBe(1);
    const r = run(['where', 'No Such Film']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No library item or catalog movie matches/);
  });

  it('--open hands the link to the opener as one argument (fake opener on PATH)', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const bin = join(tmp, `bin-${n}`);
    mkdirSync(bin);
    const record = join(tmp, `opened-${n}.txt`);
    const opener = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
    writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$#" "$@" > '${record}'\n`);
    chmodSync(opener, 0o755);
    const r = run(['where', 'Salt & Signal', '--open', '--json'], { env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ opened: true });
    for (let i = 0; i < 100 && !existsSync(record); i++) spawnSync('sleep', ['0.05']);
    for (let i = 0; i < 100 && statSync(record).size === 0; i++) spawnSync('sleep', ['0.05']);
    expect(readFileSync(record, 'utf8')).toBe('1\nhttps://www.justwatch.com/us/search?q=Salt%20%26%20Signal\n');
  });
});

describe('config', () => {
  it('sets, gets and unsets country, lowercased, in an owner-only file', () => {
    expect(run(['config', 'get', 'country']).stdout.trim()).toBe('country is not set');
    const set = run(['config', 'set', 'country', 'GB']);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout.trim()).toBe("country = gb (JustWatch's path for it is uk)");
    expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ version: 1, country: 'gb' });
    expect(json(run(['config', 'get', 'country', '--json']))).toEqual({ key: 'country', value: 'gb' });
    expect(run(['config', 'get']).stdout.trim()).toBe('country = gb');
    expect(json(run(['config', 'unset', 'country', '--json']))).toEqual({ key: 'country', value: null, removed: true });
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ version: 1 });
    expect(run(['config', 'unset', 'country']).stdout.trim()).toBe('country was not set');
  });

  it('keeps saved sync sources when country changes', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, sync: { sources: [{ kind: 'apple-tv', timeoutSec: 60 }] } }));
    expect(run(['config', 'set', 'country', 'de']).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ version: 1, country: 'de', sync: { sources: [{ kind: 'apple-tv', timeoutSec: 60 }] } });
  });

  it('refuses unknown keys, bad values, missing parts and extra arguments, writing nothing', () => {
    for (const args of [
      ['config'],
      ['config', 'frob', 'country'],
      ['config', 'get', 'token'],
      ['config', 'set', 'country'],
      ['config', 'set', 'country', 'usa'],
      ['config', 'set', 'country', 'u1'],
      ['config', 'set', 'country', 'de', 'extra'],
      ['config', 'set', 'token', 'abc'],
    ]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/^Error: /);
    }
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('refuses to rewrite a broken config.json', () => {
    writeFileSync(join(home, 'config.json'), '{broken');
    const r = run(['config', 'set', 'country', 'de']);
    expect(r.code).toBe(1);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{broken');
  });
});

describe('show: whereToWatch', () => {
  it('includes the link for a library movie and for a catalog movie', () => {
    const s = json<{ whereToWatch: string }>(run(['show', String(ids.p20), '--json']));
    expect(s.whereToWatch).toBe('https://www.justwatch.com/us/search?q=A%20Room%20Downstairs');
    expect(run(['show', String(ids.p20)]).stdout).toMatch(/Where to watch +https:\/\/www\.justwatch\.com\/us\/search\?q=A%20Room%20Downstairs/);
    const c = json<{ whereToWatch: string; item: null }>(run(['show', 'tt9000024', '--json']));
    expect(c.item).toBeNull();
    expect(c.whereToWatch).toBe('https://www.justwatch.com/us/search?q=The%20Slow%20Planet');
  });

  it('uses the source title for an unmatched item, without edition tags', () => {
    const db = openDb(home);
    let id: number;
    try {
      id = Number(
        db.sql
          .prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Basement Tapes (Director''s Cut) (2001)', 'queue', 'unmatched', 'paste')")
          .run().lastInsertRowid,
      );
    } finally {
      db.close();
    }
    expect(json<{ whereToWatch: string }>(run(['show', String(id), '--json'])).whereToWatch).toBe('https://www.justwatch.com/us/search?q=Basement%20Tapes');
  });
});
