/** core/config.ts: ~/.screentrackr/config.json, non-secret settings only. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  ConfigError,
  configPath,
  getConfigValue,
  loadConfig,
  parseConfig,
  removeSyncSource,
  saveConfig,
  setConfigValue,
  syncSource,
  unsetConfigValue,
  updateConfig,
  upsertSyncSource,
  type Config,
} from '../src/core/config.js';
import { LibraryError } from '../src/core/library.js';

let home: string;
beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), 'st-config-')), 'home');
});
afterEach(() => rmSync(join(home, '..'), { recursive: true, force: true }));

const full: Config = {
  version: 1,
  country: 'us',
  sync: {
    sources: [
      { kind: 'plex', url: 'http://127.0.0.1:32400', sections: ['Movies'], includeOtherVideos: false, unwatchedStatus: 'someday', ratings: true, history: false },
      { kind: 'jellyfin', url: 'http://localhost:8096', user: 'ben', ratings: false, strictPlayed: false, timeoutSec: 30 },
      { kind: 'apple-tv', timeoutSec: 120 },
    ],
  },
};

describe('config.json', () => {
  it('is empty (version 1) when missing, and never created by reading', () => {
    expect(loadConfig(home)).toEqual({ version: CONFIG_VERSION });
    expect(existsSync(configPath(home))).toBe(false);
  });

  it('round trips the whole schema, owner-only, with no temp file left', () => {
    saveConfig(home, full);
    expect(loadConfig(home)).toEqual(full);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(['config.json']);
    // An existing file with wider permissions is replaced owner-only.
    writeFileSync(configPath(home), JSON.stringify({ version: 1 }), { mode: 0o644 });
    saveConfig(home, full);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig({ version: 1, colour: 'red' })).toThrow(ConfigError);
    expect(() => parseConfig({ version: 1, sync: { sources: [{ kind: 'apple-tv', extra: 1 }] } })).toThrow(/extra/);
  });

  it('rejects a key that looks like a secret, saying tokens are never stored', () => {
    expect(() => parseConfig({ version: 1, sync: { sources: [{ kind: 'plex', url: 'http://x:32400', Token: 'abc' }] } })).toThrow(/never stored.*PLEX_TOKEN/);
    expect(() => parseConfig({ version: 1, sync: { sources: [{ kind: 'jellyfin', url: 'http://x:8096', password: 'p' }] } })).toThrow(/JELLYFIN_TOKEN/);
    for (const key of ['apiKey', 'API_KEY', 'secret', 'clientSecret']) {
      expect(() => parseConfig({ version: 1, [key]: 'x' }), key).toThrow(/never stored/);
    }
    // saveConfig checks too, so nothing secret reaches the disk.
    expect(() => saveConfig(home, { version: 1, token: 'x' } as unknown as Config)).toThrow(/never stored/);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it('rejects server URLs with credentials, a query or another scheme', () => {
    const plex = (url: string) => parseConfig({ version: 1, sync: { sources: [{ kind: 'plex', url }] } });
    expect(() => plex('http://user:pw@127.0.0.1:32400')).toThrow(/user name or password/);
    expect(() => plex('http://127.0.0.1:32400/?X-Plex-Token=abc')).toThrow(/query/);
    expect(() => plex('ftp://127.0.0.1')).toThrow(/http/);
    expect(() => parseConfig({ version: 1, sync: { sources: [{ kind: 'jellyfin', url: 'http://u:p@localhost:8096' }] } })).toThrow(/user name or password/);
  });

  it('refuses a config written by a newer screentrackr', () => {
    expect(() => parseConfig({ version: 2 })).toThrow(/newer.*[Uu]pgrade screentrackr/);
  });

  it('allows one source per kind and validates country', () => {
    expect(() => parseConfig({ version: 1, sync: { sources: [{ kind: 'apple-tv' }, { kind: 'apple-tv' }] } })).toThrow(/one apple-tv/);
    expect(() => parseConfig({ version: 1, country: 'USA' })).toThrow(ConfigError);
    expect(parseConfig({ version: 1, country: 'uk' }).country).toBe('uk');
  });

  it('reports a damaged file plainly', () => {
    saveConfig(home, { version: 1 });
    writeFileSync(configPath(home), '{ not json');
    expect(() => loadConfig(home)).toThrow(/not valid JSON/);
    expect(new ConfigError('x')).toBeInstanceOf(LibraryError);
  });
});

describe('helpers', () => {
  it('gets, sets and unsets country', () => {
    let c = setConfigValue({ version: 1 }, 'country', 'GB');
    expect(getConfigValue(c, 'country')).toBe('gb');
    c = unsetConfigValue(c, 'country');
    expect(getConfigValue(c, 'country')).toBeUndefined();
    expect(() => setConfigValue(c, 'colour' as never, 'x')).toThrow(/Unknown setting/);
  });

  it('adds, replaces and removes sync sources', () => {
    let c: Config = { version: 1 };
    c = upsertSyncSource(c, { kind: 'plex', url: 'http://127.0.0.1:32400' });
    c = upsertSyncSource(c, { kind: 'apple-tv' });
    c = upsertSyncSource(c, { kind: 'plex', url: 'http://10.0.0.2:32400', history: true });
    expect(c.sync?.sources.map((s) => s.kind)).toEqual(['plex', 'apple-tv']);
    expect(syncSource(c, 'plex')).toMatchObject({ url: 'http://10.0.0.2:32400', history: true });
    c = removeSyncSource(c, 'plex');
    expect(syncSource(c, 'plex')).toBeUndefined();
    expect(() => removeSyncSource(c, 'jellyfin')).toThrow(/No jellyfin source/);
  });

  it('updateConfig reads, changes and writes atomically', () => {
    updateConfig(home, (c) => setConfigValue(c, 'country', 'de'));
    expect(JSON.parse(readFileSync(configPath(home), 'utf8'))).toEqual({ version: 1, country: 'de' });
  });
});
