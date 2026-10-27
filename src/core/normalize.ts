/**
 * Title normalization shared by the catalog build (titles.norm_title) and
 * matching. Both sides of a comparison must go through this one function.
 *
 * - Unicode-folds and lowercases.
 * - Strips trailing edition/format/year parentheticals, e.g. "(Special Edition)",
 *   "(Director's Cut)", "(4K)", "(Unrated)", "(Theatrical)", "(Subtitled)", "(2019)".
 * - Treats "&" as "and".
 * - Drops apostrophes, turns other punctuation into spaces, collapses spaces.
 * - Drops one leading English article ("the", "a", "an") when more words follow.
 */

const EDITION_WORDS =
  /\b(?:edition|cut|uncut|extended|version|4k|uhd|hd|unrated|rated|theatrical|remaster(?:ed)?|restored|imax|3d|blu ?ray|widescreen|fullscreen|anniversary|subtitled|dubbed)\b/;

const TRAILING_GROUP = /\s*[([]([^()[\]]*)[)\]]\s*$/;
const YEAR_GROUP = /^\d{4}$/;

function isStrippableSuffix(inner: string): boolean {
  const s = inner.trim();
  return YEAR_GROUP.test(s) || EDITION_WORDS.test(s);
}

const fold = (input: string): string => input.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/**
 * Split a folded title into its base and the trailing edition/format/year
 * groups after it, innermost first. Normalization drops these groups, and
 * `titleSuffixYear` reads a year from them, so both see the same suffixes.
 * A group is only split off when some title is left before it.
 */
function splitSuffixes(folded: string): { base: string; groups: string[] } {
  let base = folded.trim();
  const groups: string[] = [];
  for (;;) {
    const m = TRAILING_GROUP.exec(base);
    if (!m || !isStrippableSuffix(m[1] ?? '')) break;
    const rest = base.slice(0, m.index).trim();
    if (!rest) break;
    groups.unshift((m[1] ?? '').trim());
    base = rest;
  }
  return { base, groups };
}

/**
 * The year a title names among its trailing suffix groups, e.g. 1978 for
 * "Title (1978)" and "Title (1978) (4K)". When several groups are years, the
 * outermost wins. Null when no trailing group is a year.
 */
export function titleSuffixYear(title: string): number | null {
  const { groups } = splitSuffixes(fold(title));
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i] as string;
    if (YEAR_GROUP.test(g)) return Number(g);
  }
  return null;
}

/**
 * The edition tags among a title's trailing suffix groups, years left out,
 * folded and with punctuation collapsed: "director s cut" for
 * "Title (Director's Cut)", "" for a bare title.
 */
export function titleEditionTag(title: string): string {
  return splitSuffixes(fold(title))
    .groups.filter((g) => !YEAR_GROUP.test(g))
    .map((g) => g.replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .join(' | ');
}

export function normalizeTitle(input: string): string {
  let s = splitSuffixes(fold(input)).base;

  s = s
    .replace(/&/g, ' and ')
    .replace(/['\u2018\u2019\u02bc`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const article = /^(?:the|a|an) (?=\S)/.exec(s);
  if (article) s = s.slice(article[0].length);
  return s;
}
