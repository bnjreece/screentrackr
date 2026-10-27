/** Every file under a folder, keyed by its path under `prefix`, ready for makeZip (test/fixtures/make-zip.ts). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function folderFiles(dir: string, prefix = '', transform: (text: string) => string = (t) => t): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (rel: string) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p);
      else out[prefix + p] = Buffer.from(transform(readFileSync(join(dir, p), 'utf8')), 'utf8');
    }
  };
  walk('');
  return out;
}
