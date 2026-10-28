/**
 * What `screentrackr sync launchd` prints: a macOS LaunchAgent plist that
 * runs `sync` every so often, the optional wrapper that reads tokens from the
 * login Keychain, and the commands to install both. Pure: nothing here
 * writes a file, runs `launchctl` or reads the environment, so no token can
 * reach the output (the wrapper names Keychain items, never values).
 */
import { isAbsolute, join } from 'node:path';
import { LibraryError } from './errors.js';

export const LAUNCHD_LABEL = 'org.screentrackr.sync';
export const WRAPPER_FILE = 'sync-launchd.sh';
export const DEFAULT_EVERY = '6h';
const MIN_INTERVAL_SEC = 15 * 60;
const MAX_INTERVAL_SEC = 7 * 86400;

/** The token variables a wrapper may fill, and the Keychain service each one reads. */
export const KEYCHAIN_SERVICES: Record<string, string> = {
  PLEX_TOKEN: 'screentrackr-plex',
  JELLYFIN_TOKEN: 'screentrackr-jellyfin',
};

/** `--every`: a whole number of minutes, hours or days (`30m`, `6h`, `1d`), from 15 minutes to 7 days. Returns seconds. */
export function parseEvery(text: string): number {
  const m = /^(\d{1,6})([mhd])$/i.exec(text.trim());
  if (!m) throw new LibraryError(`--every expects a whole number of minutes, hours or days, such as 30m, 6h or 1d (got "${text}")`);
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const sec = n * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400);
  if (sec < MIN_INTERVAL_SEC) throw new LibraryError('--every must be at least 15 minutes');
  if (sec > MAX_INTERVAL_SEC) throw new LibraryError('--every must be at most 7 days');
  return sec;
}

/** True for a script run from npx's cache (`.../_npx/<hash>/...`), a path that changes and gets cleared. */
export function isNpxPath(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path);
}

/** One shell word: single-quoted, with single quotes escaped. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface LaunchdInput {
  /** Absolute path of the node binary. */
  nodePath: string;
  /** Absolute path of the installed CLI (dist/cli/index.js). */
  cliPath: string;
  /** Absolute data home the job syncs. */
  home: string;
  /** The user's home folder, for ~/Library/LaunchAgents. */
  userHome: string;
  intervalSec: number;
  /** Token variables the configured sources read (PLEX_TOKEN, JELLYFIN_TOKEN). With any, the plist runs the wrapper. */
  tokenEnvs: readonly string[];
  /** The command that printed this, to repeat in the steps (default `screentrackr sync launchd`). */
  rerun?: string;
}

export interface LaunchdPlan {
  label: string;
  plistPath: string;
  plist: string;
  logPath: string;
  /** Present when a source needs a token: where to save the wrapper, and its text. */
  wrapperPath?: string;
  wrapper?: string;
  /** What to run, in order, to install it (and how to remove it). */
  steps: string[];
}

export function launchdPlan(input: LaunchdInput): LaunchdPlan {
  for (const [what, p] of [
    ['node', input.nodePath],
    ['the screentrackr CLI', input.cliPath],
    ['the data home', input.home],
    ['your home folder', input.userHome],
  ] as const) {
    if (!isAbsolute(p)) throw new LibraryError(`The path of ${what} must be absolute (got "${p}")`);
  }
  if (!Number.isSafeInteger(input.intervalSec) || input.intervalSec < MIN_INTERVAL_SEC || input.intervalSec > MAX_INTERVAL_SEC) {
    throw new LibraryError('The interval must be from 15 minutes to 7 days');
  }
  for (const env of input.tokenEnvs) {
    if (!(env in KEYCHAIN_SERVICES)) throw new LibraryError(`Not a token variable sync reads: ${env}`);
  }
  const tokenEnvs = [...new Set(input.tokenEnvs)];
  const logDir = join(input.home, 'logs');
  const logPath = join(logDir, 'sync.log');
  const plistPath = join(input.userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const syncArgs = [input.nodePath, input.cliPath, 'sync', '--home', input.home];
  const wrapperPath = tokenEnvs.length ? join(input.home, WRAPPER_FILE) : undefined;
  const args = wrapperPath ? ['/bin/sh', wrapperPath] : syncArgs;

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${input.intervalSec}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  const wrapper = wrapperPath
    ? [
        '#!/bin/sh',
        '# screentrackr sync under launchd. Tokens come from your login Keychain at',
        '# run time; this file holds none. A missing Keychain item fails only that source.',
        ...tokenEnvs.map(
          (env) => `if ${env}=$(/usr/bin/security find-generic-password -w -s ${KEYCHAIN_SERVICES[env] as string} 2>/dev/null); then export ${env}; fi`,
        ),
        `exec ${shellQuote(input.nodePath)} ${shellQuote(input.cliPath)} sync --home ${shellQuote(input.home)}`,
        '',
      ].join('\n')
    : undefined;

  const rerun = input.rerun ?? 'screentrackr sync launchd';
  const steps = [
    'Run `screentrackr sync` once by hand first, so macOS can ask to allow access to the TV app (a background job cannot answer that prompt) and you can see each source work.',
    `mkdir -p -m 700 ${shellQuote(logDir)}`,
    ...(wrapperPath
      ? [
          ...tokenEnvs.map(
            (env) =>
              `security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICES[env] as string} -w   # asks for the ${env.replace('_TOKEN', '').toLowerCase()} token; it stays in your login Keychain`,
          ),
          `${rerun} --wrapper > ${shellQuote(wrapperPath)}`,
          `chmod 700 ${shellQuote(wrapperPath)}`,
        ]
      : []),
    `mkdir -p ${shellQuote(join(input.userHome, 'Library', 'LaunchAgents'))}`,
    `${rerun} > ${shellQuote(plistPath)}`,
    `launchctl bootstrap gui/$(id -u) ${shellQuote(plistPath)}`,
    `To stop it: launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
  ];
  return { label: LAUNCHD_LABEL, plistPath, plist, logPath, ...(wrapperPath ? { wrapperPath, wrapper } : {}), steps };
}
