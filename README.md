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

You can search the catalog without a library, but screentrackr is most useful once it knows your movies. Each import matches your movies to IMDb ids so the filters run on real fields. Review the ones it couldn't place with `screentrackr match --review` and fix them with `screentrackr link <id> <tconst>`.

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

### ScreenTrackr JSON

`screentrackr export` writes your whole library as ScreenTrackr JSON v1, and `screentrackr import` reads it back with nothing lost. Use it for backups and for moving between machines. The format is documented in [docs/library-json-v1.md](docs/library-json-v1.md).

### Merge or replace

Imports merge by default: new movies are added, and fields the file has are updated. A merge never clears a status or rating that the file doesn't mention, and importing the same file twice changes nothing. A record updates an existing movie only when exactly one item fits it: a different Apple id, a year more than one off (a year in the title counts, also before an edition tag like "(1978) (4K)"), a different runtime, a different director or a different IMDb id rules an item out, and a shared unconfirmed IMDb id is not enough on its own. A movie matched to IMDb that has no year, runtime or director of its own is judged by IMDb's, and how a title is written (an edition tag, the exact spelling) only tells editions of the same movie apart, never a film from its remake. A record that still fits several items (a title with no year, when you have the 1980 film and its 2020 remake) changes nothing and is listed with the candidate item ids; a row that changes nothing on one item but also fits a different one does not settle which one it is, so a later row in the same file still has to fit one on its own. Within one import each item is claimed by at most one record, so a file with two identical rows (two editions in an Apple TV paste) adds two items, a later change to that pair updates both, and importing an export restores every row. The full rules are in [docs/library-json-v1.md](docs/library-json-v1.md#which-item-a-record-updates). `--replace` starts over from the file, after saving a backup of your current library to `backups/`. Every import prints how many items were added, updated, unchanged, and need review.

The format is detected from the file. Pass `--format` (`json-v1`, `apple-paste`, `csv`, `legacy`, `neon-rows`) to choose it yourself. `legacy` and `neon-rows` read exports from the old ScreenTrackr web app.

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

Then ask in plain words: "Which Villeneuve movies do I own that I haven't watched?" or "What highly rated thrillers under two hours should I rent?" The MCP tools are `search_movies`, `get_movie`, `library_stats`, `update_movie`, `add_to_library` and `remove_from_library`. They share the CLI's filters and query code, so both always give the same answers.

## Use it from Claude Desktop

Add this to `claude_desktop_config.json` (on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`) and restart Claude Desktop:

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

Run `npx screentrackr setup` once in a terminal first. The MCP server doesn't download the catalog itself.

## Commands

Every command takes `--home <dir>`, `--json` and `--help`.

```text
screentrackr setup [--refresh] [--no-cast] [--include-tv-movies]
screentrackr import <file|apple-tv> [--format <format>] [--merge | --replace]
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
| `import` | Brings in a library file, or the Apple TV app's library with `import apple-tv`. |
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

The only network calls screentrackr makes are downloads from datasets.imdbws.com during `setup`. There's no telemetry, no account and no server. Your library stays in a SQLite file on your machine.

## Not affiliated

screentrackr is an independent project. It's not affiliated with IMDb or Apple, or endorsed by either.

## Development

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

Tests use small synthetic datasets with made-up titles, never real IMDb rows.
