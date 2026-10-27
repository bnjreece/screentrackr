/**
 * `screentrackr import trakt` end to end: spawns the built CLI against temp
 * homes (no catalog, so nothing is matched and nothing touches the network).
 * Every title and username in the fixtures is invented.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportFiles, makeZip, toBytes } from './fixtures/trakt-export.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

let tmp: string;
let home: string;
let n = 0;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-trakt-cli-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  home = join(tmp, `home-${++n}`);
});

function run(args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, SCREENTRACKR_HOME: join(tmp, 'never-used-home'), TZ: 'UTC' };
  const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function zip(files: Record<string, unknown>): string {
  const path = join(tmp, `trakt-export-${++n}.zip`);
  writeFileSync(path, makeZip(toBytes(files)));
  return path;
}

describe('import trakt', () => {
  it('imports the export ZIP and reports what it skipped; a second run changes nothing', () => {
    const path = zip(exportFiles());
    const r = run(['import', 'trakt', path, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ format: 'trakt', records: 6, added: 6, skippedTv: 2, skippedFiles: 4, exportErrors: 0, bulkDated: 0 });
    expect(r.stderr).toMatch(/4 other files/);
    expect(r.stderr + r.stdout).not.toMatch(/example\.invalid|mira-calloway/);
    const again = JSON.parse(run(['import', 'trakt', path, '--json']).stdout) as Record<string, unknown>;
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 6 });

    const exported = JSON.parse(run(['export']).stdout) as { items: { sourceTitle: string; owned: boolean; source: string; externalIds?: { trakt?: string } }[] };
    const lantern = exported.items.find((i) => i.sourceTitle === 'Lantern Road');
    expect(lantern).toMatchObject({ owned: true, source: 'trakt', externalIds: { trakt: '104' } });
    expect(exported.items.filter((i) => i.owned)).toHaveLength(1);
  });

  it('reads an unpacked folder too, and prints a readable summary', () => {
    const dir = join(tmp, `folder-${++n}`);
    mkdirSync(dir);
    for (const [name, data] of Object.entries(toBytes(exportFiles()))) writeFileSync(join(dir, name), data);
    const r = run(['import', 'trakt', dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Imported 6 records \(trakt\)/);
    expect(r.stderr).toMatch(/Skipped 2 TV rows/);
  });

  it('warns about a partial export and refuses --replace for it', () => {
    const files = { ...exportFiles(), '_errors.json': [{ endpoint: 'users/orrin-vale/watchlist', error: 'HTTP 429', fetchedPages: 1, totalPages: 4 }] };
    const path = zip(files);
    const replace = run(['import', 'trakt', path, '--replace']);
    expect(replace.code).toBe(1);
    expect(replace.stderr).toMatch(/incomplete \(watchlist\)/);
    const merge = run(['import', 'trakt', path, '--json']);
    expect(merge.code, merge.stderr).toBe(0);
    expect(merge.stderr).toMatch(/watchlist is incomplete/);
    expect(merge.stderr).not.toMatch(/orrin-vale/);
    expect(JSON.parse(merge.stdout)).toMatchObject({ exportErrors: 1, incomplete: ['watchlist'] });
  });

  it('refuses --replace for a damaged page, for single files and for a plain import of one page; allows it for a whole export', () => {
    const damaged = run(['import', 'trakt', zip({ ...exportFiles(), 'watched-history-2.json': '[{' }), '--replace']);
    expect(damaged.code).toBe(1);
    expect(damaged.stderr).toMatch(/incomplete \(watch history\)/);
    const dir = join(tmp, `pages-${++n}`);
    mkdirSync(dir);
    const page = join(dir, 'watched-history.json');
    writeFileSync(page, '[]');
    const single = run(['import', 'trakt', page, '--replace']);
    expect(single.code).toBe(1);
    expect(single.stderr).toMatch(/Nothing to import|not the whole export/);
    writeFileSync(page, toBytes(exportFiles())['watched-history.json'] as Buffer);
    expect(run(['import', 'trakt', page, '--replace']).stderr).toMatch(/not the whole export/);
    const plain = run(['import', page, '--format', 'trakt', '--replace']);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toMatch(/not the whole export/);
    const whole = run(['import', 'trakt', zip(exportFiles()), '--replace', '--json']);
    expect(whole.code, whole.stderr).toBe(0);
    expect(JSON.parse(whole.stdout)).toMatchObject({ added: 6 });
  });

  it('refuses a ZIP with nothing it reads, flags for other importers, and --keep-bulk-dates elsewhere', () => {
    const empty = run(['import', 'trakt', zip({ 'user-settings.json': {} })]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toMatch(/no Trakt export files/i);
    expect(run(['import', 'trakt']).code).toBe(1);
    expect(run(['import', 'trakt', zip(exportFiles()), '--as', 'watchlist']).stderr).toMatch(/only apply to IMDb/);
    expect(run(['import', 'trakt', zip(exportFiles()), '--format', 'csv']).stderr).toMatch(/--format does not apply/);
    expect(run(['import', 'imdb', 'x.csv', '--keep-bulk-dates']).stderr).toMatch(/only applies to `import trakt`/);
  });

  it('a plain import detects a single Trakt page', () => {
    const dir = join(tmp, `page-${++n}`);
    mkdirSync(dir);
    const path = join(dir, 'ratings-movies.json');
    writeFileSync(path, toBytes(exportFiles())['ratings-movies.json'] as Buffer);
    const renamed = join(dir, 'my-ratings.json');
    writeFileSync(renamed, toBytes(exportFiles())['ratings-movies.json'] as Buffer);
    expect(run(['import', renamed]).stderr).toMatch(/under their export names/);
    const r = run(['import', path, '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ format: 'trakt', added: 2 });
  });
});
