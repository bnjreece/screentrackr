# ScreenTrackr JSON v1

The library format that `screentrackr export` writes and `screentrackr import` reads back. A round trip is lossless: every status, era, rating, note and IMDb link survives. Use it for backups, for moving a library to another machine, or for writing your own converter from another app.

The file is UTF-8 JSON. Only your library is in it. The full IMDb catalog is not exported. Library records may contain metadata copied from the catalog.

## Example

```json
{
  "format": "screentrackr-library",
  "version": 1,
  "exportedAt": "2026-10-23T18:04:11.512Z",
  "items": [
    {
      "tconst": "tt9000001",
      "sourceTitle": "The Example Heist",
      "sourceYear": 2011,
      "sourceDirector": "Jane Doe",
      "sourceRuntimeMin": 118,
      "sourceGenre": "Thriller",
      "collection": null,
      "owned": true,
      "sourceOwnedRaw": "Yes",
      "status": "watched",
      "watchedEra": "2010s",
      "watchedAt": "2014-06-01",
      "myRating": 8,
      "notes": "Rewatch with friends",
      "matchStatus": "matched",
      "matchScore": 0.97,
      "source": "paste",
      "applePersistentId": null,
      "addedAt": "2026-10-23T17:55:02.000Z",
      "updatedAt": "2026-10-23T17:59:40.000Z"
    }
  ]
}
```

## Envelope

| Field | Type | Meaning |
|---|---|---|
| `format` | string | Always `"screentrackr-library"`. This is how the importer recognizes the file. |
| `version` | number | Always `1` for this format. A future, incompatible format gets a new number. |
| `exportedAt` | string | ISO 8601 time of the export. Optional on import. |
| `items` | array | One object per library item, described below. |

## Items

Only `sourceTitle` is required on import. Every other field may be omitted or `null`. A new item takes the default shown; a merge into an existing item keeps that item's value for anything omitted or `null`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `tconst` | string or null | null | The IMDb id (`tt` and 7 or more digits) the item is linked to. When present on a `matched` or `manual` item it is kept as is on import, without rematching. On an `unmatched` item it is an id hint kept from an import made before `setup`, and the importer checks it against the catalog like any other hint. Until a match or a hand link confirms it, a hint is not the item's identity: `show`, `set`, MCP `get_movie` and `update_movie` never find the item by that `tconst` or by that movie's catalog title, only by its library id or its own title. When null, the importer tries to match the item to the catalog. |
| `sourceTitle` | string | required | The title as your source had it. |
| `sourceYear` | integer or null | null | Release year from the source. |
| `sourceDirector` | string or null | null | Director(s) from the source, as written. |
| `sourceRuntimeMin` | integer or null | null | Runtime in minutes from the source. |
| `sourceGenre` | string or null | null | Genre(s) from the source, as written. |
| `collection` | string or null | null | A collection or folder name from the source. |
| `owned` | boolean or null | true | Whether you own the movie. When omitted, a new item is owned and a merge keeps the existing value. |
| `sourceOwnedRaw` | string or null | null | The source's raw "owned" value, kept so a blank can be told apart from an explicit yes. |
| `status` | string or null | `"queue"` | One of `queue`, `priority`, `someday`, `watched`. When omitted, a new item goes in the queue and a merge keeps the existing status and watched era. |
| `watchedEra` | string or null | null | When you watched it: `long-ago`, `2010s` or `2020s`. Only kept when `status` is `watched`. |
| `watchedAt` | string or null | null | Watched date, `YYYY-MM-DD`. |
| `myRating` | integer or null | null | Your rating, a whole number from 1 to 10. |
| `notes` | string or null | null | Free text notes. |
| `matchStatus` | string | | `matched`, `ambiguous`, `unmatched` or `manual`. On import, a linked item keeps `manual` if it was manual and is otherwise `matched`; an unlinked item is matched again. |
| `matchScore` | number or null | null | The matcher's confidence for a linked item. |
| `source` | string | `"json"` | Where the item first came from: `paste`, `apple-tv`, `json`, `csv`, `manual` or `legacy`. |
| `applePersistentId` | string or null | null | The Apple TV app's persistent id, when the item came from `import apple-tv`. Used to recognize the same movie on a later import. |
| `addedAt` | string | import time | ISO 8601 time the item was first added. Kept on import. |
| `updatedAt` | string | import time | ISO 8601 time of the last change. Written on export; set fresh on import. |

The local item `id` is not exported. Ids belong to one database, so an import assigns its own.

## Importing

```sh
screentrackr import my-library.json            # merge into the current library
screentrackr import my-library.json --replace  # back up, then replace the library
```

A merge adds new items and updates the fields an item has. A field that is missing or `null` never clears what your library already has, `status` and `owned` included, so a file with only titles and notes adds notes without touching statuses.

### Which item a record updates

Every import format goes through the same rules to decide whether a record is an item you already have.

1. **Candidates.** An item is a candidate when it has the record's `applePersistentId`, or the same established `tconst`, or the same title after normalizing (case, accents, punctuation, a leading article and a trailing edition or year in parentheses are ignored). A `tconst` is established when the item is `matched` or `manual`, or the record carries it as a JSON v1 link. An IMDb id the matcher could not check yet (an import before `setup`, or a `tconst` on an `unmatched` or `ambiguous` item) is only a hint, and a shared hint alone never makes two records the same movie.
2. **Conflicts rule a candidate out**, however it was found, the same `tconst` included:
   - both have an Apple persistent id and they differ;
   - both have a year and they are more than one year apart (a `(YYYY)` at the end of the title beats `sourceYear`, also when edition groups follow it, as in `(1978) (4K)` or `(1978) (Special Edition)`);
   - the record comes from `import apple-tv` and the item's year is more than one year after the TV app's year. The TV app's year is the year of the edition on sale (a 1991 film can show 1997, a restoration decades later), so it is never the record's year: it only rules out films made after that edition. It is never written into `sourceYear` either;
   - both have a runtime and they differ by more than 3 minutes;
   - both name directors and no director of one can be a director of the other (the same surname counts as the same person; a shared first name does not, so "Orrin Vale" and "Orrin Brask" are two people; `Unknown` and blank credits are ignored). This one does not apply when both are established as the same `tconst`: that IMDb title has one set of directors, so a differing credit is a typo or an author credited as director, not another film;
   - both have a `tconst` and they differ, hints included: two different IMDb ids name two different movies. A hand link (`manual`) yields only to a record's own JSON v1 link, not to a fresh catalog match or a hint. A record's hint that matching checked against the catalog and did not accept (the record's own year, runtime or director contradicts it) is stale and does not count here: the record is judged by the match it got instead.
   An item with the record's own Apple persistent id is that item, whatever else differs.

   Year, runtime and directors are the item's own source fields. When a `matched` or `manual` item's source left one out, its catalog title's year, runtime or directors stand in for it, so an item matched through an IMDb id with no year still counts as that movie's year and a record naming a year far from it is another movie, even when the record itself could not be matched. The same holds for a record that carries its own link. An unchecked hint fills in nothing.
3. **An exact repeat changes nothing.** If the record would not change a remaining candidate's own data, it repeats that candidate (a different match the record's fields would give an unmatched or ambiguous item does not count as a change). The narrowing in rule 4 is applied to the repeated candidates. The record claims the one left only when the same narrowing over all the remaining candidates also leaves only it (or items identical to it), and then it is reported unchanged (or, if only the item's match moves, updated). Otherwise (a row with only a title, or a row saying `watched` with no rating, when you have the 1978 film watched and its 2009 remake in priority) the record is reported unchanged, writes nothing and claims none of them (rule 5), so a later record in the same file still has to fit exactly one of them on its own and is otherwise listed for review.
4. **Otherwise one item must remain.** The remaining candidates are narrowed to those with the same Apple id, then the same established `tconst`, then exactly the same title, skipping any step that would leave none. The exact-title step only runs when the candidates left are already the same movie (one established `tconst`, or identical `tconst`, year, runtime and directors): how a title is written tells editions of one movie apart, never two different movies, so a record titled `The Glass Harbor` with no year fits both `The Glass Harbor` (1978) and `The Glass Harbor (2009)` and goes to review. One left: it is updated. None: the record is added as a new item. Several that are identical apart from ids and dates (two editions an Apple TV paste lists twice, say): the first is updated, since either one is the same choice. Several that differ: nothing is written, and the import lists the record with the candidate item ids (`reviews` in `--json` output) and counts it in "needs review". Add a year, runtime or IMDb id to the record, or change the item with `screentrackr set <id>`.
5. **Within one import, each item is claimed once.** An existing item can be claimed by at most one record of the file, and an item the import adds is never a candidate for a later record. A record first claims an unclaimed item that is exactly what the record would add (every field equal, a missing field counting as `null` or its default; items whose match status and score are also equal are paired first, so two editions that differ only in that one was linked by hand each get their own row back), then the rules above run among the items no other record has claimed. An unchanged record that also fits a different item claims none (rule 3). A record left with no unclaimed candidate is added as a new item, so a file's rows are never dropped: a `--replace` (restoring a backup, say) restores every row, and two identical rows (an Apple TV paste lists two editions this way) become two items.

So importing the same file twice reports every row unchanged (N rows claim N distinct items), two editions with different Apple ids or runtimes more than 3 minutes apart stay two items even when they share a `tconst`, and a remake with the same title but a different year stays its own item.
