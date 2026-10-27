/**
 * `screentrackr export --format letterboxd|trakt`: spawns the built CLI
 * against a temp home seeded straight through the core (no catalog needed).
 * All titles and ids are made up.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { addToList, createList } from '../src/core/lists.js';
import { addViewing } from '../src/core/viewings.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

let tmp: string;
let home: string;
let n = 0;

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, SCREENTRACKR_HOME: join(tmp, 'never-used-home') };
  const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-export-cli-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(): void {
  const db = openDb(home);
  try {
    const ins = db.sql.prepare('INSERT INTO library_items (source_title, source_year, tconst, match_status, source, status, my_rating) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const a = Number(ins.run('The Glass Harbor', 1978, 'tt9000001', 'matched', 'paste', 'watched', 8).lastInsertRowid);
    ins.run('Night, Again', 1999, null, 'unmatched', 'paste', 'queue', null);
    ins.run('Nameless Someday', null, null, 'unmatched', 'paste', 'someday', null);
    db.sql.prepare("INSERT INTO item_external_ids (item_id, kind, value) VALUES (?, 'trakt', '9007199254740993')").run(a);
    addViewing(db, a, { watchedAt: '2020-05-01', source: 'letterboxd', rewatch: false, rating: 7, sourceRef: 'https://boxd.it/e1' });
    addViewing(db, a, { watchedAt: '2023-10-31', source: 'manual' });
    addViewing(db, a, { watchedAt: null, source: 'trakt', sourceRef: '77' });
    createList(db, 'Halloween');
    addToList(db, 'Halloween', [a]);
    createList(db, 'Empty');
  } finally {
    db.close();
  }
}

beforeEach(() => {
  home = join(tmp, `home-${++n}`);
  seed();
});

describe('export --format letterboxd', () => {
  it('writes owner-only split-named files and says where to upload them', () => {
    const dir = join(tmp, `lb-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(dir)).toEqual(['letterboxd-watched-1.csv']);
    const f = join(dir, 'letterboxd-watched-1.csv');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, 'utf8')).toBe(
      'imdbID,Title,Year,Directors,LetterboxdURI,WatchedDate,Rewatch,Rating10,Tags\n' +
        'tt9000001,The Glass Harbor,1978,,,2020-05-01,false,7,\n' +
        'tt9000001,The Glass Harbor,1978,,,2023-10-31,true,8,\n',
    );
    expect(r.stdout).toContain('letterboxd.com/import/');
    expect(r.stdout).toMatch(/never uploads/);
  });

  it('--json reports files and rows', () => {
    const dir = join(tmp, `lbj-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir, '--what', 'watchlist', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { format: string; what: string; rows: number; files: { path: string; rows: number }[] };
    expect(j).toMatchObject({ format: 'letterboxd', what: 'watchlist', rows: 2 });
    expect(j.files).toEqual([{ path: join(dir, 'letterboxd-watchlist-1.csv'), rows: 2, bytes: expect.any(Number) }]);
  });

  it('--list exports one list by name, case-insensitively; a missing list is an error', () => {
    const dir = join(tmp, `lbl-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir, '--what', 'list', '--list', 'halloween']);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'letterboxd-list-1.csv'), 'utf8')).toBe('imdbID,Title,Year,Directors,LetterboxdURI\ntt9000001,The Glass Harbor,1978,,\n');
    expect(r.stdout).toContain('letterboxd.com/list/new/');
    const bad = run(['export', '--format', 'letterboxd', '--out-dir', dir, '--what', 'list', '--list', 'Nope']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Nope/);
  });

  it('an empty selection writes nothing, says so and exits 0', () => {
    const dir = join(tmp, `lbe-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir, '--what', 'list', '--list', 'Empty']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Nothing to export/);
    expect(existsSync(dir)).toBe(false);
  });

  it('--lists-as-tags says tags only attach to diary rows', () => {
    const dir = join(tmp, `lbt-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir, '--lists-as-tags']);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'letterboxd-watched-1.csv'), 'utf8')).toContain(',Halloween\n');
    expect(r.stdout).toMatch(/Tags.*dated/);
  });

  it('warns about an older numbered file the new export did not replace', () => {
    const dir = join(tmp, `lbs-${n}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'letterboxd-watched-2.csv'), 'old');
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/letterboxd-watched-2\.csv.*earlier export/);
    expect(readFileSync(join(dir, 'letterboxd-watched-2.csv'), 'utf8')).toBe('old');
  });

  it('an existing file of the same name is replaced owner-only', () => {
    const dir = join(tmp, `lbp-${n}`);
    mkdirSync(dir);
    const f = join(dir, 'letterboxd-watched-1.csv');
    writeFileSync(f, 'old');
    chmodSync(f, 0o644);
    expect(run(['export', '--format', 'letterboxd', '--out-dir', dir]).code).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['letterboxd-watched-1.csv']);
  });

  it('names a movie whose title Letterboxd quoting cannot hold, and leaves it out', () => {
    const db = openDb(home);
    const id = Number(db.sql.prepare("INSERT INTO library_items (source_title, match_status, source, status) VALUES (?, 'unmatched', 'paste', 'watched')").run('Ends, in a slash\\').lastInsertRowid);
    db.close();
    const dir = join(tmp, `lbu-${n}`);
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Left out item ${id}:`);
    expect(readFileSync(join(dir, 'letterboxd-watched-1.csv'), 'utf8')).not.toContain('slash');
  });

  it('a failed rename in a split export says which files were already replaced', () => {
    const db = openDb(home);
    const ins = db.sql.prepare("INSERT INTO library_items (source_title, match_status, source, status) VALUES (?, 'unmatched', 'paste', 'watched')");
    db.sql.exec('BEGIN');
    for (let i = 0; i < 6000; i++) ins.run(`Generated ${i} ${'x'.repeat(200)}`);
    db.sql.exec('COMMIT');
    db.close();
    const dir = join(tmp, `lbf-${n}`);
    // A directory where the second file goes makes its rename fail.
    mkdirSync(join(dir, 'letterboxd-watched-2.csv'), { recursive: true });
    const r = run(['export', '--format', 'letterboxd', '--out-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Could not write .*letterboxd-watched-2\.csv/);
    expect(r.stderr).toMatch(/Already replaced: letterboxd-watched-1\.csv/);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses options that do not fit the format', () => {
    expect(run(['export', '--format', 'letterboxd']).stderr).toMatch(/--out-dir/);
    expect(run(['export', '--format', 'letterboxd', '--out', 'x.csv']).stderr).toMatch(/--out-dir/);
    expect(run(['export', '--format', 'letterboxd', '--out-dir', tmp, '--what', 'ratings']).stderr).toMatch(/--what/);
    expect(run(['export', '--format', 'letterboxd', '--out-dir', tmp, '--what', 'list']).stderr).toMatch(/--list/);
    expect(run(['export', '--format', 'letterboxd', '--out-dir', tmp, '--what', 'watchlist', '--lists-as-tags']).stderr).toMatch(/--lists-as-tags/);
    expect(run(['export', '--format', 'letterboxd', '--out-dir', tmp, '--what', 'watched', '--list', 'Halloween']).stderr).toMatch(/--list/);
    expect(run(['export', '--format', 'nope']).stderr).toMatch(/--format/);
  });
});

describe('export --format trakt', () => {
  it('writes one owner-only CSV with every action and reports dateless plays', () => {
    const out = join(tmp, `trakt-${n}.csv`);
    const r = run(['export', '--format', 'trakt', '--out', out]);
    expect(r.code, r.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8').startsWith(
      'type,action,title,year,imdb,trakt,watched_at,rating,rated_at,listed_at\n' +
        'movie,history,The Glass Harbor,1978,tt9000001,9007199254740993,2020-05-01,,,\n' +
        'movie,history,The Glass Harbor,1978,tt9000001,9007199254740993,2023-10-31,,,\n' +
        'movie,history,The Glass Harbor,1978,tt9000001,9007199254740993,unknown,,,\n',
    )).toBe(true);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines[4]).toMatch(/^movie,ratings,The Glass Harbor,1978,tt9000001,9007199254740993,,8,\d{4}-/);
    expect(lines[5]).toMatch(/^movie,watchlist,"Night, Again",1999,,,,,,\d{4}-/);
    expect(lines).toHaveLength(6);
    expect(r.stdout).toMatch(/1 movie with no id and no year/);
    expect(r.stdout).toMatch(/unknown/);
    expect(r.stdout).toMatch(/never uploads/);
  });

  it('--what limits the rows; --json reports counts', () => {
    const out = join(tmp, `trakt-r-${n}.csv`);
    const r = run(['export', '--format', 'trakt', '--out', out, '--what', 'ratings', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ format: 'trakt', what: 'ratings', path: out, rows: { history: 0, ratings: 1, watchlist: 0 }, skipped: 0 });
  });

  it('refuses options that do not fit the format, and an empty selection writes nothing', () => {
    expect(run(['export', '--format', 'trakt']).stderr).toMatch(/--out/);
    expect(run(['export', '--format', 'trakt', '--out-dir', tmp]).stderr).toMatch(/--out-dir/);
    expect(run(['export', '--format', 'trakt', '--out', 'x.csv', '--list', 'Halloween']).stderr).toMatch(/--list/);
    expect(run(['export', '--format', 'trakt', '--out', 'x.csv', '--what', 'watched']).stderr).toMatch(/--what/);
    const db = openDb(home);
    db.sql.exec('DELETE FROM library_items');
    db.close();
    const out = join(tmp, `trakt-e-${n}.csv`);
    const r = run(['export', '--format', 'trakt', '--out', out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Nothing to export/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('export json-v1 stays the default', () => {
  it('refuses the CSV-only options', () => {
    expect(run(['export', '--what', 'watched']).stderr).toMatch(/--what/);
    expect(run(['export', '--format', 'json-v1', '--out-dir', tmp]).stderr).toMatch(/--out-dir/);
    expect(JSON.parse(run(['export', '--format', 'json-v1']).stdout)).toMatchObject({ format: 'screentrackr-library' });
  });
});
