import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

/** IMDb's null marker. */
export const TSV_NULL = '\\N';

/**
 * Stream a gzipped TSV file as raw rows of fields, header row first.
 * IMDb files use no quoting: every quote is literal and fields split on tab
 * only. Trailing CR is stripped and blank lines are skipped. Rejects if the
 * file is unreadable or the gzip is corrupt or truncated.
 */
export async function* readTsvGzRows(path: string): AsyncGenerator<string[]> {
  const src = createReadStream(path);
  const gz = createGunzip();
  src.on('error', (err) => gz.destroy(err));
  src.pipe(gz);
  gz.setEncoding('utf8');

  let buf = '';
  try {
    for await (const chunk of gz as AsyncIterable<string>) {
      buf += chunk;
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf('\n', start)) !== -1) {
        let line = buf.slice(start, nl);
        start = nl + 1;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line) yield line.split('\t');
      }
      buf = buf.slice(start);
    }
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    if (buf) yield buf.split('\t');
  } finally {
    src.destroy();
    gz.destroy();
  }
}

/** A field value with `\N` mapped to null. */
export function tsvValue(v: string | undefined): string | null {
  return v === undefined || v === TSV_NULL ? null : v;
}

/**
 * Stream a gzipped TSV file as records keyed by the header row. `\N` and
 * missing trailing fields become null.
 */
export async function* readTsvGz(path: string): AsyncGenerator<Record<string, string | null>> {
  let header: string[] | null = null;
  for await (const fields of readTsvGzRows(path)) {
    if (!header) {
      header = fields;
      continue;
    }
    const rec: Record<string, string | null> = {};
    for (let i = 0; i < header.length; i++) rec[header[i] as string] = tsvValue(fields[i]);
    yield rec;
  }
}
