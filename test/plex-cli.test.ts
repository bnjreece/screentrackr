/**
 * `screentrackr import plex` end to end, through the built CLI. Nothing here
 * reaches a server: the listing comes from --from-file, and every server case
 * fails on purpose before a request is made. Titles and tokens are invented.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');
const TOKEN = 'fake-token-Zq81xP';

let tmp: string;
let n = 0;
let dump: string;

function run(args: string[], env: Record<string, string | undefined> = {}, input = '') {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, PLEX_TOKEN: undefined, SCREENTRACKR_HOME: join(tmp, 'never-used-home'), ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input,
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const freshHome = () => join(tmp, `home-${n++}`);
const count = (home: string) => {
  const db = openDb(home);
  try {
    return (db.sql.prepare('SELECT COUNT(*) AS n FROM library_items').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-plex-cli-'));
  dump = join(tmp, 'plex-movies.json');
  writeFileSync(
    dump,
    JSON.stringify({
      MediaContainer: {
        size: 2,
        totalSize: 2,
        offset: 0,
        librarySectionID: 3,
        Metadata: [
          {
            ratingKey: '5012',
            type: 'movie',
            guid: 'plex://movie/5d77aaaa0000000000000001',
            title: 'The Glass Harbor',
            year: 2009,
            duration: 7680000,
            userRating: 7,
            viewCount: 1,
            lastViewedAt: 1718020800,
            Guid: [{ id: 'imdb://tt9000002' }],
            Director: [{ tag: 'Teodor Brask' }],
          },
          { ratingKey: '5013', type: 'movie', guid: 'local://5013', title: 'Lantern Season', year: 1978, duration: 5400000 },
        ],
      },
    }),
  );
  writeFileSync(
    join(tmp, 'unreadable.json'),
    JSON.stringify({
      MediaContainer: {
        size: 2,
        totalSize: 2,
        librarySectionID: 3,
        Metadata: [
          { ratingKey: '5013', type: 'movie', title: 'Lantern Season', year: 1978 },
          { ratingKey: '5014', type: 'movie' },
        ],
      },
    }),
  );
  writeFileSync(join(tmp, 'empty.json'), JSON.stringify({ MediaContainer: { size: 0, totalSize: 0, Metadata: [] } }));
  writeFileSync(
    join(tmp, 'partial.json'),
    JSON.stringify({ MediaContainer: { size: 1, totalSize: 500, Metadata: [{ ratingKey: '1', type: 'movie', title: 'Lantern Season', year: 1978 }] } }),
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('import plex', () => {
  it('imports a saved listing: owned, watched, rated, and the unwatched one as someday', () => {
    const home = freshHome();
    const r = run(['--home', home, 'import', 'plex', '--from-file', dump, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ format: 'plex', records: 2, added: 2, plex: { movies: 2, watched: 1, unwatched: 1, rated: 1 } });
    expect(r.stderr).toMatch(/new ones become someday/);
    const db = openDb(home);
    const rows = db.sql.prepare('SELECT source_title, owned, status, my_rating, source FROM library_items ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { source_title: 'The Glass Harbor', owned: 1, status: 'watched', my_rating: 7, source: 'plex' },
      { source_title: 'Lantern Season', owned: 1, status: 'someday', my_rating: null, source: 'plex' },
    ]);
    const again = JSON.parse(run(['--home', home, 'import', 'plex', '--from-file', dump, '--json']).stdout) as Record<string, unknown>;
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
  });

  it('writes nothing on a dry run', () => {
    const home = freshHome();
    const r = run(['--home', home, 'import', 'plex', '--from-file', dump, '--unwatched-status', 'skip', '--dry-run', '--json']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, records: 1, plex: { skippedUnwatched: 1 } });
    expect(existsSync(home)).toBe(false);
  });

  it('needs a token from PLEX_TOKEN or stdin, and never echoes one', () => {
    const home = freshHome();
    const none = run(['--home', home, 'import', 'plex']);
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/PLEX_TOKEN/);
    const bad = run(['--home', home, 'import', 'plex'], { PLEX_TOKEN: `abc\u0007${TOKEN}` });
    expect(bad.code).toBe(1);
    expect(bad.stderr + bad.stdout).not.toContain(TOKEN);
    const both = run(['--home', home, 'import', 'plex', '--token-stdin'], { PLEX_TOKEN: TOKEN }, TOKEN);
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/not both/);
  });

  // A real terminal on stdin (a pseudo-terminal from Python's pty module, when
  // python3 is available): the command must refuse before reading, or it would
  // wait for a token typed on screen and this would time out.
  const python = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!python)('refuses --token-stdin from a terminal before reading', () => {
    const home = freshHome();
    const res = spawnSync(
      'python3',
      ['-c', 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)', process.execPath, CLI, '--home', home, 'import', 'plex', '--token-stdin'],
      { env: { ...process.env, PLEX_TOKEN: undefined } as NodeJS.ProcessEnv, encoding: 'utf8', input: '', timeout: 30_000 },
    );
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/does not read from a terminal/);
    expect(existsSync(home)).toBe(false);
  });

  it('refuses a token in the URL without printing it', () => {
    const home = freshHome();
    const r = run(['--home', home, 'import', 'plex', '--url', `http://127.0.0.1:9/?X-Plex-Token=${TOKEN}`], { PLEX_TOKEN: 'another-fake-1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/query string/);
    expect(r.stderr + r.stdout).not.toContain(TOKEN);
    expect(r.stderr + r.stdout).not.toContain('another-fake-1');
  });

  it('rejects flags that do not fit', () => {
    const home = freshHome();
    expect(run(['--home', home, 'import', dump, '--section', 'Movies']).stderr).toMatch(/--section only applies to `import plex`/);
    expect(run(['--home', home, 'import', 'plex', '--format', 'csv']).stderr).toMatch(/--format does not apply/);
    expect(run(['--home', home, 'import', 'plex', '--from-file', dump, '--unwatched-status', 'watched']).stderr).toMatch(/--unwatched-status expects/);
    expect(run(['--home', home, 'import', 'plex', '--from-file', dump, '--url', 'http://127.0.0.1:9']).stderr).toMatch(/--from-file reads a saved listing/);
    expect(run(['--home', home, 'import', 'plex', '--from-file', dump, '--as', 'list']).stderr).toMatch(/only apply to IMDb files/);
  });

  it('refuses --replace with nothing to import', () => {
    const home = freshHome();
    run(['--home', home, 'import', 'plex', '--from-file', dump]);
    const r = run(['--home', home, 'import', 'plex', '--from-file', join(tmp, 'empty.json'), '--replace']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing to import from Plex/);
    expect(count(home)).toBe(2);
    const partial = run(['--home', home, 'import', 'plex', '--from-file', join(tmp, 'partial.json'), '--replace']);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toMatch(/may be incomplete/);
    expect(count(home)).toBe(2);
    const unreadable = run(['--home', home, 'import', 'plex', '--from-file', join(tmp, 'unreadable.json'), '--replace']);
    expect(unreadable.code).toBe(1);
    expect(unreadable.stderr).toMatch(/may be incomplete/);
    expect(count(home)).toBe(2);
  });
});
