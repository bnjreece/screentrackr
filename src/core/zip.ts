/**
 * A small, read-only ZIP reader for export archives a user downloads (Trakt's
 * data export, say). The archive is untrusted: nothing is written to disk, an
 * entry is only inflated when the caller asks for it, every inflate is capped,
 * and its checksum is verified. Stored and deflated entries are supported;
 * ZIP64, encryption and other methods are refused.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { ImportError } from './importers/common.js';

export interface ZipEntry {
  /** The entry's path inside the archive, as stored. */
  name: string;
  /** Uncompressed size, as the archive declares it. */
  size: number;
  /** True for a name that is absolute or climbs out with `..`; callers skip these. */
  unsafe: boolean;
  /** Inflate the entry, refusing one larger than `maxBytes`. */
  read(maxBytes: number): Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** No archive we read comes near this many entries. */
const MAX_ENTRIES = 100_000;

function fail(msg: string): never {
  throw new ImportError(msg);
}

function isUnsafe(name: string): boolean {
  const n = name.replace(/\\/g, '/');
  return n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..');
}

/** List an archive's entries (directories left out). Throws ImportError when it is not a ZIP this can read. */
export function listZip(buf: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('not a ZIP archive (or a damaged one)');
  const disk = buf.readUInt16LE(end + 4);
  const cdDisk = buf.readUInt16LE(end + 6);
  const onDisk = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) fail('multi-part ZIP archives are not supported');
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('ZIP64 archives are not supported');
  if (count > MAX_ENTRIES) fail(`the ZIP has too many entries (${count})`);
  if (cdOffset + cdSize > end) fail('not a ZIP archive (or a damaged one)');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) fail('the ZIP directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) fail('the ZIP directory is damaged');
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    p = next;
    if (name.endsWith('/')) continue;
    const read = (maxBytes: number): Buffer => {
      if (flags & 1) fail(`${name}: encrypted ZIP entries are not supported`);
      if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) fail(`${name}: ZIP64 entries are not supported`);
      if (usize > maxBytes) fail(`${name}: too large (${usize} bytes, the limit is ${maxBytes})`);
      // A stored entry is copied as is, so its sizes must agree and fit before anything is allocated.
      if (method === 0 && (csize !== usize || csize > maxBytes)) fail(`${name}: the ZIP entry is damaged (sizes disagree)`);
      if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== LOCAL) fail(`${name}: the ZIP entry is damaged`);
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      // The local header must name the same entry as the directory.
      if (localOffset + 30 + localNameLen > cdOffset || !buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(nameBytes)) {
        fail(`${name}: the ZIP entry is damaged (its names disagree)`);
      }
      const start = localOffset + 30 + localNameLen + buf.readUInt16LE(localOffset + 28);
      if (start + csize > cdOffset) fail(`${name}: the ZIP entry is damaged`);
      const raw = buf.subarray(start, start + csize);
      let data: Buffer;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) {
        try {
          data = inflateRawSync(raw, { maxOutputLength: Math.max(1, maxBytes) });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') fail(`${name}: too large (the limit is ${maxBytes} bytes)`);
          fail(`${name}: the ZIP entry is damaged`);
        }
      } else fail(`${name}: unsupported ZIP compression method ${method}`);
      if (data.length !== usize || crc32(data) !== crc) fail(`${name}: the ZIP entry is damaged (checksum mismatch)`);
      return data;
    };
    entries.push({ name, size: usize, unsafe: isUnsafe(name), read });
  }
  // The directory must hold exactly the entries it declares, so none is silently left out.
  if (p !== cdOffset + cdSize) fail('the ZIP directory is damaged (its size and entry count disagree)');
  return entries;
}
