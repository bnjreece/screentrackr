/**
 * Where to watch: the JustWatch search link (built, never fetched), the
 * country it uses and the title it searches for, and handing the link to the
 * system browser without a shell.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/core/config.js';
import { LibraryError } from '../src/core/errors.js';
import { stripTitleSuffixes } from '../src/core/normalize.js';
import {
  DEFAULT_COUNTRY,
  justWatchCountry,
  justWatchUrl,
  localeRegion,
  openerFor,
  openUrl,
  resolveCountry,
  savedCountry,
  whereTitle,
} from '../src/core/where.js';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-where-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('justWatchUrl', () => {
  it.each([
    ['The Glass Harbor', 'us', 'https://www.justwatch.com/us/search?q=The%20Glass%20Harbor'],
    ['Salt & Signal', 'us', 'https://www.justwatch.com/us/search?q=Salt%20%26%20Signal'],
    ['Number #9?', 'de', 'https://www.justwatch.com/de/search?q=Number%20%239%3F'],
    ['Le Phare Noir: Édition', 'fr', 'https://www.justwatch.com/fr/search?q=Le%20Phare%20Noir%3A%20%C3%89dition'],
    ['a/b=c+d', 'us', 'https://www.justwatch.com/us/search?q=a%2Fb%3Dc%2Bd'],
  ])('%s in %s', (title, country, url) => {
    expect(justWatchUrl(title, country)).toBe(url);
  });

  it('maps GB to JustWatch\'s own uk path, in any case', () => {
    expect(justWatchUrl('X', 'gb')).toBe('https://www.justwatch.com/uk/search?q=X');
    expect(justWatchUrl('X', 'GB')).toBe('https://www.justwatch.com/uk/search?q=X');
    expect(justWatchUrl('X', 'uk')).toBe('https://www.justwatch.com/uk/search?q=X');
  });

  it('refuses a country that is not two letters, so nothing odd reaches the path', () => {
    for (const bad of ['usa', 'u', '', '1a', 'u/', '../', 'é1']) expect(() => justWatchUrl('X', bad), bad).toThrow(LibraryError);
  });

  it('refuses an empty title', () => {
    expect(() => justWatchUrl('   ', 'us')).toThrow(LibraryError);
  });
});

describe('justWatchCountry', () => {
  it('lowercases, trims and maps', () => {
    expect(justWatchCountry(' DE ')).toBe('de');
    expect(justWatchCountry('gb')).toBe('uk');
    expect(() => justWatchCountry('deu')).toThrow(/two letters/);
  });
});

describe('localeRegion', () => {
  it('reads the region from LC_ALL, then LC_MESSAGES, then LANG', () => {
    expect(localeRegion({ LC_ALL: 'en_GB.UTF-8', LANG: 'de_DE.UTF-8' })).toBe('gb');
    expect(localeRegion({ LC_MESSAGES: 'fr_CA.UTF-8', LANG: 'de_DE.UTF-8' })).toBe('ca');
    expect(localeRegion({ LANG: 'de_DE.UTF-8@euro' })).toBe('de');
    expect(localeRegion({ LANG: 'pt-BR' })).toBe('br');
  });

  it('skips locales without a two-letter region and falls back to the Intl locale', () => {
    expect(localeRegion({ LC_ALL: 'C', LANG: 'POSIX' }, 'en-AU')).toBe('au');
    expect(localeRegion({ LANG: 'en' }, 'es-419')).toBeNull();
    expect(localeRegion({}, 'en')).toBeNull();
    expect(localeRegion({ LANG: 'C.UTF-8' }, 'sv-SE')).toBe('se');
  });

  it('ignores an Intl locale it cannot parse', () => {
    expect(localeRegion({}, 'not a locale!!')).toBeNull();
  });
});

describe('resolveCountry', () => {
  it('prefers the flag, then the saved setting, then the locale, then us', () => {
    expect(resolveCountry({ flag: 'GB', saved: 'de', env: { LANG: 'fr_FR.UTF-8' } })).toEqual({ country: 'uk', from: 'flag' });
    expect(resolveCountry({ saved: 'de', env: { LANG: 'fr_FR.UTF-8' } })).toEqual({ country: 'de', from: 'config' });
    expect(resolveCountry({ env: { LANG: 'en_GB.UTF-8' }, intlLocale: 'en' })).toEqual({ country: 'uk', from: 'locale' });
    expect(resolveCountry({ env: {}, intlLocale: 'en' })).toEqual({ country: DEFAULT_COUNTRY, from: 'default' });
    expect(DEFAULT_COUNTRY).toBe('us');
  });

  it('refuses a bad flag rather than falling back', () => {
    expect(() => resolveCountry({ flag: 'zzz', env: {} })).toThrow(/two letters/);
  });
});

describe('savedCountry', () => {
  it('reads country from config.json, and undefined without one', () => {
    const home = join(tmp, 'h1');
    expect(savedCountry(home)).toBeUndefined();
    saveConfig(home, { version: 1, country: 'de' });
    expect(savedCountry(home)).toBe('de');
  });

  it('throws ConfigError for a broken config', () => {
    const home = join(tmp, 'h2');
    saveConfig(home, { version: 1 });
    writeFileSync(join(home, 'config.json'), '{not json');
    expect(() => savedCountry(home)).toThrow(LibraryError);
  });
});

describe('whereTitle', () => {
  it('uses the catalog title for a linked item', () => {
    expect(whereTitle({ linked: true, catalogTitle: 'The Glass Harbor', sourceTitle: 'Glass Harbor (4K)' })).toBe('The Glass Harbor');
  });

  it('strips edition tags and a trailing year from a source title, keeping case', () => {
    expect(whereTitle({ linked: false, catalogTitle: null, sourceTitle: "Basement Tapes (Director's Cut) (2001)" })).toBe('Basement Tapes');
    expect(whereTitle({ linked: false, catalogTitle: null, sourceTitle: 'Basement Tapes [4K]' })).toBe('Basement Tapes');
    expect(whereTitle({ linked: false, catalogTitle: null, sourceTitle: 'Basement Tapes (The Sequel)' })).toBe('Basement Tapes (The Sequel)');
    // A linked item whose catalog row is missing (no catalog yet) falls back to its source title.
    expect(whereTitle({ linked: true, catalogTitle: null, sourceTitle: 'Night Ferry (2002)' })).toBe('Night Ferry');
  });

  it('never strips the whole title', () => {
    expect(stripTitleSuffixes('(2001)')).toBe('(2001)');
    expect(stripTitleSuffixes('  Échos (Remastered)  ')).toBe('Échos');
  });
});

describe('openUrl', () => {
  it('names open on macOS and xdg-open on Linux, nothing elsewhere', () => {
    expect(openerFor('darwin')).toBe('open');
    expect(openerFor('linux')).toBe('xdg-open');
    expect(openerFor('win32')).toBeNull();
  });

  function fakeSpawn(outcome: 'spawn' | Error) {
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
    const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { unref() {} });
      queueMicrotask(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', outcome)));
      return child;
    };
    return { spawn, calls };
  }

  it('passes the URL as the one argument, with no shell', async () => {
    const { spawn, calls } = fakeSpawn('spawn');
    const url = 'https://www.justwatch.com/us/search?q=a%20%26%20b';
    await openUrl(url, { platform: 'darwin', spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('open');
    expect(calls[0]!.args).toEqual([url]);
    expect(calls[0]!.options.shell).toBe(false);
  });

  it('refuses anything but a JustWatch https link', async () => {
    const { spawn, calls } = fakeSpawn('spawn');
    await expect(openUrl('file:///etc/passwd', { platform: 'darwin', spawn })).rejects.toThrow(LibraryError);
    await expect(openUrl('-a Calculator', { platform: 'darwin', spawn })).rejects.toThrow(LibraryError);
    await expect(openUrl('https://example.com/', { platform: 'darwin', spawn })).rejects.toThrow(LibraryError);
    expect(calls).toHaveLength(0);
  });

  it('reports an unsupported platform and a missing opener as user errors', async () => {
    const { spawn } = fakeSpawn('spawn');
    await expect(openUrl('https://www.justwatch.com/us/search?q=X', { platform: 'win32', spawn })).rejects.toThrow(/macOS and Linux/);
    const missing = fakeSpawn(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
    await expect(openUrl('https://www.justwatch.com/us/search?q=X', { platform: 'linux', spawn: missing.spawn })).rejects.toThrow(/xdg-open/);
  });
});
