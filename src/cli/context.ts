/**
 * What every command receives: the data home, output mode and streams, and a
 * lazily opened database. Commands print through `emit` so `--json` gives
 * machine-readable output everywhere.
 */
import { openDb, type Db } from '../core/db.js';
import { safeJson, sanitizeTerminal } from './sanitize.js';

/** A problem with what the user asked for. Exits 1. `details` is added to the `--json` error object. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export interface Ctx {
  home: string;
  json: boolean;
  /** True when stdout is a terminal. */
  tty: boolean;
  /** True when headers may be styled (a TTY, NO_COLOR unset, TERM not dumb). */
  color: boolean;
  /** Terminal width for tables, or undefined to never truncate (pipes, files). */
  width: number | undefined;
  db(): Db;
  /** Write a line (or lines) to stdout. */
  out(text: string): void;
  /** Write a progress or notice line to stderr. Never stdout. */
  log(text: string): void;
  /** Print `data` as JSON in `--json` mode, otherwise the text from `text()`. */
  emit(data: unknown, text: () => string): void;
  close(): void;
}

export function createCtx(opts: { home: string; json: boolean }): Ctx {
  const stdout = process.stdout;
  const tty = Boolean(stdout.isTTY);
  const color = tty && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  let db: Db | null = null;
  const out = (text: string) => {
    const safe = sanitizeTerminal(text);
    stdout.write(safe.endsWith('\n') ? safe : `${safe}\n`);
  };
  return {
    home: opts.home,
    json: opts.json,
    tty,
    color,
    width: tty && stdout.columns ? stdout.columns : undefined,
    db() {
      db ??= openDb(opts.home);
      return db;
    },
    out,
    log(text) {
      const safe = sanitizeTerminal(text);
      process.stderr.write(safe.endsWith('\n') ? safe : `${safe}\n`);
    },
    emit(data, text) {
      if (opts.json) out(safeJson(data));
      else {
        const t = text();
        if (t) out(t);
      }
    },
    close() {
      db?.close();
      db = null;
    },
  };
}
