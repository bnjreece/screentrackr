/**
 * End-to-end CLI tests for `stats --watched`, `lists` and `list`. Each spawns
 * the built CLI against a fresh copy of a template home seeded by the real
 * `setup` over the synthetic fixture datasets. All titles are made up.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { addViewing } from '../src/core/viewings.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const PASTE = join(import.meta.dirname, 'fixtures', 'import', 'apple-paste.txt');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let tmp: string;
let template: string;
let home: string;
let n = 0;

function run(args: string[], h: string = home): Run {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, SCREENTRACKR_HOME: join(tmp, 'never-used-home') };
  const res = spawnSync(process.execPath, [CLI, '--home', h, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', input: '', timeout: 60_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json<T = Record<string, unknown>>(r: Run): T {
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
}

function ids(title: string): number[] {
  const db = openDb(home);
  try {
    return (db.sql.prepare('SELECT id FROM library_items WHERE trim(source_title) = ? ORDER BY id').all(title) as { id: number }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-stats-lists-cli-'));
  template = join(tmp, 'template');
  mkdirSync(join(template, 'cache'), { recursive: true });
  cpSync(IMDB, join(template, 'cache'), { recursive: true });
  expect(run(['setup'], template).code).toBe(0);
  expect(run(['import', PASTE], template).code).toBe(0);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  home = join(tmp, `home-${++n}`);
  cpSync(template, home, { recursive: true });
});

describe('stats', () => {
  it('plain stats adds a watching block, and nothing yet with no plays', () => {
    const t = run(['stats']);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toMatch(/^Watching\s+nothing yet$/m);
    const s = json<{ total: number; playsThisYear: number; rated: number; watching: { year: number } }>(run(['stats', '--json']));
    expect(s).toMatchObject({ total: 6, playsThisYear: 0, rated: 0, watching: { year: new Date().getFullYear() } });
  });

  it('stats --watched reports plays and films, collapsing a night from two sources', () => {
    const [q] = ids('Quiet Ledger');
    const [d] = ids('Dune Static');
    const db = openDb(home);
    try {
      addViewing(db, q as number, { watchedAt: '2024-05-01', source: 'letterboxd', sourceRef: 'https://boxd.it/a1' });
      addViewing(db, q as number, { watchedAt: '2024-05-01T20:00:00Z', source: 'trakt', sourceRef: '1' });
      addViewing(db, q as number, { watchedAt: '2025-01-03', source: 'manual', sourceRef: 'manual:00000000000000aa' });
      addViewing(db, d as number, { watchedAt: null, source: 'trakt', sourceRef: '2' });
      db.sql.prepare('UPDATE library_items SET my_rating = 9 WHERE id = ?').run(q as number);
    } finally {
      db.close();
    }
    const s = json<{ plays: number; films: number; rewatches: number; undatedFilms: number; byYear: unknown[] }>(run(['stats', '--watched', '--json']));
    expect(s).toMatchObject({ plays: 3, films: 2, rewatches: 1, undatedFilms: 1 });
    expect(s.byYear).toEqual([
      { year: 2025, plays: 1, films: 1, rewatches: 1 },
      { year: 2024, plays: 1, films: 1, rewatches: 0 },
    ]);
    const t = run(['stats', '--watched']);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toMatch(/^Watched, all time$/m);
    expect(t.stdout).toMatch(/^Plays\s+3, 1 rewatch$/m);
    expect(t.stdout).toMatch(/^ 9 {2}█+ 1$/m);
    const y = json<{ year: number; plays: number }>(run(['stats', '--year', '2024', '--json']));
    expect(y).toMatchObject({ year: 2024, plays: 1 });
    const by = run(['stats', '--by', 'year']);
    expect(by.stdout).toMatch(/^By year watched$/m);
    expect(by.stdout).not.toMatch(/Top genres/);
  });

  it('stats --watched with nothing watched says so', () => {
    const t = run(['stats', '--watched']);
    expect(t.code).toBe(0);
    expect(t.stdout.trim()).toBe('Watched, all time: nothing yet.');
  });

  it('refuses bad flags', () => {
    expect(run(['stats', '--by', 'month']).stderr).toMatch(/--by expects one of/);
    expect(run(['stats', '--year', 'soon']).stderr).toMatch(/--year expects a number/);
    expect(run(['stats', '--all-lists']).stderr).toMatch(/needs at least one --list/);
    expect(run(['stats', '--list', 'Nope']).stderr).toMatch(/No list named "Nope"/);
  });
});

describe('lists and list', () => {
  it('creates, fills, shows, renames and deletes a list', () => {
    expect(run(['lists']).stdout).toMatch(/No lists yet/);
    const c = json<{ name: string; description: string }>(run(['list', 'create', 'Halloween', '--description', 'October', '--json']));
    expect(c).toMatchObject({ name: 'Halloween', description: 'October' });
    expect(run(['list', 'create', 'halloween']).stderr).toMatch(/already exists/);

    const [q] = ids('Quiet Ledger');
    const add = json<{ added: number[]; list: { count: number } }>(run(['list', 'add', 'halloween', String(q), 'Basement Tapes', '--json']));
    expect(add.added).toHaveLength(2);
    expect(add.list.count).toBe(2);
    expect(run(['list', 'add', 'Halloween', String(q)]).stdout).toMatch(/Added 0 movies.*\nAlready in it: /);

    const lists = run(['lists']);
    expect(lists.stdout).toMatch(/^LIST\s+MOVIES\s+DESCRIPTION$/m);
    expect(lists.stdout).toMatch(/^Halloween\s+2\s+October$/m);

    const show = json<{ list: { name: string }; total: number; results: { title: string }[] }>(run(['list', 'show', 'Halloween', '--json']));
    expect(show.total).toBe(2);
    const filtered = json<{ total: number }>(run(['list', 'show', 'Halloween', '--genre', 'Horror', '--json']));
    expect(filtered.total).toBe(1);
    expect(run(['list', 'show', 'Halloween']).stdout).toMatch(/^Halloween: 2 movies\. October$/m);

    const rem = json<{ removed: number[]; list: { count: number } }>(run(['list', 'remove', 'Halloween', String(q), '--json']));
    expect(rem).toMatchObject({ removed: [q], list: { count: 1 } });

    expect(run(['list', 'create', 'Spooky']).code).toBe(0);
    expect(run(['list', 'rename', 'Halloween', 'SPOOKY']).stderr).toMatch(/already exists/);
    const ren = json<{ name: string; previousName: string }>(run(['list', 'rename', 'Halloween', 'Spooky season', '--json']));
    expect(ren).toMatchObject({ name: 'Spooky season', previousName: 'Halloween' });

    const del = run(['list', 'delete', 'spooky season']);
    expect(del.code, del.stderr).toBe(0);
    expect(del.stdout).toMatch(/1 movie was in it; the movies stay in your library/);
    expect(ids('Basement Tapes')).toHaveLength(1);
  });

  it('an ambiguous title adds nothing and lists the ids; --add-missing adds a not-owned queue item', () => {
    run(['list', 'create', 'Harbor']);
    const r = run(['list', 'add', 'Harbor', 'Quiet Ledger', 'The Glass Harbor']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was added to "Harbor"/);
    expect(r.stderr).toMatch(/"The Glass Harbor" matches 2 library items/);
    expect(json<{ lists: { count: number }[] }>(run(['lists', '--json'])).lists[0]?.count).toBe(0);

    const err = run(['list', 'add', 'Harbor', 'tt9000030', '--json']);
    expect(err.code).toBe(1);
    expect(JSON.parse(err.stdout)).toMatchObject({ error: { problems: [{ ref: 'tt9000030', reason: 'not-in-library' }] } });
    expect(err.stderr).toMatch(/--add-missing/);

    const ok = json<{ created: { id: number; status: string; owned: boolean }[]; added: number[] }>(
      run(['list', 'add', 'Harbor', 'tt9000030', '--add-missing', '--json']),
    );
    expect(ok.created).toEqual([expect.objectContaining({ status: 'queue', owned: false })]);
    expect(ok.added).toEqual([ok.created[0]?.id]);
  });

  it('refuses flags and arguments that do not fit', () => {
    expect(run(['list']).code).toBe(1);
    expect(run(['list', 'frobnicate', 'x']).stderr).toMatch(/Unknown list command "frobnicate"/);
    expect(run(['list', 'create', 'Two', 'Words']).stderr).toMatch(/takes one list name/);
    expect(run(['list', 'create', 'A', '--genre', 'Drama']).stderr).toMatch(/--genre does not apply to `list create`/);
    expect(run(['list', 'show', 'Nope']).stderr).toMatch(/No list named "Nope"/);
    expect(run(['list', 'add', 'Nope', '1']).stderr).toMatch(/No list named "Nope"/);
    expect(run(['lists', 'extra']).code).toBe(1);
  });

  it('stats --watched --list narrows to the list', () => {
    const [q] = ids('Quiet Ledger');
    const [b] = ids('Basement Tapes');
    const db = openDb(home);
    try {
      addViewing(db, q as number, { watchedAt: '2024-05-01', source: 'manual', sourceRef: 'manual:00000000000000bb' });
      addViewing(db, b as number, { watchedAt: '2024-10-31', source: 'manual', sourceRef: 'manual:00000000000000cc' });
    } finally {
      db.close();
    }
    run(['list', 'create', 'Halloween']);
    run(['list', 'add', 'Halloween', String(b)]);
    expect(json<{ plays: number; films: number; lists: string[] }>(run(['stats', '--list', 'Halloween', '--json']))).toMatchObject({ plays: 1, films: 1, lists: ['Halloween'] });
    expect(run(['stats', '--list', 'Halloween']).stdout).toMatch(/^Watched, all time, in the list "Halloween"$/m);
  });
});
