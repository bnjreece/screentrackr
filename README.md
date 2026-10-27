# screentrackr

Ask your movie library real questions from the terminal: "Fincher or Villeneuve, a thriller, IMDb 7.5 or better, not watched yet, under two hours." screentrackr is a free, local command line tool and MCP server. It keeps your library (what you own, what you've watched, your ratings) next to a full movie catalog that it builds on your machine from IMDb's public datasets. You query both with the same filters, from a shell or through Claude Code or any other MCP client. No accounts, no API keys, no Docker and no hosted service.

## Install

You need Node.js 22.13 or newer.

```sh
npx screentrackr setup
```

`setup` downloads IMDb's dataset files (about 1 GB, cached in `~/.screentrackr/cache/`) and builds the catalog: every movie's title, year, runtime, genres, directors, top-billed cast, IMDb rating and votes. Expect it to take several minutes. Run `npx screentrackr setup --refresh` later to pick up newer data. Add `--no-cast` for a faster, smaller build without cast.

To install it globally instead:

```sh
npm install -g screentrackr
screentrackr setup
```

Everything lives in `~/.screentrackr/`: the database `screentrackr.db`, the download `cache/`, and `backups/`. Set `SCREENTRACKR_HOME` or pass `--home <dir>` to use another folder.

## Import your library

You can search the catalog without a library, but screentrackr is most useful once it knows your movies. Each import matches your movies to IMDb ids so the filters run on real fields. You can bring movies in from an Apple TV paste or the TV app, a CSV file, IMDb, Letterboxd or Trakt exports, or your own Plex or Jellyfin server. The export imports only read files you downloaded; Plex and Jellyfin talk only to your own server (see [Privacy](#privacy)). Review the ones it couldn't place with `screentrackr match --review` and fix them with `screentrackr link <id> <tconst>`.

### Apple TV (copy and paste)

1. Open the Apple TV app on a Mac and go to your movie library.
2. Switch the library to list view, so you see columns for title, time, director, genre and so on.
3. Click a row, press Command-A to select every movie, then Command-C to copy.
4. Save what you copied to a file and import it:

```sh
pbpaste > apple-tv.txt
screentrackr import apple-tv.txt
```

The paste is tab-separated text. If the first line names the columns, they're read by name in any order; otherwise screentrackr expects the TV app's usual layout: title, (empty), duration, director, collection, genre, owned.

### Apple TV on macOS (experimental)

```sh
screentrackr import apple-tv
```

This reads the TV app's library directly through JavaScript for Automation. macOS asks once for permission to control the TV app. Movies with a recorded play date are marked watched; nothing else about a movie's status or rating changes. The TV app's year is the year of the edition it sells (a restoration can show a year decades after the film), so it is only used to rule out films made after it and is never saved as the movie's year: movies are matched on title, director and runtime, and an edition tag such as "(Director's Cut)" or ": The Ultimate Edition" is ignored. Movies you already have, by IMDb link or by title, director and runtime, get the TV app's id instead of a duplicate. It's experimental: large libraries can be slow, and if the TV app times out the command fails and tells you so (raise the wait with `--timeout <seconds>`). The copy and paste route above always works.

### CSV

A CSV file with a header row. Recognized columns, in any order and case:

| Column | Meaning |
|---|---|
| `title` | Required |
| `year` | Release year, helps matching |
| `director` | Director name(s), helps matching |
| `status` | `queue`, `priority`, `someday` or `watched` |
| `rating` | Your rating, a whole number from 1 to 10 |
| `imdb_id` | An IMDb id such as `tt1234567`, the strongest match hint |

Optional columns: `runtime`, `genre`, `collection`, `owned`, `watched_at`. Others are ignored.

```csv
title,year,director,status,rating,imdb_id
The Example Heist,2011,Jane Doe,watched,8,
Another Made-Up Movie,,,priority,,tt9000001
```

### IMDb (CSV export)

IMDb lets you download your ratings, your watchlist, your check-ins and each of your lists as CSV files. Sign in on imdb.com in a desktop browser, open Your Ratings (or the watchlist, check-ins or a list) and click the Export icon at the top right. IMDb prepares the file in the background: download it from [imdb.com/exports](https://www.imdb.com/exports/) once it is no longer "in progress". A file stays there for 4 weeks; if it has expired, export again. screentrackr only reads the files you download. It never signs in to IMDb or fetches anything from imdb.com.

```sh
screentrackr import imdb imdb-ratings.csv imdb-watchlist.csv
```

- **Ratings** (the file with `Your Rating` and `Date Rated` columns): each movie is marked watched with your rating, a whole number from 1 to 10. The date you rated it is not used as a watch date.
- **List exports** (watchlist, check-ins and custom lists share one layout, and the file doesn't say which it is). Pass `--as` to say: `--as watchlist` (the default, with a notice) puts movies you don't have yet in the queue and never changes the status of a movie you already have, so a watched movie stays watched. `--as checkins` marks movies watched; add `--checkin-dates` to use each check-in's date as the watched date. `--as list` sets no status; add `--collection <name>` to name the list's collection. A rated movie in any list is marked watched with that rating. A list row's Description (your note on it) is dropped unless you add `--notes-from-description`, which uses it as the movie's notes when the movie has none.
- IMDb has no idea of what you own, so a new movie from IMDb is not marked owned and a movie you already have keeps its owned flag. Title, year, directors and genres only fill fields a movie you already have left blank; they never replace what your other imports said.
- Only rows whose Title Type is Movie come in (and TV Movie, when you built the catalog with `--include-tv-movies`). TV series, episodes, shorts and the rest are skipped and counted; `--include-type short,video` (also `tvMovie`, `tvSpecial`, `tvShort`) brings those in, unmatched.
- Each row's IMDb id decides the match: the catalog's movie when the catalog has that id, otherwise the movie stays unmatched (keeping the id) rather than being matched to another title by name. The id is kept with the movie, so a later `setup`, `match` or restore from an export keeps to it too. The runtime in the file depends on your location, so it is ignored. IMDb's own rating, votes and release date are never stored, and neither is a list's description unless you ask for it with `--notes-from-description`.
- Several files are read together, so a movie that is both rated and on your watchlist becomes one movie, watched. A rating overwrites the rating a movie had, so importing a newer export updates your ratings; importing the same files again changes nothing.
- A ratings or list export passed to plain `screentrackr import` is recognized too (a list is then read as a watchlist). Files saved again in a spreadsheet are read as well: semicolons, Windows-1252 text and day-first or month-first dates. The pre-2018 export format is refused with a message.

### Letterboxd (export ZIP)

Letterboxd lets every member download their own data. Sign in on letterboxd.com, open Settings, then Data, and choose Export your data. You get a ZIP of CSV files. screentrackr only reads that ZIP (or the folder it unzips to). It never signs in to Letterboxd, never uses its API and never fetches anything from letterboxd.com.

```sh
screentrackr import letterboxd letterboxd-yourname-2026-01-01-00-00-utc.zip
```

- Films in `watched.csv` or `ratings.csv`, or with a diary entry, are marked watched. Watchlist films go in the queue only when they are new, so a movie you already have keeps its status and a watched movie stays watched. `--no-watchlist` leaves the watchlist out.
- Ratings are half stars from 0.5 to 5, stored times two as 1 to 10 (Letterboxd's own 10-point scale), so 3.5 stars is a 7. `ratings.csv` wins; only a film with no row there takes the rating of its latest diary entry (none if that entry has none). A rating overwrites the rating a movie had, so importing a newer export updates your ratings.
- The watched date (and the era) is the latest Watched Date in your diary, and it replaces the watched date a movie had. The date a film was added to `watched.csv` is when you logged it, so it is not used. If you delete a film's diary entries on Letterboxd, importing a newer export clears the date an earlier Letterboxd import set; a date you set yourself, or another import set, is kept. Importing loose CSV files without `diary.csv` never clears a date.
- The export doesn't say what you own, so a new movie from Letterboxd is not marked owned and a movie you already have keeps its owned flag. If you keep a list of the films you own, name it: `--owned-list my-blu-rays` (the list's file name in the export's `lists` folder, repeatable) marks its films owned. No other list is read.
- `--with-reviews` takes your latest review of each film, as plain text, as its notes, only for movies with no notes yet. Reviews are matched to diary entries by the entry's own link.
- Each film's Letterboxd link (`https://boxd.it/...`) is kept as its `letterboxd` id, so importing the same export again changes nothing. Title and year only fill fields a movie you already have left blank.
- The export has no IMDb ids, so films are matched by title and year. Films the movie catalog doesn't have (TV miniseries, for one) stay unmatched and show up in `screentrackr match --review`. Diary entries for films Letterboxd removed (`orphaned/`) and things you deleted (`deleted/`) are skipped and counted. `profile.csv`, `comments.csv` and your likes are never opened.
- The CSV files work on their own too (`screentrackr import letterboxd watched.csv ratings.csv diary.csv`), and plain `screentrackr import` recognizes the ZIP, the folder and each file. Keep the export's file names: `watched.csv` and `watchlist.csv` have the same columns, and `import letterboxd` decides from the names alone which files to open, so `screentrackr import letterboxd export/*.csv` opens only `watched.csv`, `ratings.csv`, `diary.csv`, `watchlist.csv`, `reviews.csv` (with `--with-reviews`) and the lists you name (from the `lists` folder), never a file in `deleted/`, `orphaned/` or `likes/`.

### Trakt (data export)

Trakt lets you download all your data as one ZIP. Sign in on [app.trakt.tv](https://app.trakt.tv), open Settings, then Data, and click Export now next to Raw export. The browser downloads `trakt-export-<username>.zip`. It needs no VIP account. screentrackr reads the ZIP (or the folder you unzip it to, or single files from it) and never contacts Trakt: there is no Trakt sign-in, app key or API sync in this release.

```sh
screentrackr import trakt trakt-export-yourname.zip
```

- Only these files are read: `watched-history`, `watched-movies`, `ratings-movies`, `lists-watchlist` and `collection-movies` (each also split into numbered pages), plus `_errors.json`. Everything else in the export, such as your account settings, the people you follow, comments, lists, paused playback and TV, is never opened. Only movies come in; TV rows are skipped and counted.
- **Watched:** a movie with any play in your history is marked watched, with the latest play's date (in your local time zone) and its era. Plays Trakt has with no real date (at 1970 or before 1900) are watched with no date. When 10 or more plays share the same second, they were logged in bulk ("I've seen these"), so they keep watched but lose the date; `--keep-bulk-dates` keeps those dates. If an earlier, smaller export gave Trakt dates to plays that a fuller export now shows were logged in bulk, importing the fuller one clears those dates (and the era they set); it never clears a date you set yourself or another source set. A date imported before this release has no record of its source, so it is not cleared.
- **Watchlist:** movies you don't have yet go in the queue; a movie you already have keeps its status, so a watched movie stays watched. A watched play beats the watchlist. Watchlist notes only fill an empty note.
- **Ratings:** each movie gets your rating, a whole number from 1 to 10. A rating alone never marks a movie watched, so a new movie that is only rated (or only collected) arrives in the queue, and one you have keeps its status.
- **Owned:** only your Trakt collection marks a movie owned. Nothing else in the export changes whether a movie is owned, and a new movie that is not in your collection is not owned.
- All rows for one movie, across every file and page, become one movie. Trakt's movie id is kept, so importing a newer export updates the same movies, and importing the same export again changes nothing. Trakt's IMDb id is a match hint, checked against the catalog; the title and year only fill blanks. No Trakt catalog data (overviews, images, genres) is stored.
- If the export could not fetch everything, Trakt lists that in `_errors.json`. Every entry is shown as a warning, saying which part (history, ratings, watchlist, collection) is incomplete, and so is a damaged file. Movies missing from it are left as they are.
- Only movie history, ratings, watchlist, collection and `_errors.json` are read. A plain `screentrackr import` of the export ZIP or one of those files goes through the same reader; the export's other files (account settings, people you follow, comments, lists, TV) are refused by name and never opened.
- A Trakt import only merges. An export can't show that it is complete (a missing file may mean you have none, or that it failed), so `--replace` is refused.
- Single files are read only under their export names (such as `ratings-movies.json`), also by plain `screentrackr import`.

### Plex Media Server

screentrackr can read the movie libraries of your own Plex Media Server through its local API. It only reads: it never changes anything on the server, never asks it to refresh, analyze or check files, and pages its requests gently.

```sh
export PLEX_TOKEN=...   # your token; see below
screentrackr import plex --url http://127.0.0.1:32400 --dry-run
screentrackr import plex --url http://127.0.0.1:32400
```

- **Token.** Find yours with Plex's article [Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) (open a movie in Plex Web, choose Get Info, then View XML, and copy `X-Plex-Token` from the address). Pass it in the `PLEX_TOKEN` environment variable, or pipe it in with `--token-stdin`. It is never taken as a command line argument, never put in a URL, never stored and never printed. The MCP server has no Plex tool, so an AI client never sees it.
- **Server.** `--url` is your server's address (default `http://127.0.0.1:32400`). If the server requires secure connections, use its `https://….plex.direct:32400` address. The URL must not carry a token or a password, and redirects are refused.
- **Libraries.** Every movie library is read, except "Other Videos" libraries (`--include-other-videos` adds them). `--section <name|key>` (repeatable) reads only the libraries you name. TV libraries are never read.
- **What comes in.** Every movie on the server is marked owned. A movie Plex counts as played is marked watched, with its last play date. When one day holds at least 3 of those dates and more than a fifth of them, as after a bulk "mark as watched", that day's dates are left out. A date an earlier import already stored is kept, even when its day now looks like a bulk mark, because the bulk mark may have replaced a real date in Plex. Your Plex star rating comes in on the 1 to 10 scale (3.5 stars is 7; a rating that isn't a whole number on that scale is rounded); `--no-ratings` leaves ratings out. Title, year, directors, genres, runtime and collections are read; summaries, artwork and file paths are not.
- **Unwatched movies.** A new movie you haven't watched gets `--unwatched-status`: `someday` by default, `queue`, or `skip` to leave unwatched movies out. A movie you already have keeps its status, and a watched movie is never moved out of watched.
- **Matching.** The IMDb id Plex has for a movie is a hint, checked against the catalog, since Plex's automatic match can be wrong. A movie with no IMDb id (an "Other Videos" item, say) is matched by title, year, runtime and director. Each Plex edition is its own movie: an edition whose name is a known edition word ("Director's Cut", "Extended Edition") keeps it in the title, and a Plex movie only updates an item whose title has the same edition tag (or none, when it has none), so one edition never takes over another's status or rating. Editions with other names are told apart by runtime. One movie in two libraries becomes one item when the IMDb id, title, edition, year, runtime and directors agree; when a copy could belong to more than one such group, none of them are joined. Plex's details only fill fields a movie you already have left blank.
- `--replace` is refused when a library returns fewer movies than the server reported, or when a saved listing has no totals or fewer movies than its totals, so a short read never empties your library.
- `--dry-run` reads the server and prints what it read (movies, watched, rated) without opening your library or writing anything, so unlike other imports it does not say what would be added or updated. `--from-file <file.json>` reads saved listing JSON (`/library/sections/<key>/all` responses) instead of a server.
- The watchlist lives in your Plex account, not on the server, so it is not imported.

### Jellyfin (your own server)

screentrackr can read the movies on your own Jellyfin server (10.11 or newer) over its API. It only reads: it never changes anything on the server, and it talks to the address you pass and nowhere else.

```sh
screentrackr import jellyfin --url http://localhost:8096 --user <name>
```

- **Signing in.** Without a token, screentrackr asks for your password (or reads it from stdin with `--password-stdin`), signs in as you and signs that session out when it's done. With a token in `JELLYFIN_TOKEN` (or on stdin with `--token-stdin`) it reads that token's user; an admin API key has no user of its own, so pass `--user <name>` or `--user-id <id>` to say whose library to read. The password and token are never stored or printed. A server behind a reverse proxy works with its base path in `--url`, such as `https://example.test/jellyfin`. `--timeout <seconds>` changes how long each request may take (30 by default). It always merges: `--replace` is refused, since the server's state is not a whole library.
- **Watched.** A movie Jellyfin shows as played is marked watched, with the date it was last played as its watched date. That date is the last time anyone played it, not the first watch, and it is left out for movies marked played together in bulk (5 or more within a minute). A date left out never clears a date the movie already has, including one an earlier Jellyfin import set. Play counts and half-watched movies say nothing. Any other movie keeps its status, and a movie you didn't have yet goes in the queue. Jellyfin marks a movie with no known runtime played on any stop; the import warns about those, and `--strict-played` brings them in without a status.
- **Ratings** are left out unless you pass `--ratings`. Then a rating from 1 to 10 comes in, rounded to a whole number. A rating of exactly 10 or 1 is usually a thumbs up or down from the Jellyfin app, and the import says how many it saw.
- **Owned.** A movie the import adds is owned. A movie you already have keeps its owned flag, and title, year, directors, runtime and genres only fill fields it left blank.
- **Matching.** Jellyfin's IMDb id is a hint the matcher checks against the catalog, never a hand link. Only movies come in: collections, episodes, home videos, extras, placeholders and missing files are skipped and counted. Two copies of one movie (the same IMDb id) come in once, as the played copy (or the one played last). If the library changes while it is read (during a library scan, say), the import is retried and, if it never reads whole, stops without changing anything.
- Descriptions, images and file paths are never read. Emby servers use an older form of the API and are not supported.

### ScreenTrackr JSON

`screentrackr export` writes your whole library as ScreenTrackr JSON v1, and `screentrackr import` reads it back with nothing lost. Use it for backups and for moving between machines. The format is documented in [docs/library-json-v1.md](docs/library-json-v1.md).

### Merge or replace

Imports merge by default: new movies are added, and fields the file has are updated. A merge never clears a status or rating that the file doesn't mention (the one thing an import may clear is a watched date that the same kind of source set earlier and now says is wrong; a date you set yourself is never cleared), an IMDb import never changes whether a movie is owned and never moves a movie out of watched, and importing the same file twice changes nothing. A record updates an existing movie only when exactly one item fits it: a different Apple id, a year more than one off (a year in the title counts, also before an edition tag like "(1978) (4K)"), a different runtime, a different director (except in `import apple-tv`, when the TV app's director is confirmed by the IMDb title both already share) or a different IMDb id rules an item out. For `import apple-tv`, the TV app's year is the year of the edition on sale, so it only rules out films made after it and is never stored, and a shared unconfirmed IMDb id is not enough on its own. A movie matched to IMDb that has no year, runtime or director of its own is judged by IMDb's, and how a title is written (an edition tag, the exact spelling) only tells editions of the same movie apart, never a film from its remake. A record that still fits several items (a title with no year, when you have the 1980 film and its 2020 remake) changes nothing and is listed with the candidate item ids; a row that changes nothing on one item but also fits a different one does not settle which one it is, so a later row in the same file still has to fit one on its own. Within one import each item is claimed by at most one record, so a file with two identical rows (two editions in an Apple TV paste) adds two items, a later change to that pair updates both, and importing an export restores every row. The full rules are in [docs/library-json-v1.md](docs/library-json-v1.md#which-item-a-record-updates). `--replace` starts over from the file, after saving a backup of your current library to `backups/` (an IMDb, Letterboxd or Plex import with no movies is refused instead, so it can never empty your library; a Plex listing that may be incomplete is refused too, and Trakt and Jellyfin imports only merge). Every import prints how many items were added, updated, unchanged, and need review.

The format is detected from the file. Pass `--format` (`json-v1`, `apple-paste`, `csv`, `imdb`, `letterboxd`, `trakt`, `legacy`, `neon-rows`) to choose it yourself. `legacy` and `neon-rows` read exports from the old ScreenTrackr web app.
A plain `screentrackr import` of a ZIP or folder tells the export from the names of the files in it, without opening them: one with a `watched.csv` is read as a Letterboxd export, and one with Trakt's export files (such as `watched-history.json`) as a Trakt export. One that holds both, or neither, is refused; use `import letterboxd` or `import trakt` to say which. `import plex` and `import jellyfin` read your own server instead of a file (see [Plex](#plex-media-server) and [Jellyfin](#jellyfin-your-own-server)).

## Searching

Repeat a flag to OR its values. Different flags are ANDed. Statuses are `queue`, `priority`, `someday` and `watched`; "unwatched" means any of the first three. Searches cover your library unless you pass `--scope all`, which searches every movie in the catalog and marks the ones you have.

```sh
# Fincher or Villeneuve, a thriller, IMDb 7.5+, not watched yet, under two hours
screentrackr search --director Fincher --director Villeneuve --genre Thriller --min-rating 7.5 --unwatched --max-runtime 120

# The same question across every movie, keeping only ones you don't have yet
screentrackr search --scope all --not-in-library --director Fincher --director Villeneuve --genre Thriller --min-rating 7.5 --max-runtime 120

# Comedies you own from the 1990s, best rated first
screentrackr search --genre Comedy --year 1990-1999

# Movies you rated 9 or 10
screentrackr search --my-rating-min 9 --sort my_rating

# A sci-fi drama (both genres) on your priority list, as JSON for a script
screentrackr search --genre Sci-Fi --genre Drama --all-genres --status priority --json

# Can't decide? Five random unwatched movies under 100 minutes
screentrackr search --unwatched --max-runtime 100 --sort random --limit 5
```

Output is a readable table. Every command takes `--json` for machine-readable output. Movies in your library that couldn't be matched to IMDb still show up in library searches, using the title, director, runtime and genre from your import, flagged as unmatched.

## Use it from Claude Code

```sh
claude mcp add screentrackr -- npx -y screentrackr mcp
```

Then ask in plain words: "Which Villeneuve movies do I own that I haven't watched?" or "What highly rated thrillers under two hours should I rent?" The MCP tools are `search_movies`, `get_movie`, `library_stats`, `update_movie`, `add_to_library` and `remove_from_library`. They share the CLI's filters and query code, so both always give the same answers. Two more, `setup_catalog` and `catalog_status`, build the catalog from inside the chat when you haven't run `setup` in a terminal (see below).

## Claude Desktop

### One-click extension

ScreenTrackr comes as a Claude Desktop extension, a single `.mcpb` file. [Download screentrackr.mcpb](https://github.com/bnjreece/screentrackr/releases/latest/download/screentrackr.mcpb) from the latest GitHub release, then open it (double-click it, or drag it onto Claude Desktop's Extensions settings) and confirm the install. You don't need Node.js or a terminal: the extension runs on the Node.js that Claude Desktop ships with.

Then, in a chat, ask Claude to set up ScreenTrackr's movie catalog. That calls the `setup_catalog` tool, which downloads IMDb's dataset files (about 1 GB, once) and builds the catalog in the background. It takes several minutes; Claude follows along with `catalog_status`, and you can keep chatting meanwhile. If it's interrupted (you quit Claude Desktop, say), ask again: files that finished downloading are reused. Once it's done, ask away: "Which Villeneuve movies do I own that I haven't watched?"

The extension keeps its data in `~/.screentrackr/`, the same folder the command line tool uses, so a library you imported from a terminal shows up in Claude Desktop and the other way round. To import a library, use the command line tool (see [Import your library](#import-your-library)).

To build the extension file yourself from a checkout of this repository:

```sh
npm ci
npm run pack:mcpb
```

That writes `build/mcpb/screentrackr-<version>.mcpb`. The bundle holds only the compiled server, its production dependencies, the manifest, the icon and the license.

### Manual configuration

If you'd rather run it through `npx`, add this to `claude_desktop_config.json` (on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart Claude Desktop. This needs Node.js 22.13 or newer on your PATH:

```json
{
  "mcpServers": {
    "screentrackr": {
      "command": "npx",
      "args": ["-y", "screentrackr", "mcp"]
    }
  }
}
```

Either run `npx screentrackr setup` once in a terminal, or ask Claude to set up the catalog, as above.

## Commands

Every command takes `--home <dir>`, `--json` and `--help`.

```text
screentrackr setup [--refresh] [--no-cast] [--include-tv-movies]
screentrackr import <file|apple-tv|imdb <file.csv>...|letterboxd <export.zip|folder|file.csv>...|trakt <export.zip|folder>...> [--format <format>] [--merge | --replace] [--dry-run]
screentrackr import plex [--url <server>] [--section <name|key>]... [--include-other-videos] [--unwatched-status <someday|queue|skip>] [--no-ratings] [--token-stdin] [--from-file <file.json>] [--merge | --replace] [--dry-run]
screentrackr import jellyfin --url <server> [--user <name>] [--user-id <id>] [--token-stdin | --password-stdin] [--ratings] [--strict-played] [--timeout <seconds>] [--dry-run]
screentrackr search [filters]
screentrackr show <id|tconst|title>
screentrackr add <tconst|title> [--year <yyyy>] [--status <status>] [--new-edition]
screentrackr remove <id>
screentrackr set <id|tconst|title> [--status <s>] [--era <e>] [--rating <1-10> | --clear-rating] [--watched-at <date> | --clear-watched-at] [--notes <text>]
screentrackr match [--review] [--all]
screentrackr link <id> <tconst>
screentrackr stats
screentrackr export [--out <file>]
screentrackr mcp
screentrackr doctor
```

| Command | What it does |
|---|---|
| `setup` | Downloads the IMDb datasets and builds the catalog. `--refresh` checks for newer files. Afterwards it refreshes automatic matches; your statuses, ratings, notes and manual links are never changed. |
| `import` | Brings in a library file, the Apple TV app's library with `import apple-tv`, IMDb CSV exports with `import imdb` (`--as`, `--collection`, `--include-type`, `--checkin-dates`, `--notes-from-description`), a Letterboxd export with `import letterboxd` (`--owned-list`, `--with-reviews`, `--no-watchlist`), a Trakt export with `import trakt` (`--keep-bulk-dates`), or your own Plex or Jellyfin server with `import plex` or `import jellyfin` (see [Import your library](#import-your-library)). `--dry-run` shows what an import would add, update and leave for review without changing anything (`import plex --dry-run` shows only what it read). |
| `search` | The main query. Filters are listed below. |
| `show` | The full record for one movie, by library id, IMDb id or title. An IMDb id or catalog title only finds items that are matched or linked by hand; an unmatched item (one imported with an unchecked IMDb id before `setup`, say) is reached by its id or its own title. A year in a title, as in `"The Glass Harbor (2009)"` or `"The Glass Harbor (2009) (4K)"`, only finds items of that year (within one); `set` works the same way. |
| `add` | Adds a catalog movie to your library. An ambiguous title lists the candidates instead of guessing. A year in the title, like `--year`, only finds movies of that year (within one), and a title year that disagrees with `--year` finds nothing. A movie you already have is refused unless you pass `--new-edition`. |
| `remove` | Removes one library item by id. |
| `set` | Changes status, watched era (`long-ago`, `2010s`, `2020s`), your rating, watched date or notes. A reference that matches more than one item never writes; it lists the ids to use. References resolve as for `show`, and the MCP `get_movie` and `update_movie` tools do the same. |
| `match` | Retries matching for items that need it. `--review` lists them with candidates. |
| `link` | Matches a library item to an IMDb id by hand. Manual links are never changed by later matching. |
| `stats` | Counts by status, genre, decade and director, and how many items are unmatched. |
| `export` | Writes ScreenTrackr JSON v1 to stdout or `--out <file>`. |
| `mcp` | Starts the MCP server on stdio. |
| `doctor` | Checks Node, the database, the catalog and the library. |

Search filters:

| Flag | Meaning |
|---|---|
| `--scope library\|all` | Your library (default) or the whole catalog |
| `-d, --director <name>` | Director, partial and case-insensitive (repeatable) |
| `-a, --actor <name>` | Top-billed cast member (repeatable) |
| `-g, --genre <genre>` | Genre (repeatable; any of them, or all with `--all-genres`) |
| `--min-rating <n>` | Minimum IMDb rating |
| `--min-votes <n>` | Minimum IMDb votes (default 1000 with `--scope all`) |
| `--min-runtime <min>`, `--max-runtime <min>` | Runtime bounds in minutes |
| `--year <yyyy\|yyyy-yyyy>`, `--year-from`, `--year-to` | A year or a range |
| `--status <status>` | Library status (repeatable) |
| `--unwatched` | Only `queue`, `priority` or `someday` |
| `--my-rating-min <1-10>` | Minimum personal rating |
| `--not-in-library` | With `--scope all`: only movies you don't have |
| `-t, --text <words>` | Title search |
| `--sort <field>` | `rating` (default), `votes`, `year`, `runtime`, `title`, `my_rating` or `random` |
| `--order asc\|desc` | Sort direction |
| `-n, --limit <n>`, `--offset <n>` | Paging (default 20, max 200) |

Exit codes: 0 on success, 1 for a usage or input problem, 2 for anything unexpected (set `SCREENTRACKR_DEBUG=1` for details).

## Data and license

Information courtesy of IMDb (https://www.imdb.com). Used with permission.

No movie data ships with screentrackr: not in this repository and not in the npm package. Each install downloads its own copy of IMDb's datasets from https://datasets.imdbws.com/ for that user's own personal, non-commercial use, under [IMDb's terms](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX). Don't redistribute the database the tool builds.

The code is MIT licensed. See [LICENSE](LICENSE).

## Privacy

screentrackr makes network calls in only three cases:

- `setup` (or the `setup_catalog` MCP tool, which runs the same thing) downloads IMDb's datasets from datasets.imdbws.com.
- `screentrackr import plex` sends read-only requests to the Plex Media Server address you give it, and nowhere else.
- `screentrackr import jellyfin` sends read-only requests to the Jellyfin server address you give it, and nowhere else (plus a sign-in and sign-out there when you use a password).

The Letterboxd, IMDb, Trakt, Apple TV, CSV and JSON imports only read files and apps on your machine; they never sign in to those services or fetch anything from them. Nothing about your library is sent anywhere. Plex and Jellyfin requests carry only what the server needs to answer (your token, or your Jellyfin user name and password when you sign in) and go only to the address you give. Tokens and passwords are never stored or printed. There's no telemetry, no account and no server. Your library stays in a SQLite file on your machine.

## Not affiliated

screentrackr is an independent project. It's not affiliated with IMDb or Apple, or endorsed by either. It's not affiliated with or endorsed by Plex, Jellyfin, Letterboxd or Trakt either.

## Development

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
npm run pack:mcpb   # the Claude Desktop extension, into build/mcpb/
```

Tests use small synthetic datasets with made-up titles, never real IMDb rows.
