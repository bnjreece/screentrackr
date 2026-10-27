#!/usr/bin/env node
/**
 * The screentrackr command line. Parses arguments, dispatches to a command,
 * and maps errors to exit codes: 0 success, 1 a user error (bad input, a
 * missing item, an ambiguous title, no catalog yet), 2 anything unexpected.
 */
import { readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { resolveHome } from '../core/home.js';
import { LibraryError } from '../core/library.js';
import type { Command, OptionSpec, Values } from './command.js';
import { doctor } from './commands/doctor.js';
import { importCmd } from './commands/import.js';
import { add, link, remove, set, show } from './commands/items.js';
import { exportCmd } from './commands/export.js';
import { match } from './commands/library.js';
import { stats } from './commands/stats.js';
import { mcp } from './commands/mcp.js';
import { search } from './commands/search.js';
import { setup } from './commands/setup.js';
import { createCtx, UserError, type Ctx } from './context.js';
import { safeJson, sanitizeTerminal } from './sanitize.js';

export const COMMANDS: Command[] = [setup, importCmd, search, show, add, remove, set, match, link, stats, exportCmd, mcp, doctor];

const GLOBAL: Record<string, OptionSpec> = {
  home: { type: 'string', value: '<dir>', description: 'Data directory (default $SCREENTRACKR_HOME or ~/.screentrackr)' },
  json: { type: 'boolean', description: 'Machine-readable JSON output' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  version: { type: 'boolean', short: 'v', description: 'Print the version' },
};

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function optionHelp(options: Record<string, OptionSpec>): string {
  const rows = Object.entries(options).map(([name, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.value ? ` ${o.value}` : ''}`;
    return [flag, o.description] as const;
  });
  const w = Math.max(...rows.map(([f]) => f.length));
  return rows.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`).join('\n');
}

function mainHelp(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'screentrackr: your movie library and the IMDb catalog, from the terminal.',
    '',
    'Usage: screentrackr <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`),
    '',
    'Global options:',
    optionHelp(GLOBAL),
    '',
    'Run `screentrackr <command> --help` for a command\'s options.',
  ].join('\n');
}

function commandHelp(c: Command): string {
  return [
    `Usage: screentrackr ${c.usage}`,
    '',
    c.summary + '.',
    ...(c.details ? ['', c.details] : []),
    ...(Object.keys(c.options).length ? ['', 'Options:', optionHelp(c.options)] : []),
    '',
    'Global options:',
    optionHelp(GLOBAL),
  ].join('\n');
}

function toParseConfig(options: Record<string, OptionSpec>): NonNullable<ParseArgsConfig['options']> {
  return Object.fromEntries(
    Object.entries(options).map(([name, o]) => [
      name,
      { type: o.type, ...(o.multiple ? { multiple: true } : {}), ...(o.short ? { short: o.short } : {}) },
    ]),
  );
}

/** Find the command name: the first positional that isn't a global option's value. */
function findCommand(argv: string[]): { name: string | undefined; index: number } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') return { name: argv[i + 1], index: i + 1 };
    if (a === '--home') {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { name: a, index: i };
  }
  return { name: undefined, index: -1 };
}

function isParseError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

function reportError(ctx: Ctx | null, json: boolean, err: unknown): number {
  const user = err instanceof UserError || err instanceof LibraryError || isParseError(err);
  const message = err instanceof Error ? err.message : String(err);
  const code = user ? 1 : 2;
  if (json) {
    const details = err instanceof UserError ? err.details : undefined;
    process.stdout.write(
      `${safeJson({ error: { message, type: user ? 'user' : 'unexpected', ...(err instanceof Error ? { name: err.name } : {}), ...details } })}\n`,
    );
  }
  if (user) process.stderr.write(`Error: ${sanitizeTerminal(message)}\n`);
  else {
    process.stderr.write(`Unexpected error: ${sanitizeTerminal(message)}\n`);
    if (process.env.SCREENTRACKR_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${sanitizeTerminal(err.stack)}\n`);
    else process.stderr.write('Set SCREENTRACKR_DEBUG=1 for details.\n');
  }
  ctx?.close();
  return code;
}

function findCommandSafe(argv: string[]): string | undefined {
  try {
    return findCommand(argv).name;
  } catch {
    return undefined;
  }
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  let ctx: Ctx | null = null;
  try {
    const { name, index } = findCommand(argv);
    const command = name === undefined ? undefined : COMMANDS.find((c) => c.name === name);

    if (name !== undefined && !command) {
      throw new UserError(`Unknown command "${name}". Run \`screentrackr --help\` for the list.`);
    }

    const rest = index >= 0 ? [...argv.slice(0, index), ...argv.slice(index + 1)] : argv;
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...toParseConfig(GLOBAL), ...(command ? toParseConfig(command.options) : {}) },
      allowPositionals: true,
      strict: true,
    });
    const v = values as Values;

    if (v.version) {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    if (v.help || !command) {
      process.stdout.write(`${command ? commandHelp(command) : mainHelp()}\n`);
      return v.help ? 0 : 1;
    }

    ctx = createCtx({ home: resolveHome(typeof v.home === 'string' ? v.home : undefined), json: v.json === true });
    await command.run(ctx, positionals, v);
    ctx.close();
    return 0;
  } catch (err) {
    // In `mcp` mode stdout belongs to JSON-RPC, so errors only go to stderr.
    const mcp = findCommandSafe(argv) === 'mcp';
    return reportError(ctx, json && !mcp, err);
  }
}

process.exitCode = await main(process.argv.slice(2));
