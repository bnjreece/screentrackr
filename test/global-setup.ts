/**
 * Builds dist/ once before the suite, so tests that spawn the real CLI
 * (`node dist/cli/index.js`) never run against a stale build. It runs
 * `npm run build` (via `node --run`), so dist/ matches what gets published.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // The package's own build script (tsc plus copying the Apple TV JXA script).
  execFileSync(process.execPath, ['--run', 'build'], { cwd: root, stdio: 'inherit' });
}
