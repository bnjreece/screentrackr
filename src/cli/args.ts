/** Strict converters from flag strings to typed values, with errors that name the flag. */
import { UserError } from './context.js';

export function toNumber(flag: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  const n = s === '' ? Number.NaN : Number(s);
  if (!Number.isFinite(n)) throw new UserError(`--${flag} expects a number (got "${v}")`);
  return n;
}

export function toInt(flag: string, v: string | undefined): number | undefined {
  const n = toNumber(flag, v);
  if (n !== undefined && !Number.isInteger(n)) throw new UserError(`--${flag} expects a whole number (got "${v}")`);
  return n;
}

/** `1994` or `1990-1999` (either side may be left open: `1990-` or `-1999`). */
export function toYearRange(v: string): { from?: number; to?: number } {
  const m = /^\s*(\d{4})?\s*(-)?\s*(\d{4})?\s*$/.exec(v);
  if (!m || (!m[1] && !m[3]) || (!m[2] && m[3] && m[1])) {
    throw new UserError(`--year expects a year or a range like 1990-1999 (got "${v}")`);
  }
  const from = m[1] ? Number(m[1]) : undefined;
  const to = m[3] ? Number(m[3]) : undefined;
  if (!m[2]) return { from, to: from };
  return { from, to };
}

/** A library item id: `12` or `#12`. */
export function toId(v: string | undefined, what = 'an item id'): number {
  const m = v === undefined ? null : /^#?(\d+)$/.exec(v.trim());
  if (!m) throw new UserError(`Expected ${what} (a number), got "${v ?? ''}"`);
  return Number(m[1]);
}
