/**
 * A tiny ZIP writer for tests: builds an archive in memory from invented
 * files, so no binary fixture is committed. `tamper` lets a test damage it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  path: string;
  data: string | Uint8Array;
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8;
  /** General purpose flags (bit 0 marks it encrypted). */
  flags?: number;
  /** Override the declared uncompressed size. */
  declaredSize?: number;
  /** Override the declared CRC-32. */
  declaredCrc?: number;
}

export function makeZip(entries: ZipEntryInput[], opts: { entryCount?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.path, 'utf8');
    const crc = e.declaredCrc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const flags = (e.flags ?? 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = opts.entryCount ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Every file under a folder, as ZIP entries under `prefix`. */
export function folderEntries(dir: string, prefix = '', transform: (text: string) => string = (t) => t): ZipEntryInput[] {
  const out: ZipEntryInput[] = [];
  const walk = (rel: string) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p);
      else out.push({ path: prefix + p, data: transform(readFileSync(join(dir, p), 'utf8')) });
    }
  };
  walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
