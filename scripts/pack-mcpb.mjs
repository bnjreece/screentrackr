#!/usr/bin/env node
/**
 * Build the Claude Desktop extension (MCP Bundle): build/mcpb/screentrackr-<version>.mcpb.
 * Run through `npm run pack:mcpb`, which builds dist/ first.
 *
 * The bundle holds only what the server needs at runtime: manifest.json,
 * icon.png, LICENSE, a minimal package.json, the compiled dist/ (no source
 * maps) and production node_modules (without their tests and docs). Our
 * tests, docs and TypeScript sources never go in. After packing, the bundle is
 * unpacked again and checked: its top-level entries, and a stdio MCP
 * handshake whose tools must match the manifest.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'build', 'mcpb');
const STAGE = join(OUT, 'stage');
// Both CLIs run as JavaScript under this Node, with no shell, so paths with spaces work everywhere.
const MCPB = join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
// Set by `npm run`; the npm CLI's own JavaScript entry point.
const NPM_CLI = process.env.npm_execpath;

/** The only top-level entries the bundle may contain. */
const BUNDLE_ENTRIES = ['LICENSE', 'dist', 'icon.png', 'manifest.json', 'node_modules', 'package.json'];

/** Folders and files inside node_modules that are never needed at runtime. */
const PRUNE_DIRS = new Set(['.github', 'test', 'tests', '__tests__', 'benchmark', 'example', 'examples', 'docs']);
const PRUNE_FILE = /^(readme|changelog|history|contributing|security)(\.[a-z]+)?$/i;

function fail(message) {
  process.stderr.write(`pack-mcpb: ${message}\n`);
  process.exit(1);
}

function node(script, args, opts = {}) {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit', ...opts });
}

/** Recursively list files under dir, relative to it, with forward slashes. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), `${rel}/`));
    else out.push(rel);
  }
  return out;
}

function prune(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (PRUNE_DIRS.has(e.name)) rmSync(p, { recursive: true, force: true });
      else prune(p);
    } else if (PRUNE_FILE.test(e.name)) rmSync(p, { force: true });
  }
}

/** Start the server in `dir` over stdio and return the tool names it lists. */
async function smokeTest(dir) {
  const home = mkdtempSync(join(tmpdir(), 'screentrackr-mcpb-'));
  try {
    const child = spawn(process.execPath, [join(dir, 'dist', 'cli', 'index.js'), 'mcp'], {
      env: { ...process.env, SCREENTRACKR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((r) => child.once('exit', r));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-mcpb', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const deadline = Date.now() + 15_000;
    while (!/"id":2\b/.test(stdout) && Date.now() < deadline && child.exitCode === null) {
      await sleep(50);
    }
    child.stdin.end();
    await exited;
    const reply = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.id === 2);
    if (!reply?.result?.tools) fail(`the bundled server did not answer tools/list.\n${stderr}`);
    return reply.result.tools.map((t) => t.name);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'mcpb', 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) fail(`mcpb/manifest.json version ${manifest.version} differs from package.json ${pkg.version}`);
if (!existsSync(join(ROOT, 'dist', 'cli', 'index.js'))) fail('dist/ is missing; run `npm run build` first');
if (!existsSync(MCPB)) fail('the mcpb CLI is missing; run `npm ci` first');
if (!NPM_CLI || !/\.[cm]?js$/.test(NPM_CLI)) fail('run this through `npm run pack:mcpb`');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

cpSync(join(ROOT, 'dist'), join(STAGE, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
cpSync(join(ROOT, 'mcpb', 'manifest.json'), join(STAGE, 'manifest.json'));
cpSync(join(ROOT, 'mcpb', 'icon.png'), join(STAGE, 'icon.png'));
cpSync(join(ROOT, 'LICENSE'), join(STAGE, 'LICENSE'));

// Production dependencies, exactly as locked, with no install scripts.
cpSync(join(ROOT, 'package.json'), join(STAGE, 'package.json'));
cpSync(join(ROOT, 'package-lock.json'), join(STAGE, 'package-lock.json'));
node(NPM_CLI, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: STAGE });
rmSync(join(STAGE, 'package-lock.json'));
rmSync(join(STAGE, 'node_modules', '.package-lock.json'), { force: true });
prune(join(STAGE, 'node_modules'));

// A minimal package.json: the server reads its version from it, and "type" makes dist/ ESM.
const slim = { name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: pkg.type, dependencies: pkg.dependencies };
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(slim, null, 2)}\n`);

const bundle = join(OUT, `${pkg.name}-${pkg.version}.mcpb`);
node(MCPB, ['validate', join(STAGE, 'manifest.json')]);
node(MCPB, ['pack', STAGE, bundle]);

// Check what actually shipped: unpack the bundle and inspect it.
const unpacked = mkdtempSync(join(tmpdir(), 'screentrackr-mcpb-unpacked-'));
try {
  node(MCPB, ['unpack', bundle, unpacked], { stdio: 'ignore' });
  const entries = readdirSync(unpacked).sort();
  if (JSON.stringify(entries) !== JSON.stringify(BUNDLE_ENTRIES)) fail(`unexpected bundle entries: ${entries.join(', ')}`);
  const files = listFiles(unpacked);
  const ours = files.filter((f) => !f.startsWith('node_modules/'));
  const bad = ours.filter((f) => f.endsWith('.ts') || f.endsWith('.map') || /^(test|docs|src)\//.test(f));
  if (bad.length) fail(`bundle contains files it should not: ${bad.join(', ')}`);

  const tools = await smokeTest(unpacked);
  const declared = manifest.tools.map((t) => t.name).sort();
  if (JSON.stringify([...tools].sort()) !== JSON.stringify(declared)) {
    fail(`manifest tools (${declared.join(', ')}) differ from the server's (${tools.join(', ')})`);
  }
  writeFileSync(join(OUT, 'contents.txt'), `${files.sort().join('\n')}\n`);
  process.stdout.write(`\nBuilt ${relative(ROOT, bundle)}: ${files.length} files (${ours.length} outside node_modules).\n`);
  process.stdout.write(`Bundle file list: ${relative(ROOT, join(OUT, 'contents.txt'))}\n`);
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
