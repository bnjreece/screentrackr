import { createRequire } from 'node:module';
import type * as SqliteModule from 'node:sqlite';

/**
 * Load node:sqlite while swallowing only its ExperimentalWarning (Node 22/23).
 * Loaded through require so the filter is in place before the module
 * initializes; a static import could emit the warning first. Every other
 * warning is passed through to Node's normal handler (stderr).
 */
function loadSqlite(): typeof SqliteModule {
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning.message;
    const type =
      typeof rest[0] === 'string'
        ? rest[0]
        : ((rest[0] as { type?: string } | undefined)?.type ??
          (typeof warning === 'string' ? undefined : warning.name));
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

export const sqlite = loadSqlite();
export type DatabaseSync = SqliteModule.DatabaseSync;
