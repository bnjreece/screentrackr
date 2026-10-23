import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { catalogReady } from '../../core/db.js';
import { readAppleTvLibrary } from '../../core/importers/apple-tv.js';
import { applyImport, FORMATS, parseImportDetailed, type ImportFormat, type ParsedImport } from '../../core/importers/index.js';
import { bool, str, type Command } from '../command.js';
import { UserError } from '../context.js';

export const importCmd: Command = {
  name: 'import',
  summary: 'Bring in a library file (merge by default)',
  usage: 'import <file|apple-tv> [--format <format>] [--merge | --replace]',
  details: `Formats: ${FORMATS.join(', ')}. The format is detected when --format is omitted.\n\`import apple-tv\` (experimental, macOS only) reads the TV app's library directly. Movies with a recorded play date are marked watched; the rest keep their current status.\n--merge adds new movies and updates fields the file has; it never clears a status or rating the file lacks. A record that fits more than one item is not imported and is listed with the candidate item ids.\n--replace backs up your library to backups/ first, then replaces it.`,
  options: {
    format: { type: 'string', value: '<format>', description: `One of ${FORMATS.join(', ')}` },
    merge: { type: 'boolean', description: 'Merge into the library (the default)' },
    replace: { type: 'boolean', description: 'Replace the library, after a backup' },
    timeout: { type: 'string', value: '<seconds>', description: 'apple-tv only: how long to wait for the TV app (default 120)' },
  },
  async run(ctx, pos, values) {
    const file = pos[0];
    if (!file) throw new UserError('Usage: screentrackr import <file>');
    if (pos.length > 1) throw new UserError(`Unexpected argument "${pos[1]}"`);
    if (bool(values, 'merge') && bool(values, 'replace')) throw new UserError('Use either --merge or --replace, not both');
    const format = str(values, 'format');
    const timeout = str(values, 'timeout');
    const appleTv = file === 'apple-tv';
    if (appleTv && format !== undefined) throw new UserError('--format does not apply to `import apple-tv`');
    if (!appleTv && timeout !== undefined) throw new UserError('--timeout only applies to `import apple-tv`');
    if (format !== undefined && !(FORMATS as readonly string[]).includes(format)) {
      throw new UserError(`Unknown format "${format}" (expected ${FORMATS.join(', ')})`);
    }
    let timeoutMs: number | undefined;
    if (timeout !== undefined) {
      const secs = Number(timeout);
      if (!Number.isFinite(secs) || secs <= 0) throw new UserError(`--timeout must be a positive number of seconds (got "${timeout}")`);
      timeoutMs = Math.round(secs * 1000);
    }

    let parsed: ParsedImport & { format: ImportFormat | 'apple-tv' };
    if (appleTv) {
      ctx.log('Reading the TV app library (experimental). macOS may ask to allow access to the TV app.');
      parsed = { format: 'apple-tv', records: await readAppleTvLibrary({ timeoutMs }), warnings: [] };
    } else {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        throw new UserError(`Could not read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
      parsed = parseImportDetailed(text, format as ImportFormat | undefined, basename(file));
    }

    const db = ctx.db();
    for (const w of parsed.warnings) ctx.log(`Warning: ${w}`);
    if (!catalogReady(db)) ctx.log('The catalog is not built yet, so movies are left unmatched. Run `screentrackr setup` to match them.');
    const summary = applyImport(db, parsed.records, { mode: bool(values, 'replace') ? 'replace' : 'merge' });

    ctx.emit({ format: parsed.format, records: parsed.records.length, warnings: parsed.warnings, ...summary }, () =>
      [
        `Imported ${parsed.records.length} records (${parsed.format}).`,
        `Added ${summary.added}, updated ${summary.updated}, unchanged ${summary.unchanged}, needs review ${summary.needsReview}.`,
        summary.backupPath ? `Backup of the previous library: ${summary.backupPath}` : '',
        summary.reviews.length
          ? [
              `Not imported, ${summary.reviews.length} record${summary.reviews.length === 1 ? '' : 's'} that could be more than one item (nothing was changed):`,
              ...summary.reviews.map(
                (v) => `  record ${v.record} "${v.sourceTitle}": items ${v.candidateIds.join(', ')}`,
              ),
              'Add a year, runtime or IMDb id to those records to pick one item, or update the item with `screentrackr set <id>`.',
            ].join('\n')
          : '',
        summary.needsReview ? 'Run `screentrackr match --review` to see the movies that need review.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
};
