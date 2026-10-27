/** The shared ZIP reader every archive importer uses (src/core/zip.ts). Archives are built in memory. */
import { describe, expect, it } from 'vitest';
import { ImportError } from '../src/core/importers/common.js';
import { listZip } from '../src/core/zip.js';
import { makeZip } from './fixtures/make-zip.js';

describe('the ZIP reader', () => {
  it('rejects something that is not a ZIP, and caps entry sizes', () => {
    expect(() => listZip(Buffer.from('not a zip at all'))).toThrow(/not a ZIP/i);
    const big = makeZip({ 'ratings-movies.json': Buffer.alloc(5000, 0x20) });
    const [entry] = listZip(big);
    expect(entry?.name).toBe('ratings-movies.json');
    expect(entry?.read(10_000).length).toBe(5000);
    expect(() => entry?.read(1000)).toThrow(/too large/i);
  });

  it('checks a stored entry\'s sizes before copying it', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.alloc(5000, 0x20) }, { store: true });
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, cd + 24); // claim 10 bytes uncompressed
    const [entry] = listZip(zip);
    expect(() => entry?.read(100)).toThrow(/sizes disagree/);
  });

  it('refuses a directory that declares fewer entries than it holds', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[]'), 'lists-watchlist.json': Buffer.from('[]') });
    const end = zip.length - 22;
    zip.writeUInt16LE(1, end + 8);
    zip.writeUInt16LE(1, end + 10);
    expect(() => listZip(zip)).toThrow(/damaged/);
  });

  it('refuses an entry whose local name differs from the directory', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[]') });
    zip.write('x', 30); // first byte of the local header's name
    const [entry] = listZip(zip);
    expect(() => entry?.read(100)).toThrow(/names disagree/);
  });

  it('refuses a directory that ends before the end record (entries hidden in a gap)', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[]'), '_errors.json': Buffer.from('[{"endpoint":"x"}]') });
    const end = zip.length - 22;
    const cdOffset = zip.readUInt32LE(end + 16);
    const firstLen = 46 + 'ratings-movies.json'.length;
    zip.writeUInt16LE(1, end + 8);
    zip.writeUInt16LE(1, end + 10);
    zip.writeUInt32LE(firstLen, end + 12);
    expect(cdOffset + firstLen).toBeLessThan(end);
    expect(() => listZip(zip)).toThrow(/damaged/);
  });

  it('rejects a corrupted entry', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[1,2,3]') }, { store: true });
    zip[30 + 'ratings-movies.json'.length] = 0x7b; // change the first data byte
    const [entry] = listZip(zip);
    expect(() => entry?.read(1000)).toThrow(/damaged|checksum/i);
  });

  it('flags entry names that climb out of the archive', () => {
    const zip = makeZip({ '../ratings-movies.json': Buffer.from('[]'), '/abs/lists-watchlist.json': Buffer.from('[]') });
    expect(listZip(zip).map((e) => e.unsafe)).toEqual([true, true]);
  });
});

describe('the ZIP reader, more cases', () => {
  it('reads stored and deflated entries, skips directories and throws ImportError', () => {
    const files = { 'export/': Buffer.alloc(0), 'export/a.csv': Buffer.from('Const,Title\n'), 'b.txt': Buffer.from('hello') };
    for (const store of [false, true]) {
      const entries = listZip(makeZip(files, { store }));
      expect(entries.map((e) => [e.name, e.size, e.unsafe])).toEqual([
        ['export/a.csv', 12, false],
        ['b.txt', 5, false],
      ]);
      expect(entries[0]?.read(100).toString('utf8')).toBe('Const,Title\n');
      expect(entries[1]?.read(5).toString('utf8')).toBe('hello');
    }
    expect(() => listZip(Buffer.alloc(10))).toThrow(ImportError);
  });

  it('flags backslash and drive-letter names as unsafe', () => {
    const zip = makeZip({ '..\\x.csv': Buffer.from('a'), 'C:/x.csv': Buffer.from('b'), 'ok/..x.csv': Buffer.from('c') });
    expect(listZip(zip).map((e) => e.unsafe)).toEqual([true, true, false]);
  });

  it('refuses an encrypted entry', () => {
    const zip = makeZip({ 'a.csv': Buffer.from('x') });
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(zip.readUInt16LE(cd + 8) | 1, cd + 8);
    const [entry] = listZip(zip);
    expect(() => entry?.read(100)).toThrow(/encrypted/);
  });

  it('caps a deflated entry by what it inflates to, not what it claims', () => {
    const zip = makeZip({ 'a.csv': Buffer.alloc(50_000, 0x41) });
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, cd + 24); // claim 10 bytes uncompressed
    const [entry] = listZip(zip);
    expect(() => entry?.read(1000)).toThrow(/too large/);
  });
});
