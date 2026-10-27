/** `screentrackr export`: the library as ScreenTrackr JSON v1 (and, in 0.4.0, Letterboxd and Trakt CSV). */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { exportLibrary } from '../../core/export.js';
import { str, type Command } from '../command.js';
import { UserError } from '../context.js';
import { safeJson } from '../sanitize.js';

export const exportCmd: Command = {
  name: 'export',
  summary: 'Export your library as ScreenTrackr JSON v1',
  usage: 'export [--out <file>]',
  details: 'Prints to stdout unless --out is given.',
  options: {
    out: { type: 'string', short: 'o', value: '<file>', description: 'Write to this file instead of stdout' },
  },
  run(ctx, pos, values) {
    if (pos.length) throw new UserError(`Unexpected argument "${pos[0]}"`);
    const data = exportLibrary(ctx.db());
    const out = str(values, 'out');
    if (!out) {
      ctx.out(safeJson(data));
      return;
    }
    const path = resolve(out);
    // Write an owner-only temp file beside the destination, then rename it over
    // the destination: an existing file never keeps wider permissions, and a
    // failed write never leaves a half-written export in its place.
    const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new UserError(`Could not write ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    ctx.emit({ path, items: data.items.length }, () => `Exported ${data.items.length} items to ${path}`);
  },
};
