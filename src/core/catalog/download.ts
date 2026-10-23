import { once } from 'node:events';
import { createReadStream, createWriteStream, type WriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/** The IMDb dataset files the catalog is built from. */
export const DATASETS = ['title.basics', 'title.ratings', 'title.crew', 'title.principals', 'name.basics'] as const;
export type Dataset = (typeof DATASETS)[number];

export const IMDB_DATASETS_URL = 'https://datasets.imdbws.com/';

export function datasetFile(d: Dataset): string {
  return `${d}.tsv.gz`;
}

export interface DownloadOptions {
  /** Check the server for newer copies of cached files (If-Modified-Since). */
  refresh?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (msg: string) => void;
}

export interface DownloadResult {
  file: string;
  /** The file's Last-Modified date (cached files report their recorded date). */
  lastModified: string | null;
  downloaded: boolean;
}

const MB = 1024 * 1024;
const fmtMb = (n: number) => `${(n / MB).toFixed(1)} MB`;

/** Fully gunzip a file, discarding output. Rejects on a corrupt or truncated gzip. */
async function verifyGzip(path: string): Promise<void> {
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  );
}

/**
 * Download the IMDb datasets into `cacheDir`.
 *
 * Each file streams to `<file>.part`, is verified by fully gunzipping it, gets
 * the server's Last-Modified as its mtime, and only then is renamed into
 * place. A failed or interrupted download never leaves a partial file under
 * the final name, and never replaces a previously cached copy.
 *
 * Cached files are reused as-is unless `refresh` is set; then the server is
 * asked with If-Modified-Since and the file is replaced only when the remote
 * copy is newer. Files are fetched one at a time; the first failure rejects.
 */
export async function downloadDatasets(cacheDir: string, opts: DownloadOptions = {}): Promise<DownloadResult[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = new URL(opts.baseUrl ?? IMDB_DATASETS_URL);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const progress = opts.onProgress ?? (() => {});

  mkdirSync(cacheDir, { recursive: true });
  for (const f of readdirSync(cacheDir)) {
    if (f.endsWith('.part')) rmSync(join(cacheDir, f), { force: true });
  }

  const results: DownloadResult[] = [];
  for (const d of DATASETS) {
    const file = datasetFile(d);
    const dest = join(cacheDir, file);
    const part = `${dest}.part`;
    const cachedMtime = existsSync(dest) ? statSync(dest).mtime : null;

    if (cachedMtime && !opts.refresh) {
      progress(`Using cached ${file}`);
      results.push({ file, lastModified: cachedMtime.toUTCString(), downloaded: false });
      continue;
    }

    const url = new URL(file, base).toString();
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (cachedMtime) headers['if-modified-since'] = cachedMtime.toUTCString();

    let out: WriteStream | null = null;
    try {
      progress(cachedMtime ? `Checking ${file} for updates` : `Downloading ${file}`);
      const res = await fetchImpl(url, { headers });

      if (res.status === 304 && cachedMtime) {
        await res.body?.cancel();
        progress(`${file} is up to date`);
        results.push({ file, lastModified: cachedMtime.toUTCString(), downloaded: false });
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      }

      const lmHeader = res.headers.get('last-modified');
      const lmDate = lmHeader ? new Date(lmHeader) : null;
      const remoteDate = lmDate && !Number.isNaN(lmDate.getTime()) ? lmDate : null;

      // The server ignored If-Modified-Since: skip the body unless it is newer.
      if (cachedMtime && remoteDate && remoteDate.getTime() <= cachedMtime.getTime()) {
        await res.body.cancel();
        progress(`${file} is up to date`);
        results.push({ file, lastModified: cachedMtime.toUTCString(), downloaded: false });
        continue;
      }

      const total = Number(res.headers.get('content-length')) || 0;
      let bytes = 0;
      let nextReport = 50 * MB;
      out = createWriteStream(part);
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes >= nextReport) {
              progress(`  ${file}: ${fmtMb(bytes)}${total ? ` of ${fmtMb(total)}` : ''}`);
              nextReport += 50 * MB;
            }
            yield chunk;
          }
        },
        out,
      );

      if (total && !res.headers.get('content-encoding') && bytes !== total) {
        throw new Error(`incomplete download (${bytes} of ${total} bytes)`);
      }
      try {
        await verifyGzip(part);
      } catch (err) {
        throw new Error(`downloaded file is not a complete gzip (${(err as Error).message})`, { cause: err });
      }

      const stamp = remoteDate ?? new Date();
      utimesSync(part, stamp, stamp);
      renameSync(part, dest);
      progress(`Downloaded ${file} (${fmtMb(bytes)})`);
      results.push({ file, lastModified: lmHeader && remoteDate ? lmHeader : null, downloaded: true });
    } catch (err) {
      // Let the write stream finish opening/closing first, or it can recreate the .part after removal.
      if (out && !out.closed) await once(out, 'close').catch(() => {});
      rmSync(part, { force: true });
      throw new Error(`Download of ${file} from ${url} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return results;
}
