/**
 * The Claude Desktop extension manifest: valid against the MCPB 0.3 schema,
 * in step with package.json and the server's real tools, and free of private
 * details. `npm run pack:mcpb` builds and checks the bundle itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v0_3 } from '@anthropic-ai/mcpb/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { createMcpServer } from '../src/mcp/server.js';

const ROOT = join(import.meta.dirname, '..');
const raw = readFileSync(join(ROOT, 'mcpb', 'manifest.json'), 'utf8');
const manifest = JSON.parse(raw) as {
  version: string;
  name: string;
  icon: string;
  server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };
  tools: { name: string }[];
  compatibility: { runtimes: { node: string } };
};
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  engines: { node: string };
  scripts: Record<string, string>;
};

describe('mcpb/manifest.json', () => {
  it('validates against the MCPB 0.3 manifest schema', () => {
    const r = v0_3.McpbManifestSchema.safeParse(manifest);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('matches package.json name, version and Node requirement', () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.engines.node).toBe('>=22.13');
    expect(manifest.compatibility.runtimes.node).toBe('>=22.13.0');
  });

  it('runs the compiled CLI in mcp mode from the bundle directory', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('dist/cli/index.js');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/cli/index.js', 'mcp']);
    expect(manifest.icon).toBe('icon.png');
    const png = readFileSync(join(ROOT, 'mcpb', manifest.icon));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('lists exactly the tools the server registers', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'screentrackr-mcpb-'));
    const db = openDb(tmp);
    const server = createMcpServer(db);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'mcpb-test', version: '0' });
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      expect(manifest.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    } finally {
      await client.close();
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('has no em dashes, email addresses or local paths', () => {
    expect(raw).not.toContain('\u2014');
    expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(raw).not.toMatch(/\/Users\/|\/home\//);
  });

  it('is documented in the README', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('## Claude Desktop');
    expect(readme).toContain('npm run pack:mcpb');
    expect(readme).toContain('setup_catalog');
    expect(readme).toContain('catalog_status');
  });

  it('has a pack script that builds first', () => {
    expect(pkg.scripts['pack:mcpb']).toBe('npm run build && node scripts/pack-mcpb.mjs');
  });
});
