/**
 * Generates the synthetic IMDb-shaped fixture files in test/fixtures/imdb/.
 *
 * Every title, person and ID here is made up (tt9xxxxxx / nm9xxxxxx). None of
 * it comes from IMDb. Run with:
 *
 *   node test/fixtures/make-imdb-fixtures.ts
 *
 * Output is deterministic (gzip header mtime is zero), so regenerating without
 * changes leaves the committed .gz files byte-identical.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const N = '\\N';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'imdb');

interface Person {
  nconst: string;
  name: string;
}

const people: Person[] = [
  { nconst: 'nm9000001', name: 'Dana Fincher' },
  { nconst: 'nm9000002', name: 'Denise Villeneuve' },
  { nconst: 'nm9000003', name: 'Orrin Vale' },
  { nconst: 'nm9000004', name: 'Mira Calloway' },
  { nconst: 'nm9000005', name: 'Teodor Brask' },
  { nconst: 'nm9000006', name: 'Selma Ruiz' },
  { nconst: 'nm9000011', name: 'Ash Marlow' },
  { nconst: 'nm9000012', name: 'Bea Quint' },
  { nconst: 'nm9000013', name: 'Cal Dorsey' },
  { nconst: 'nm9000014', name: 'Dee Harrow' },
  { nconst: 'nm9000015', name: 'Eli Stroud' },
  { nconst: 'nm9000016', name: 'Fay Lindqvist' },
  { nconst: 'nm9000017', name: 'Gus Okafor' },
  { nconst: 'nm9000018', name: 'Hana Weir' },
  // Referenced only as a writer: must not be loaded into people.
  { nconst: 'nm9000021', name: 'Wren Ashby' },
  // Appears only with category "self": must not be loaded.
  { nconst: 'nm9000022', name: 'Nell Tanaka' },
  // Appears only as an actor with ordering > 6: must not be loaded.
  { nconst: 'nm9000023', name: 'Otto Grieg' },
  // Appears only in a TV series: must not be loaded.
  { nconst: 'nm9000024', name: 'Pia Sorensen' },
  // Never referenced at all.
  { nconst: 'nm9000025', name: 'Quinn Abara' },
  // A person with no name (\N): never loaded even if referenced.
  { nconst: 'nm9000026', name: N },
];
// nm9000099 is referenced as a director in title.crew but is missing from
// name.basics, as happens when the files were refreshed on different days.

interface Title {
  tconst: string;
  type: string;
  title: string;
  original?: string;
  adult?: boolean;
  year: number | null;
  runtime: number | null;
  genres: string[] | null;
  directors: string[] | null;
  writers?: string[];
  cast?: string[];
  rating?: [number, number];
}

const F = 'nm9000001';
const V = 'nm9000002';
const VALE = 'nm9000003';
const CAL = 'nm9000004';
const BRASK = 'nm9000005';
const RUIZ = 'nm9000006';

const titles: Title[] = [
  // A remake pair: same title, different years and runtimes.
  { tconst: 'tt9000001', type: 'movie', title: 'The Glass Harbor', year: 1978, runtime: 112, genres: ['Drama', 'Mystery'], directors: [VALE], cast: ['nm9000011', 'nm9000012'], rating: [7.1, 5400] },
  { tconst: 'tt9000002', type: 'movie', title: 'The Glass Harbor', year: 2009, runtime: 128, genres: ['Mystery', 'Thriller'], directors: [BRASK], cast: ['nm9000013', 'nm9000014'], rating: [6.4, 22000] },
  // tt9000003 carries the full principals ladder (see principals below).
  { tconst: 'tt9000003', type: 'movie', title: 'Quiet Ledger', year: 1999, runtime: 139, genres: ['Crime', 'Drama', 'Thriller'], directors: [F], writers: ['nm9000021'], rating: [8.6, 900000] },
  { tconst: 'tt9000004', type: 'movie', title: 'Seven Lanterns', year: 1995, runtime: 117, genres: ['Crime', 'Mystery', 'Thriller'], directors: [F], cast: ['nm9000015', 'nm9000016', 'nm9000011'], rating: [8.4, 750000] },
  // Two directors.
  { tconst: 'tt9000005', type: 'movie', title: 'Salt & Signal', year: 2004, runtime: 101, genres: ['Adventure', 'Comedy'], directors: [VALE, CAL], writers: ['nm9000021'], cast: ['nm9000012', 'nm9000017'], rating: [7.0, 48000] },
  { tconst: 'tt9000006', type: 'movie', title: 'Dune Static', year: 2016, runtime: 116, genres: ['Drama', 'Mystery', 'Sci-Fi'], directors: [V], cast: ['nm9000018', 'nm9000013'], rating: [7.9, 700000] },
  { tconst: 'tt9000007', type: 'movie', title: 'Border Choir', year: 2015, runtime: 121, genres: ['Action', 'Crime', 'Thriller'], directors: [V], cast: ['nm9000016', 'nm9000014'], rating: [7.6, 450000] },
  { tconst: 'tt9000008', type: 'movie', title: 'The Missing Hour', year: 2013, runtime: 153, genres: ['Crime', 'Drama', 'Mystery'], directors: [V], cast: ['nm9000015'], rating: [8.1, 800000] },
  { tconst: 'tt9000009', type: 'movie', title: 'Paper Engine', year: 2010, runtime: 120, genres: ['Biography', 'Drama'], directors: [F], cast: ['nm9000011', 'nm9000017'], rating: [7.8, 720000] },
  { tconst: 'tt9000010', type: 'movie', title: 'Night Ferry', year: 2002, runtime: 112, genres: ['Drama', 'Thriller'], directors: [F], cast: ['nm9000012'], rating: [6.8, 210000] },
  // Original title differs from the primary title.
  { tconst: 'tt9000011', type: 'movie', title: 'The Black Lighthouse', original: 'Le Phare Noir', year: 1987, runtime: 95, genres: ['Drama'], directors: [RUIZ], cast: ['nm9000018'], rating: [7.3, 3100] },
  // Punctuation-heavy title.
  { tconst: 'tt9000012', type: 'movie', title: 'Midnight: Run - Again', year: 2021, runtime: 104, genres: ['Action', 'Comedy'], directors: [BRASK], cast: ['nm9000017', 'nm9000016'], rating: [5.9, 15000] },
  // Missing runtime.
  { tconst: 'tt9000013', type: 'movie', title: 'Orchard Lights', year: 1964, runtime: null, genres: ['Romance'], directors: [RUIZ], rating: [6.9, 1200] },
  // Missing year.
  { tconst: 'tt9000014', type: 'movie', title: 'Unfinished Atlas', year: null, runtime: 88, genres: ['Documentary'], directors: [VALE] },
  // Missing genres and no rating.
  { tconst: 'tt9000015', type: 'movie', title: 'Lost Reel', year: 1931, runtime: 71, genres: null, directors: null },
  // Director missing from name.basics (mixed dataset dates).
  { tconst: 'tt9000016', type: 'movie', title: 'Harbor Lights', year: 2019, runtime: 99, genres: ['Drama'], directors: ['nm9000099'], cast: ['nm9000013'], rating: [6.1, 900] },
  // Adult flag set.
  { tconst: 'tt9000017', type: 'movie', title: 'Velvet Hours', adult: true, year: 1979, runtime: 80, genres: ['Adult'], directors: null, rating: [4.2, 300] },
  { tconst: 'tt9000018', type: 'movie', title: 'Copper Sky', year: 2018, runtime: 109, genres: ['Sci-Fi', 'Thriller'], directors: [V], cast: ['nm9000018', 'nm9000015'], rating: [7.7, 90000] },
  { tconst: 'tt9000019', type: 'movie', title: 'Wolf Season', year: 2007, runtime: 158, genres: ['Crime', 'Drama', 'Mystery'], directors: [F], cast: ['nm9000013'], rating: [7.7, 680000] },
  { tconst: 'tt9000020', type: 'movie', title: 'A Room Downstairs', year: 2014, runtime: 149, genres: ['Drama', 'Mystery', 'Thriller'], directors: [F], cast: ['nm9000014', 'nm9000016'], rating: [8.1, 1100000] },
  { tconst: 'tt9000021', type: 'movie', title: 'Small Thunder', year: 1990, runtime: 92, genres: ['Comedy', 'Family'], directors: [CAL], cast: ['nm9000017'], rating: [6.2, 40000] },
  { tconst: 'tt9000022', type: 'movie', title: 'Iron Meadow', year: 1956, runtime: 118, genres: ['Western'], directors: [BRASK], cast: ['nm9000011'], rating: [7.4, 12000] },
  { tconst: 'tt9000023', type: 'movie', title: 'Canal Street Blues', year: 1983, runtime: 103, genres: ['Music', 'Drama'], directors: [RUIZ], rating: [6.6, 2500] },
  { tconst: 'tt9000024', type: 'movie', title: 'The Slow Planet', year: 2023, runtime: 166, genres: ['Adventure', 'Sci-Fi'], directors: [V], cast: ['nm9000018', 'nm9000012'], rating: [8.5, 600000] },
  { tconst: 'tt9000025', type: 'movie', title: 'Winter Arithmetic', year: 2011, runtime: 97, genres: ['Drama'], directors: [VALE], rating: [6.7, 800] },
  { tconst: 'tt9000026', type: 'movie', title: 'Seven Lanterns', year: 2021, runtime: 84, genres: ['Documentary'], directors: [CAL], rating: [6.0, 400] },
  { tconst: 'tt9000027', type: 'movie', title: 'Red Thread', year: 1972, runtime: 131, genres: ['Crime', 'Thriller'], directors: [BRASK], cast: ['nm9000015'], rating: [7.5, 33000] },
  { tconst: 'tt9000028', type: 'movie', title: 'Glass Animals', year: 1998, runtime: 106, genres: ['Animation', 'Family'], directors: [RUIZ, CAL], cast: ['nm9000012'], rating: [7.2, 61000] },
  { tconst: 'tt9000029', type: 'movie', title: 'The Long Field', year: 2005, runtime: 113, genres: ['Drama', 'Sport'], directors: [VALE], cast: ['nm9000017'] },
  { tconst: 'tt9000030', type: 'movie', title: 'Echo Valley', year: 2012, runtime: 125, genres: ['Horror', 'Thriller'], directors: [BRASK], cast: ['nm9000014'], rating: [5.4, 26000] },

  // Not movies: must be filtered out (the two tvMovie rows load only with includeTvMovies).
  { tconst: 'tt9100001', type: 'tvSeries', title: 'Harbor Patrol', year: 2001, runtime: 45, genres: ['Crime', 'Drama'], directors: null, cast: ['nm9000024'], rating: [7.9, 50000] },
  { tconst: 'tt9100002', type: 'tvSeries', title: 'Quiet Ledger', year: 2020, runtime: 50, genres: ['Crime'], directors: null, rating: [7.0, 8000] },
  { tconst: 'tt9100003', type: 'tvMiniSeries', title: 'Copper Sky Chronicles', year: 2022, runtime: 60, genres: ['Sci-Fi'], directors: null, rating: [6.5, 3000] },
  { tconst: 'tt9200001', type: 'tvMovie', title: 'Holiday Signal', year: 2017, runtime: 86, genres: ['Comedy', 'Romance'], directors: [RUIZ], cast: ['nm9000016'], rating: [6.3, 2000] },
  { tconst: 'tt9200002', type: 'tvMovie', title: 'The Glass Harbor Reunion', year: 2011, runtime: 90, genres: ['Documentary'], directors: [VALE], rating: [5.8, 700] },
  { tconst: 'tt9300001', type: 'tvEpisode', title: 'Pilot', year: 2001, runtime: 44, genres: ['Crime'], directors: [F], cast: ['nm9000024'] },
  { tconst: 'tt9400001', type: 'short', title: 'Tiny Ledger', year: 1999, runtime: 9, genres: ['Short'], directors: [F] },
];

function tsv(header: string[], rows: (string | number | null)[][]): Buffer {
  const lines = [header.join('\t')];
  for (const r of rows) lines.push(r.map((v) => (v === null ? N : String(v))).join('\t'));
  return gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { level: 9 });
}

const csv = (xs: string[] | null | undefined) => (xs && xs.length ? xs.join(',') : null);

const basics = tsv(
  ['tconst', 'titleType', 'primaryTitle', 'originalTitle', 'isAdult', 'startYear', 'endYear', 'runtimeMinutes', 'genres'],
  titles.map((t) => [
    t.tconst,
    t.type,
    t.title,
    t.original ?? t.title,
    t.adult ? 1 : 0,
    t.year,
    t.type === 'tvSeries' ? 2005 : null,
    t.runtime,
    csv(t.genres),
  ]),
);

const ratingRows: (string | number | null)[][] = titles
  .filter((t) => t.rating)
  .map((t) => [t.tconst, (t.rating as [number, number])[0].toFixed(1), (t.rating as [number, number])[1]]);
// A rating for a title absent from title.basics (newer ratings file).
ratingRows.push(['tt9999999', '9.9', 12]);
const ratings = tsv(['tconst', 'averageRating', 'numVotes'], ratingRows);

const crew = tsv(
  ['tconst', 'directors', 'writers'],
  titles.map((t) => [t.tconst, csv(t.directors), csv(t.writers)]),
);

const principalRows: (string | number | null)[][] = [];
for (const t of titles) {
  (t.cast ?? []).forEach((n, i) => {
    principalRows.push([t.tconst, i + 1, n, i % 2 ? 'actress' : 'actor', null, `["Role ${i + 1}"]`]);
  });
}
// Orderings 1 to 10 on tt9000003, mixing categories.
principalRows.push(
  ['tt9000003', 1, 'nm9000011', 'actor', null, '["Lead"]'],
  ['tt9000003', 2, 'nm9000012', 'actress', null, '["Partner"]'],
  ['tt9000003', 3, 'nm9000013', 'actor', null, null],
  ['tt9000003', 4, 'nm9000022', 'self', null, '["Herself"]'],
  ['tt9000003', 5, 'nm9000014', 'actress', null, null],
  ['tt9000003', 6, 'nm9000015', 'actor', null, null],
  ['tt9000003', 7, F, 'director', null, null],
  ['tt9000003', 8, 'nm9000023', 'actor', null, null],
  ['tt9000003', 9, 'nm9000021', 'writer', 'screenplay', null],
  ['tt9000003', 10, 'nm9000026', 'actress', null, null],
);
principalRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));
const principals = tsv(['tconst', 'ordering', 'nconst', 'category', 'job', 'characters'], principalRows);

const names = tsv(
  ['nconst', 'primaryName', 'birthYear', 'deathYear', 'primaryProfession', 'knownForTitles'],
  people.map((p) => [p.nconst, p.name === N ? null : p.name, null, null, null, null]),
);

mkdirSync(OUT, { recursive: true });
const files: Record<string, Buffer> = {
  'title.basics.tsv.gz': basics,
  'title.ratings.tsv.gz': ratings,
  'title.crew.tsv.gz': crew,
  'title.principals.tsv.gz': principals,
  'name.basics.tsv.gz': names,
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(OUT, name), buf);
process.stderr.write(`Wrote ${Object.keys(files).length} fixture files to ${OUT}\n`);
