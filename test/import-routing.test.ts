/**
 * How a plain `screentrackr import <path>` chooses between the Letterboxd and
 * Trakt readers for a ZIP or folder, told from entry names alone, and how the
 * flags shared by `import plex` and `import jellyfin` are checked. Every
 * export here is invented.
 */
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importCmd } from '../src/cli/commands/import.js';
import type { Ctx } from '../src/cli/context.js';
import { openDb, type Db } from '../src/core/db.js';
import { folderFiles } from './fixtures/folder-files.js';
import { makeZip } from './fixtures/make-zip.js';
import { exportFiles, toBytes } from './fixtures/trakt-export.js';

const LB_EXPORT = join(import.meta.dirname, 'fixtures', 'letterboxd', 'export');

describe('plain import of a ZIP or folder', () => {
  let tmp: string;
  let out: string[];
  let ctx: Ctx;
  let db: Db | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'screentrackr-routing-'));
    out = [];
    db = undefined;
    ctx = {
      home: join(tmp, 'home'),
      json: true,
      tty: false,
      color: false,
      width: undefined,
      db: () => (db ??= openDb(join(tmp, 'home'))),
      out: (t) => out.push(t),
      log: () => {},
      emit: (data) => out.push(JSON.stringify(data)),
      close: () => db?.close(),
    };
  });
  afterEach(() => {
    ctx.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const format = () => (JSON.parse(out.at(-1) as string) as { format: string }).format;

  it('sends a Letterboxd ZIP to the Letterboxd reader and a Trakt ZIP to the Trakt reader', async () => {
    const lb = join(tmp, 'letterboxd.zip');
    writeFileSync(lb, makeZip(folderFiles(LB_EXPORT, 'letterboxd-export/')));
    await importCmd.run(ctx, [lb], { 'dry-run': true });
    expect(format()).toBe('letterboxd');

    const trakt = join(tmp, 'trakt-export-someone.zip');
    writeFileSync(trakt, makeZip(toBytes(exportFiles())));
    await importCmd.run(ctx, [trakt], { 'dry-run': true });
    expect(format()).toBe('trakt');
  });

  it('sends a Trakt folder to the Trakt reader', async () => {
    const dir = join(tmp, 'trakt-folder');
    mkdirSync(dir);
    for (const [name, data] of Object.entries(toBytes(exportFiles()))) writeFileSync(join(dir, name), data);
    await importCmd.run(ctx, [dir], { 'dry-run': true });
    expect(format()).toBe('trakt');
  });

  it('refuses --replace on a Trakt ZIP given to plain import', async () => {
    const trakt = join(tmp, 'export.zip');
    writeFileSync(trakt, makeZip(toBytes(exportFiles())));
    await expect(importCmd.run(ctx, [trakt], { replace: true })).rejects.toThrow(/only merges/);
  });

  it('refuses a ZIP that holds both exports, or neither', async () => {
    const both = join(tmp, 'both.zip');
    writeFileSync(both, makeZip({ ...folderFiles(LB_EXPORT, 'lb/'), ...toBytes(exportFiles()) }));
    await expect(importCmd.run(ctx, [both], {})).rejects.toThrow(/both a Letterboxd and a Trakt export/);
    const neither = join(tmp, 'neither.zip');
    writeFileSync(neither, makeZip({ 'notes.txt': Buffer.from('hello') }));
    await expect(importCmd.run(ctx, [neither], {})).rejects.toThrow(/not a Letterboxd export .* or a Trakt export/);
  });

  it('refuses an oversized ZIP before reading it, on every route', async () => {
    // A sparse file: ZIP magic, then a size past the 1 GiB cap. Reading it
    // whole would take a gigabyte; the size check stops it first.
    const big = join(tmp, 'huge-export.zip');
    writeFileSync(big, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    truncateSync(big, 1024 * 1024 * 1024 + 1);
    await expect(importCmd.run(ctx, [big], { 'dry-run': true })).rejects.toThrow(/too large to read/);
    await expect(importCmd.run(ctx, [big], { format: 'letterboxd' })).rejects.toThrow(/too large to read/);
    await expect(importCmd.run(ctx, ['letterboxd', big], {})).rejects.toThrow(/too large to read/);
    await expect(importCmd.run(ctx, ['trakt', big], {})).rejects.toThrow(/too large to read/);
    const disguised = join(tmp, 'huge-export.dat');
    writeFileSync(disguised, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    truncateSync(disguised, 1024 * 1024 * 1024 + 1);
    await expect(importCmd.run(ctx, [disguised], {})).rejects.toThrow(/too large to read/);
  });

  it('checks the flags shared by plex and jellyfin', async () => {
    await expect(importCmd.run(ctx, ['some.csv'], { url: 'http://127.0.0.1:1' })).rejects.toThrow(/only apply to `import plex` and `import jellyfin`/);
    await expect(importCmd.run(ctx, ['jellyfin'], { url: 'http://127.0.0.1:1', 'from-file': 'x.json' })).rejects.toThrow(/--from-file only applies to `import plex`/);
    await expect(importCmd.run(ctx, ['plex'], { 'password-stdin': true })).rejects.toThrow(/only apply to `import jellyfin`/);
  });
});
