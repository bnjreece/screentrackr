/**
 * A small, read-only ZIP reader for exports the user downloaded (a Letterboxd
 * export, for one). It lists the central directory and inflates only the
 * entries a caller asks for, in memory: nothing is extracted to disk.
 *
 * Refused: ZIP64 archives, encrypted entries, compression other than stored
 * or deflate, and archives whose entries would inflate past the size caps (a
 * zip bomb). Each entry's CRC-32 is checked.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { ImportError } from './common.js';

export interface ZipLimits {
  /** Largest uncompressed size of one entry, in bytes. */
  maxEntryBytes: number;
  /** Largest total uncompressed size of the entries read, in bytes. */
  maxTotalBytes: number;
  /** Most entries the central directory may list. */
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 100_000,
};

interface Entry {
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipArchive {
  /** File entries (directories left out), by their path inside the archive. */
  paths: string[];
  /** The entry's bytes. Throws ImportError for an unknown path or a damaged entry. */
  read(path: string): Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Whether the bytes start like a ZIP archive. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Open a ZIP archive held in memory. */
export function openZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = (why: string): never => {
    throw new ImportError(`Not a readable ZIP archive: ${why}`);
  };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) bad('no end of central directory');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    throw new ImportError('ZIP64 archives are not supported. Export again, or unzip it and import the folder.');
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ImportError('ZIP64 archives are not supported. Export again, or unzip it and import the folder.');
  }
  if (count > limits.maxEntries) bad(`more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > eocd) bad('central directory out of range');

  const entries = new Map<string, Entry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) bad('damaged central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) bad('damaged central directory');
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ImportError('Encrypted ZIP archives are not supported.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ImportError('ZIP64 archives are not supported. Export again, or unzip it and import the folder.');
    }
    const path = name.replace(/\\/g, '/');
    // Directories, and names that would point outside the archive, are not files of it.
    if (path.endsWith('/') || path.startsWith('/') || path.split('/').some((s) => s === '..')) continue;
    entries.set(path, { method, crc, compressedSize, size, localOffset });
  }

  let total = 0;
  return {
    paths: [...entries.keys()],
    read(path: string): Uint8Array {
      const e = entries.get(path);
      if (!e) throw new ImportError(`${path} is not in the archive`);
      if (e.method !== 0 && e.method !== 8) throw new ImportError(`${path}: unsupported ZIP compression method ${e.method}`);
      if (e.size > limits.maxEntryBytes) throw new ImportError(`${path} is too large to read (over ${limits.maxEntryBytes} bytes)`);
      if (total + e.size > limits.maxTotalBytes) throw new ImportError(`The archive is too large to read (over ${limits.maxTotalBytes} bytes)`);
      const lo = e.localOffset;
      if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) bad(`damaged entry ${path}`);
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      if (start + e.compressedSize > buf.length) bad(`damaged entry ${path}`);
      const raw = buf.subarray(start, start + e.compressedSize);
      let out: Buffer;
      if (e.method === 0) out = raw;
      else {
        try {
          // Inflate no further than the size the directory declares (plus one
          // byte, to notice a lie), so a crafted entry can't exhaust memory.
          out = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size + 1) });
        } catch {
          return bad(`damaged entry ${path}`);
        }
      }
      if (out.length !== e.size || crc32(out) !== e.crc) bad(`damaged entry ${path}`);
      total += e.size;
      return out;
    },
  };
}
