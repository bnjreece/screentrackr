/**
 * An invented Trakt "Raw export", file by file, in the shapes Trakt writes
 * (one JSON array per page). Every title, person, username and id is made up;
 * none of it comes from a real export. Tests write these to a temp folder or
 * pack them into a ZIP.
 */

const movie = (trakt: number, title: string, year: number | null, imdb: string | null = null) => ({
  title,
  year,
  ids: { trakt, slug: title.toLowerCase().replace(/\W+/g, '-'), imdb, tmdb: imdb ? 7000 + trakt : null },
});

export const GLASS = movie(101, 'The Glass Harbor', 1978, 'tt9000001');
export const SALT = movie(102, 'Salt & Signal', 2004, 'tt9000005');
export const DUNE = movie(103, 'Dune Static', 2016, 'tt9000006');
export const LANTERN = movie(104, 'Lantern Road', 2011);
export const ORCHARD = movie(105, 'The Quiet Orchard', null);
export const COMETS = movie(106, 'Paper Comets', 1994);
export const COPPER = movie(107, 'Copper Tide', 1999);

const show = { title: 'Harbor Patrol', year: 2001, ids: { trakt: 4001, slug: 'harbor-patrol' } };

/** The files of a complete export, by name, as values to JSON.stringify. */
export function exportFiles(): Record<string, unknown> {
  return {
    'watched-history.json': [
      { id: 9001, watched_at: '2024-02-10T03:30:00.000Z', action: 'watch', type: 'movie', movie: GLASS },
      { id: 9002, watched_at: '2023-05-01T20:00:00.000Z', action: 'scrobble', type: 'movie', movie: GLASS },
      {
        id: 9003,
        watched_at: '2022-08-14T19:00:00.000Z',
        action: 'checkin',
        type: 'episode',
        episode: { season: 1, number: 1, title: 'Pilot', ids: { trakt: 5001 } },
        show,
      },
      { id: 9004, watched_at: '2021-01-05T21:00:00.000Z', action: 'watch', type: 'movie', movie: null },
    ],
    // Page 2 repeats a play from page 1 (the export can over-fetch).
    'watched-history-2.json': [
      { id: 9002, watched_at: '2023-05-01T20:00:00.000Z', action: 'scrobble', type: 'movie', movie: GLASS },
      { id: 9005, watched_at: '1970-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: COMETS },
    ],
    'watched-movies.json': [
      { plays: 2, last_watched_at: '2024-02-10T03:30:00.000Z', last_updated_at: '2024-02-10T03:30:00.000Z', movie: GLASS },
      { plays: 1, last_watched_at: '2015-06-01T12:00:00.000Z', last_updated_at: '2015-06-01T12:00:00.000Z', movie: ORCHARD },
    ],
    'ratings-movies.json': [
      { rated_at: '2024-02-11T09:00:00.000Z', rating: 8, type: 'movie', movie: GLASS },
      { rated_at: '2023-03-03T09:00:00.000Z', rating: 9, type: 'movie', movie: DUNE },
      { rated_at: '2023-03-04T09:00:00.000Z', rating: 11, type: 'movie', movie: COPPER },
    ],
    'lists-watchlist.json': [
      { rank: 1, id: 8001, listed_at: '2024-01-01T10:00:00.000Z', notes: 'Ask Mira about this one', type: 'movie', movie: SALT },
      { rank: 2, id: 8002, listed_at: '2024-01-02T10:00:00.000Z', notes: null, type: 'movie', movie: GLASS },
      { rank: 3, id: 8003, listed_at: '2024-01-03T10:00:00.000Z', notes: null, type: 'show', show },
    ],
    'collection-movies.json': [
      {
        collected_at: '2020-12-24T18:00:00.000Z',
        updated_at: '2020-12-24T18:00:00.000Z',
        movie: LANTERN,
        metadata: { media_type: 'bluray', resolution: 'hd_1080p', hdr: null, audio: 'dts', audio_channels: '5.1', '3d': false },
      },
    ],
    // Never read: personal data, other people, lists and paused progress.
    'user-settings.json': {
      user: { username: 'orrin-vale', name: 'Orrin Vale', location: 'Glass Harbor', birthday: '1970-01-01', email: 'orrin@example.invalid' },
    },
    'network-followers.json': [{ followed_at: '2020-01-01T00:00:00.000Z', user: { username: 'mira-calloway', name: 'Mira Calloway' } }],
    'lists-lists.json': [{ name: 'Lighthouse films', ids: { trakt: 3001, slug: 'lighthouse-films' } }],
    'watched-playback.json': [{ progress: 40.5, paused_at: '2024-03-01T00:00:00.000Z', type: 'movie', movie: COPPER }],
  };
}

/** Serialize a file map to name to bytes. A string value is written as is (for broken files). */
export function toBytes(files: Record<string, unknown>): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(files).map(([name, v]) => [name, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8')]));
}

export { makeZip } from './make-zip.js';
