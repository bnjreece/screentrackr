/**
 * Packaging and docs: the README and JSON v1 doc cover what they must, the
 * npm package ships only dist/, README and LICENSE, and CI runs the checks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { exportLibrary } from '../src/core/export.js';
import { applyImport } from '../src/core/importers/index.js';

const ROOT = join(import.meta.dirname, '..');
const CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';
const EM_DASH = '—';

function read(rel: string): string {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

const readme = read('README.md');
const jsonDoc = read('docs/library-json-v1.md');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json')) as {
  files?: string[];
  repository?: unknown;
  keywords?: string[];
  scripts?: Record<string, string>;
};

/** Things that must never appear in a tracked doc: email addresses and hosted infrastructure. */
const PRIVATE = [/[\w.+-]+@[\w-]+\.[\w.]+/, /neon\.tech/i, /auth0\.com/i, /supabase\.co/i, /vercel\.app/i];

describe('README', () => {
  it('exists', () => {
    expect(readme.length).toBeGreaterThan(0);
  });

  it('carries the IMDb credit line verbatim', () => {
    expect(readme).toContain(CREDIT);
  });

  it('has no em dashes', () => {
    expect(readme).not.toContain(EM_DASH);
  });

  it('covers install, import, examples, MCP setup, data, privacy and affiliation', () => {
    expect(readme).toContain('npx screentrackr setup');
    expect(readme).toContain('claude mcp add screentrackr -- npx -y screentrackr mcp');
    expect(readme).toContain('import apple-tv');
    expect(readme).toMatch(/experimental/i);
    expect(readme).toContain('"mcpServers"');
    expect(readme).toContain('--director Fincher --director Villeneuve --genre Thriller --min-rating 7.5 --unwatched --max-runtime 120');
    expect(readme).toContain('datasets.imdbws.com');
    expect(readme).toMatch(/no telemetry/i);
    expect(readme).toMatch(/personal, non-commercial/i);
    expect(readme).toMatch(/not affiliated with IMDb or Apple/i);
    expect(readme).toContain('docs/library-json-v1.md');
    expect(readme).toMatch(/\bMIT\b/);
  });

  it('shows at least five example searches', () => {
    const searches = readme.match(/^screentrackr search .+$/gm) ?? [];
    expect(searches.length).toBeGreaterThanOrEqual(5);
  });

  it('documents every command with its usage line', () => {
    // Read the real CLI's help (importing src/cli/index.ts would run main()).
    const cli = join(ROOT, 'dist', 'cli', 'index.js');
    const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    const names = [...(help.split('Commands:')[1] ?? '').split('Global options:')[0]!.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const usage = execFileSync(process.execPath, [cli, name as string, '--help'], { encoding: 'utf8' }).match(/^Usage: (.+)$/m)?.[1];
      expect(usage, name).toBeDefined();
      expect(readme, name).toContain(usage as string);
    }
  });

  it('has a Claude Desktop snippet that is valid JSON', () => {
    const block = readme.match(/```json\n([\s\S]*?"mcpServers"[\s\S]*?)```/);
    expect(block).not.toBeNull();
    const cfg = JSON.parse((block as RegExpMatchArray)[1] as string) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers.screentrackr).toEqual({ command: 'npx', args: ['-y', 'screentrackr', 'mcp'] });
  });

  it('names no private hosts or emails', () => {
    for (const re of PRIVATE) {
      expect(readme).not.toMatch(re);
      expect(jsonDoc).not.toMatch(re);
    }
  });
});

describe('docs/library-json-v1.md', () => {
  const home = mkdtempSync(join(tmpdir(), 'st-pkg-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('has no em dashes', () => {
    expect(jsonDoc.length).toBeGreaterThan(0);
    expect(jsonDoc).not.toContain(EM_DASH);
  });

  it('documents the envelope and every item field the exporter writes', () => {
    const db = openDb(home);
    try {
      applyImport(db, [{ sourceTitle: 'The Synthetic Example', source: 'manual' }], { mode: 'merge' });
      const out = exportLibrary(db);
      for (const key of Object.keys(out)) expect(jsonDoc, key).toContain(`\`${key}\``);
      expect(jsonDoc).toContain(`"format": "${out.format}"`);
      expect(jsonDoc).toContain(`"version": ${out.version}`);
      const item = out.items[0] as object;
      for (const key of Object.keys(item)) expect(jsonDoc, key).toContain(`\`${key}\``);
    } finally {
      db.close();
    }
  });
});

describe('package.json', () => {
  it('publishes only dist, README and LICENSE', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('has repository, keywords and a prepublishOnly gate', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/bnjreece/screentrackr.git' });
    expect(pkg.keywords?.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain('mcp');
    expect(pkg.scripts?.prepublishOnly).toBe('npm run build && npm test');
  });

  it('packs only dist/**, README.md, LICENSE and package.json', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
    const [info] = JSON.parse(out) as { files: { path: string }[] }[];
    const paths = (info as { files: { path: string }[] }).files.map((f) => f.path);
    expect(paths).toContain('dist/cli/index.js');
    expect(paths).toContain('dist/core/importers/apple-tv.jxa.js');
    for (const p of paths) {
      expect(p === 'README.md' || p === 'LICENSE' || p === 'package.json' || p.startsWith('dist/'), p).toBe(true);
    }
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
  });
});

describe('CI workflow', () => {
  it('runs on push and pull_request across Node 22 and 24', () => {
    expect(ci).toMatch(/^on:/m);
    expect(ci).toMatch(/\bpush\b/);
    expect(ci).toMatch(/\bpull_request\b/);
    expect(ci).toMatch(/node-version:.*\b22\b.*\b24\b|\b22\b[\s\S]*\b24\b/);
  });

  it('runs npm ci, lint, typecheck and test', () => {
    for (const step of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test']) expect(ci, step).toContain(step);
  });
});
