/**
 * core/launchd.ts: the LaunchAgent plist and wrapper `sync launchd` prints.
 * Pure functions over invented paths; nothing is written or run.
 */
import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, isNpxPath, launchdPlan, parseEvery, shellQuote, type LaunchdInput } from '../src/core/launchd.js';
import { LibraryError } from '../src/core/library.js';

const base: LaunchdInput = {
  nodePath: '/opt/node/bin/node',
  cliPath: '/opt/node/lib/node_modules/screentrackr/dist/cli/index.js',
  home: '/home/someone/.screentrackr',
  userHome: '/home/someone',
  intervalSec: 6 * 3600,
  tokenEnvs: [],
};

describe('parseEvery', () => {
  it('reads minutes, hours and days', () => {
    expect(parseEvery('6h')).toBe(21600);
    expect(parseEvery('30m')).toBe(1800);
    expect(parseEvery('1d')).toBe(86400);
    expect(parseEvery(' 90M ')).toBe(5400);
  });
  it('refuses a bare number, a fraction, too short and too long', () => {
    for (const bad of ['6', '1.5h', '0h', '5m', '8d', 'h', '6 h', '-1h', 'often']) {
      expect(() => parseEvery(bad), bad).toThrow(LibraryError);
    }
    expect(() => parseEvery('5m')).toThrow(/at least 15 minutes/);
    expect(() => parseEvery('8d')).toThrow(/at most 7 days/);
  });
});

describe('isNpxPath', () => {
  it('spots the npx cache', () => {
    expect(isNpxPath('/home/someone/.npm/_npx/0a1b2c/node_modules/screentrackr/dist/cli/index.js')).toBe(true);
    expect(isNpxPath('C:\\home\\someone\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\screentrackr\\dist\\cli\\index.js')).toBe(true);
    expect(isNpxPath(base.cliPath)).toBe(false);
  });
});

describe('shellQuote', () => {
  it('single-quotes, escaping single quotes', () => {
    expect(shellQuote('/a b/c')).toBe("'/a b/c'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

const GOLDEN_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>org.screentrackr.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/opt/node/lib/node_modules/screentrackr/dist/cli/index.js</string>
    <string>sync</string>
    <string>--home</string>
    <string>/home/someone/.screentrackr</string>
  </array>
  <key>StartInterval</key>
  <integer>21600</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/home/someone/.screentrackr/logs/sync.log</string>
  <key>StandardErrorPath</key>
  <string>/home/someone/.screentrackr/logs/sync.log</string>
</dict>
</plist>
`;

describe('launchdPlan', () => {
  it('prints the golden plist for sources that need no token', () => {
    const plan = launchdPlan(base);
    expect(plan.label).toBe(LAUNCHD_LABEL);
    expect(plan.plist).toBe(GOLDEN_PLIST);
    expect(plan.plistPath).toBe('/home/someone/Library/LaunchAgents/org.screentrackr.sync.plist');
    expect(plan.logPath).toBe('/home/someone/.screentrackr/logs/sync.log');
    expect(plan.wrapper).toBeUndefined();
    expect(plan.steps.join('\n')).toContain("launchctl bootstrap gui/$(id -u) '/home/someone/Library/LaunchAgents/org.screentrackr.sync.plist'");
    expect(plan.steps.join('\n')).toContain("mkdir -p -m 700 '/home/someone/.screentrackr/logs'");
    expect(plan.steps.join('\n')).toContain('launchctl bootout gui/$(id -u)/org.screentrackr.sync');
    expect(plan.steps.join('\n')).toMatch(/Run `screentrackr sync` once by hand first/);
  });

  it('runs a Keychain wrapper when a source needs a token, and the wrapper reads only the Keychain', () => {
    const plan = launchdPlan({ ...base, tokenEnvs: ['PLEX_TOKEN', 'JELLYFIN_TOKEN'] });
    expect(plan.wrapperPath).toBe('/home/someone/.screentrackr/sync-launchd.sh');
    expect(plan.plist).toContain('<string>/bin/sh</string>\n    <string>/home/someone/.screentrackr/sync-launchd.sh</string>\n  </array>');
    expect(plan.plist).not.toContain('<string>sync</string>');
    expect(plan.wrapper).toBe(`#!/bin/sh
# screentrackr sync under launchd. Tokens come from your login Keychain at
# run time; this file holds none. A missing Keychain item fails only that source.
if PLEX_TOKEN=$(/usr/bin/security find-generic-password -w -s screentrackr-plex 2>/dev/null); then export PLEX_TOKEN; fi
if JELLYFIN_TOKEN=$(/usr/bin/security find-generic-password -w -s screentrackr-jellyfin 2>/dev/null); then export JELLYFIN_TOKEN; fi
exec '/opt/node/bin/node' '/opt/node/lib/node_modules/screentrackr/dist/cli/index.js' sync --home '/home/someone/.screentrackr'
`);
    const steps = plan.steps.join('\n');
    expect(steps).toContain('security add-generic-password -a "$USER" -s screentrackr-plex -w');
    expect(steps).toContain('security add-generic-password -a "$USER" -s screentrackr-jellyfin -w');
    expect(steps).toContain("chmod 700 '/home/someone/.screentrackr/sync-launchd.sh'");
  });

  it('escapes XML and shell metacharacters in paths', () => {
    const plan = launchdPlan({ ...base, home: "/home/a&b/<lib>'s", tokenEnvs: ['PLEX_TOKEN'] });
    expect(plan.plist).toContain('<string>/home/a&amp;b/&lt;lib&gt;&apos;s/sync-launchd.sh</string>');
    expect(plan.plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|apos;|quot;)/);
    expect(plan.wrapper).toContain("--home '/home/a&b/<lib>'\\''s'");
  });

  it('holds no environment value, whatever the environment holds', () => {
    const secret = 'fake-token-launchd-0003';
    const env = { PLEX_TOKEN: secret, JELLYFIN_TOKEN: secret, HOME: '/home/someone' };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const plan = launchdPlan({ ...base, tokenEnvs: ['PLEX_TOKEN', 'JELLYFIN_TOKEN'] });
      const all = [plan.plist, plan.wrapper ?? '', ...plan.steps].join('\n');
      expect(all).not.toContain(secret);
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('refuses relative paths and an unknown token variable', () => {
    expect(() => launchdPlan({ ...base, nodePath: 'node' })).toThrow(/absolute/);
    expect(() => launchdPlan({ ...base, home: '.screentrackr' })).toThrow(/absolute/);
    expect(() => launchdPlan({ ...base, tokenEnvs: ['HOME'] })).toThrow(/token variable/);
  });
});
