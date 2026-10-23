// JXA script for `screentrackr import apple-tv` (experimental, macOS only).
// Run with `osascript -l JavaScript -e <this text>`. It reads the TV app's
// library in bulk (one Apple event per property, not per track), keeps only
// movies and home videos, and returns a JSON array that osascript prints to
// stdout. It never writes to the TV app.

/* global Application */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run() {
  const tv = Application('TV');
  const playlists = tv.libraryPlaylists();
  if (playlists.length === 0) return '[]';
  const tracks = tv.libraryPlaylists[0].tracks;

  const kinds = tracks.mediaKind();
  if (kinds.length === 0) return '[]';
  const names = tracks.name();
  const years = tracks.year();
  const directors = tracks.director();
  const genres = tracks.genre();
  const durations = tracks.duration();
  const plays = tracks.playedCount();
  const playedDates = tracks.playedDate();
  const ids = tracks.persistentID();
  const added = tracks.dateAdded();

  const out = [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = String(kinds[i]);
    if (kind !== 'movie' && kind !== 'home video') continue;
    out.push({
      name: names[i],
      year: years[i],
      director: directors[i],
      genre: genres[i],
      duration: durations[i],
      playedCount: plays[i],
      playedDate: playedDates[i],
      persistentID: ids[i],
      dateAdded: added[i],
      mediaKind: kind,
    });
  }
  return JSON.stringify(out);
}
