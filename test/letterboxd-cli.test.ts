/**
 * End-to-end tests of `screentrackr import letterboxd` against the built CLI
 * and a temp home seeded from the synthetic catalog fixtures (no network).
 * The export fixtures are invented.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { folderFiles } from './fixtures/folder-files.js';
import { makeZip } from './fixtures/make-zip.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const EXPORT = join(import.meta.dirname, 'fixtures', 'letterboxd', 'export');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let tmp: string;
let template: string;
let home: string;
let zip: string;
let n = 0;

function run(args: string[]): Run {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, SCREENTRACKR_HOME: join(tmp, 'never-used-home') };
  const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', input: '', timeout: 60_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const json = <T>(r: Run): T => JSON.parse(r.stdout) as T;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-lbcli-'));
  template = join(tmp, 'template');
  mkdirSync(join(template, 'cache'), { recursive: true });
  cpSync(IMDB, join(template, 'cache'), { recursive: true });
  home = template;
  expect(run(['setup']).code).toBe(0);
  zip = join(tmp, 'letterboxd-example-2026-01-01-00-00-utc.zip');
  writeFileSync(zip, makeZip(folderFiles(EXPORT, 'letterboxd-example-2026-01-01-00-00-utc/')));
}, 120_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  home = join(tmp, `home-${++n}`);
  cpSync(template, home, { recursive: true });
});

interface Summary {
  format: string;
  records: number;
  added: number;
  updated: number;
  unchanged: number;
  needsReview: number;
}

describe('import letterboxd', () => {
  it('reads a ZIP, and a repeat changes nothing', () => {
    const r = run(['import', 'letterboxd', zip, '--owned-list', 'my-blu-rays', '--with-reviews', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(json<Summary>(r)).toMatchObject({ format: 'letterboxd', records: 13, added: 13 });
    expect(r.stderr).toMatch(/Skipped 3 diary entries for films Letterboxd no longer lists/);
    const again = run(['import', 'letterboxd', zip, '--owned-list', 'my-blu-rays', '--with-reviews', '--json']);
    expect(json<Summary>(again)).toMatchObject({ added: 0, updated: 0, unchanged: 13 });
    const db = openDb(home);
    try {
      const owned = db.sql.prepare('SELECT source_title AS t FROM library_items WHERE owned = 1 ORDER BY t').all() as { t: string }[];
      expect(owned.map((o) => o.t)).toEqual(['Night Ferry', 'The Glass Harbor']);
    } finally {
      db.close();
    }
  }, 60_000);

  it('reads the export folder and loose files, and detects them with plain import', () => {
    const folder = run(['import', EXPORT, '--no-watchlist', '--json']);
    expect(folder.code, folder.stderr).toBe(0);
    expect(json<Summary>(folder)).toMatchObject({ format: 'letterboxd', records: 10 });
    const plainZip = run(['import', zip, '--json']);
    expect(json<Summary>(plainZip)).toMatchObject({ format: 'letterboxd', records: 12, added: 2 });
    const files = run(['import', 'letterboxd', join(EXPORT, 'watched.csv'), join(EXPORT, 'ratings.csv'), '--json']);
    expect(json<Summary>(files)).toMatchObject({ format: 'letterboxd', records: 10, added: 0 });
    const one = run(['import', join(EXPORT, 'watchlist.csv'), '--json']);
    expect(json<Summary>(one)).toMatchObject({ format: 'letterboxd', records: 3 });
  }, 60_000);

  it('opens only the loose files it reads: a glob over the export never opens profile, comments, likes, unnamed lists or deleted/ and orphaned/', () => {
    const copy = join(tmp, `glob-${n}`);
    cpSync(EXPORT, copy, { recursive: true });
    // Unreadable: opening any of these would fail the import.
    const closed = ['profile.csv', 'comments.csv', 'reviews.csv', 'likes/films.csv', 'lists/favourites.csv', 'lists/old-shelf.csv', 'deleted/diary.csv', 'orphaned/diary.csv'];
    for (const f of closed) chmodSync(join(copy, f), 0o000);
    try {
      const all = ['watched.csv', 'ratings.csv', 'diary.csv', 'watchlist.csv', 'lists/my-blu-rays.csv', ...closed].map((f) => join(copy, f));
      const r = run(['import', 'letterboxd', ...all, '--owned-list', 'my-blu-rays', '--owned-list', 'profile', '--owned-list', 'comments', '--dry-run', '--json']);
      expect(r.code, r.stderr).toBe(1); // lists/profile.csv is not in the export
      expect(r.stderr).toMatch(/pass its file/);
      const ok = run(['import', 'letterboxd', ...all, '--owned-list', 'my-blu-rays', '--json']);
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stderr).toMatch(/deleted\/ are never imported/);
      expect(ok.stderr).toMatch(/profile\.csv: not a file this import reads/);
      const db = openDb(home);
      try {
        const ferry = db.sql.prepare("SELECT status, watched_at AS w FROM library_items WHERE source_title = 'Night Ferry'").get() as { status: string; w: string | null };
        expect(ferry).toMatchObject({ w: null });
        expect(ferry.status).not.toBe('watched');
      } finally {
        db.close();
      }
      const deleted = run(['import', 'letterboxd', join(copy, 'deleted', 'diary.csv')]);
      expect(deleted.code).toBe(1);
    } finally {
      for (const f of closed) chmodSync(join(copy, f), 0o644);
    }
  }, 60_000);

  it('never empties the library from an export with nothing in it under --replace', () => {
    run(['import', zip]);
    const empty = join(tmp, `empty-${n}`);
    mkdirSync(empty);
    writeFileSync(join(empty, 'watched.csv'), 'Date,Name,Year,Letterboxd URI\n');
    const r = run(['import', 'letterboxd', empty, '--replace']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing was changed/);
    expect((JSON.parse(run(['export']).stdout) as { items: unknown[] }).items).toHaveLength(12);
  }, 60_000);

  it('rejects flags and inputs that do not apply', () => {
    for (const args of [
      ['import', 'letterboxd'],
      ['import', 'letterboxd', zip, '--format', 'csv'],
      ['import', 'letterboxd', zip, '--as', 'watchlist'],
      ['import', 'letterboxd', zip, '--owned-list', 'no-such-list'],
      ['import', 'letterboxd', zip, '--owned-list', '../profile'],
      ['import', 'letterboxd', zip, EXPORT],
      ['import', 'letterboxd', join(EXPORT, 'watched.csv'), '--owned-list', 'my-blu-rays'],
      ['import', 'letterboxd', join(tmp, 'missing.zip')],
      ['import', 'letterboxd', IMDB],
      ['import', 'imdb', join(EXPORT, 'watched.csv'), '--with-reviews'],
      ['import', join(EXPORT, 'profile.csv'), '--owned-list', 'x'],
    ]) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
    }
  }, 60_000);
});
