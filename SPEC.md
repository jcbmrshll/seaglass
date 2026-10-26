# seaglass protocol

Version 1. This document is normative: a server or frontend built from it alone
should interoperate with the reference implementation in this repository. The
conformance suite (§9) checks a server against it.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

A **run** is one execution of a training script. While it runs, a client sends the
server what the run produces:

- **metrics**: scalars by name, per step;
- **files**: immutable blobs under the run (arrays, JSON, images);
- **media entries**: a log of typed data, each entry naming a key, a step, a
  type and a file;
- **stream rows**: rows of JSON in a named, append-only log, for project data
  that is read as a series (a population per generation, say);
- **activity**: what the run is doing now, which doubles as its heartbeat.

The server stores all of it and serves it back. It never interprets files and
never draws anything.

A **project** may ship a **bundle**: a directory of ES modules plus a
`layout.json` (§6). Each run references the bundle it was started with, by content
hash. A frontend draws a run by laying out the panels `layout.json` describes and
by handing each media entry to the bundle's renderer for its type (§7), falling
back to a generic display.

```
training script ── client ──HTTP──▶ server ──▶ <root>/<run id>/...
                                       │
frontend ◀─────────────HTTP────────────┘   run, metrics, media, streams, files, bundle
   └─ sandboxed frame per custom panel: module.render({ el, data, run, host })
```

## 2. Conventions

- Bodies are JSON (RFC 8259, UTF-8) unless stated otherwise; responses with a JSON
  body have `Content-Type: application/json`.
- Errors are answered with a 4xx status and the body `{"error": "<message>"}`:
  `400` malformed or invalid, `404` no such route, run, file or bundle, `409`
  conflict, `413` too large. A server MAY answer `405` for a known path with the
  wrong method.
- Every `GET` response MUST carry `Access-Control-Allow-Origin: *`. Bundle modules
  are loaded into frames with an opaque origin (§7.1), which makes their fetches
  cross-origin.
- **Times** are seconds since the Unix epoch, as JSON numbers, taken from the
  server's clock.
- **Steps** are integers chosen by the run (an epoch, a generation, an update).
  Steps need not be contiguous or increasing.
- Non-finite numbers do not exist in JSON. Clients MUST send them as `null`.
  Servers MAY accept the tokens `NaN`, `Infinity` and `-Infinity` and MUST then
  store them as `null`.
- Names:

  | what | pattern |
  |---|---|
  | run id | `^\d{8}-\d{6}-[0-9a-f]{4}$` |
  | project | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` |
  | metric name, media key | any string of 1–200 characters; metric names may not be `step` or `time` |
  | stream name | `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` |
  | tag | 1–64 characters, no commas, no leading or trailing whitespace; at most 32 per run |
  | type | `^[a-z0-9][a-z0-9_.-]*(/[a-z0-9][a-z0-9_.-]*)+$`, e.g. `gridworld/episode` |
  | file path | `/`-separated segments, each `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`, at most 255 characters in all |
  | bundle hash | `^[0-9a-f]{64}$` |

  Path segments may not start with `.`, so `.` and `..` cannot occur. In URLs, each
  segment of a file path is percent-encoded on its own.
- **Incremental reads.** Metrics, media and streams are append-only lists of rows.
  Reading one takes `?since=N` (default `0`): the response is
  `{"rows": [...], "next": M}`, holding the rows from index `N` on, where `M` is the
  number of rows there are. A reader passes `next` as `since` to its next read and
  gets only what was appended in between. A `since` past the end gives no rows.
- Limits: a server MAY refuse a large request with `413`. It MUST accept JSON bodies
  of up to 16 MiB, files of up to 64 MiB and bundles of up to 32 MiB.

## 3. Runs

### 3.1 Run meta

A run's meta is a JSON object:

| field | type | meaning |
|---|---|---|
| `id` | string | the run id, `YYYYmmdd-HHMMSS-xxxx`: its creation time and 4 random hex digits |
| `project` | string | |
| `name` | string | the client's, or one the server made up (e.g. `amber-heron-3`) |
| `created` | time | |
| `updated` | time | the last time the server heard from the run |
| `status` | string | `running`, `finished`, or another status the run finished with (e.g. `crashed`) |
| `step` | integer \| null | the highest step logged so far, in metrics, media or streams |
| `total` | integer \| null | the step the run expects to end at, if it said |
| `latest` | object | each metric's latest non-null value, `{"loss": 0.41}` |
| `activity` | string \| null | what the run says it is doing now |
| `activity_since` | time \| null | when `activity` last changed |
| `tags` | string[] | |
| `provenance` | object | where the run came from (§3.2) |
| `bundle` | string \| null | the hash of the run's bundle |
| `config` | object | the run's configuration, as the client sent it |

A frontend SHOULD call a run whose status is `running` but whose `updated` is more
than 120 seconds old **stale**: its process has probably died.

A server MUST set `status` back to `running` when a finished run logs metrics,
media, stream rows or activity: a run that logs is running, as when training is
continued.

### 3.2 Provenance

The client fills in `provenance` at start. A server stores it as given. The
reference client sends:

```json
{
  "git": {"commit": "3f2a9c1…", "branch": "dev", "dirty": true},
  "host": "gpu-box",
  "argv": ["train.py", "--lr", "3e-4"],
  "cwd": "/home/me/project",
  "python": "3.12.3"
}
```

`git` is `null` outside a git checkout. A frontend can filter on any of it, e.g.
by branch.

## 4. Ingest

### 4.1 Create a run: `POST /api/runs`

```json
{
  "project": "gridworld",
  "name": null,
  "config": {"lr": 0.0003},
  "tags": ["sweep-3"],
  "provenance": {"git": null, "host": "gpu-box", "argv": [], "cwd": "/"},
  "bundle": "9c1e…",
  "total": 300
}
```

Every field is optional: `project` defaults to `default`, `config` and
`provenance` to `{}` and `tags` to `[]`. `bundle` need not have been uploaded (a run
must not fail to start because its views did); a frontend then draws the run
without it.

`201`, the run's meta (§3.1), with `status` `running`, `step` `null` and `latest`
`{}`.

### 4.2 Metrics: `POST /api/runs/{id}/metrics`

A JSON array of rows, each a step and any number of metrics:

```json
[{"step": 3, "loss": 0.41, "return": 12.5}, {"step": 4, "loss": null}]
```

Values MUST be numbers or `null`. The server appends each row as it is, plus
`"time"`, and updates `updated`, `step` and `latest`.

`200`, `{"ok": true}`.

### 4.3 Files: `PUT /api/runs/{id}/files/{path}`

The body is the file's bytes; its `Content-Type` is ignored. Files are immutable. If
`path` exists with the same bytes the server answers `200` (so a client can
safely retry); with different bytes, `409`. A server MUST make a file visible only
once it is complete.

`201` (or `200`), `{"path": "episode/3-a1f0.npz", "size": 18311}`.

Files that no media entry names are allowed and useful: a view can find them
through a stream row or by a naming scheme of its own (e.g. one file per episode,
so a view can fetch one episode instead of a generation's worth).

### 4.4 Media entries: `POST /api/runs/{id}/media`

A JSON array of entries:

```json
[{"key": "episode", "step": 3, "type": "gridworld/episode",
  "file": "episode/3-a1f0.npz", "attrs": {"seed": 7}}]
```

| field | required | meaning |
|---|---|---|
| `key` | yes | what is being logged; one media panel shows one key's entries |
| `step` | yes | |
| `file` | yes | a file of this run (§4.3), uploaded before the entry |
| `type` | no | picks the renderer (§7); without one, a frontend uses its generic display |
| `attrs` | no | a JSON object of small facts about the entry, at most 64 KiB serialized |

The server checks that `file` exists (`400` if not), appends each entry with
`"time"`, and updates `updated` and `step`.

`200`, `{"ok": true}`.

### 4.5 Stream rows: `POST /api/runs/{id}/streams/{name}`

A JSON array of rows, each an object with an integer `step` and anything else:

```json
[{"step": 12, "ids": [4, 9, 11], "fitness": [3.2, 2.9, null]}]
```

The server appends each row with `"time"` (replacing any `time` the row had) and
updates `updated` and `step`. A stream is created by its first row.

`200`, `{"ok": true}`.

### 4.6 Activity and heartbeat: `POST /api/runs/{id}/activity`

```json
{"activity": "evaluating (epoch 3)"}
```

`activity` is a string of at most 500 characters, or `null` to clear it. The server
sets `activity`, sets `activity_since` if the activity changed, and sets `updated`.
A running client SHOULD send its current activity at least every 30 seconds, even
when it has not changed, so that the run doesn't look stale (§3.1).

`200`, `{"ok": true}`.

### 4.7 Finish: `POST /api/runs/{id}/finish`

```json
{"status": "finished"}
```

`status` defaults to `finished`. It matches `^[a-z][a-z0-9_-]{0,31}$` and is not
`running`. The server sets `status`, clears `activity` and `activity_since`, and
sets `updated`.

`200`, `{"ok": true}`.

### 4.8 Bundles: `GET /api/bundles/{hash}`, `PUT /api/bundles/{hash}`

A client checks whether the server has a bundle with `GET`, which answers `404`, or
`200` with:

```json
{"hash": "9c1e…", "files": [{"path": "layout.json", "size": 412}, {"path": "episode.js", "size": 5120}]}
```

If the server does not have it, the client uploads it with `PUT`:

```json
{"files": {"layout.json": "<base64>", "episode.js": "<base64>"}}
```

The server recomputes the hash (§6.2) and answers `400` if it differs from
`{hash}`, if a path is invalid, if there is no `layout.json`, or if `layout.json` is
not a JSON object with an integer `contract`. It does not check the layout any
further. Bundles are immutable: uploading one the server already has changes
nothing.

`201` (or `200` if it existed), the same body as `GET`.

## 5. Reads

| request | response |
|---|---|
| `GET /api` | `{"protocol": 1, "server": "<name>/<version>"}` |
| `GET /api/runs` | every run's meta without `config`, newest `created` first |
| `GET /api/runs/{id}` | the run's meta (§3.1) |
| `GET /api/runs/{id}/metrics?since=N` | `{"rows", "next"}`; rows as logged, with `time` |
| `GET /api/runs/{id}/media?since=N` | `{"rows", "next"}`; entries as logged, with `time` |
| `GET /api/runs/{id}/streams/{name}?since=N` | `{"rows", "next"}`; a stream nothing was appended to has no rows |
| `GET /api/runs/{id}/files/{path}` | the file's bytes |
| `GET /bundles/{hash}/{path}` | a file of a bundle |

Files and bundle files are served with a `Content-Type` from their extension, at
least: `.js`/`.mjs` `text/javascript`, `.css` `text/css`, `.json`
`application/json`, `.html` `text/html`, `.svg` `image/svg+xml`, `.png`
`image/png`, `.gif` `image/gif`, `.jpg`/`.jpeg` `image/jpeg`, `.webp`
`image/webp`, `.mp4` `video/mp4`, `.wasm` `application/wasm`, `.txt` `text/plain`,
anything else `application/octet-stream`. As files never change, a server MAY
serve them with a long-lived `Cache-Control`.

A run that does not exist is `404` for every path under it.

## 6. Bundles

### 6.1 Contents

A bundle is a directory of files: ES modules, a `layout.json` (§8), and any assets
the modules load (styles, images, fonts, wasm). The client builds one from a
directory, including every regular file under it except those with a path segment
starting with `.`.

### 6.2 Hash

The hash is the lowercase hex SHA-256 of the files, sorted by path (bytewise, on
the UTF-8 paths), each as its path, a zero byte, its size in decimal ASCII digits, a
zero byte, then its bytes:

```
sha256( path₁ 0x00 size₁ 0x00 bytes₁  path₂ 0x00 size₂ 0x00 bytes₂  … )
```

### 6.3 Versioning

`layout.json` carries `"contract": 1`: the version of the module contract (§7) and
layout schema (§8) the bundle was written against. A frontend that does not support
a bundle's contract MUST NOT run its modules, and draws the run with its default
layout and generic displays instead.

Each run renders with the bundle it was started with. A newer bundle never changes
how an older run looks.

## 7. Module contract (version 1)

### 7.1 Where a module runs

A frontend runs every **instance** of a module (each panel, each entry shown) in a
document of its own: a sandboxed frame (`<iframe sandbox="allow-scripts"
allow="fullscreen">`) with an opaque origin. So a module:

- MAY use its own `document` and `window` as it likes: add styles to its `<head>`,
  listen for keys on its document, append a tooltip to its `<body>`, go full screen;
- MUST import only relative specifiers that resolve inside its own bundle, and load
  assets only from its own bundle, by URL relative to `import.meta.url`
  (`new URL("./style.css", import.meta.url)`);
- MUST get everything else through `host`: it MUST NOT fetch the server's API or any
  other URL;
- cannot use storage (`localStorage`, `IndexedDB` and cookies throw in an opaque
  origin): it keeps preferences through `host.getPref`/`host.setPref`;
- MUST NOT rely on anything of the page around it: its globals, styles or DOM.

Shared helpers (a DOM builder, a palette) are vendored into each bundle. A function
cannot be passed across a frame, so `host` only offers data.

The frame's document is `<body><div id="el"></div></body>`. The frontend sets
`html, body { margin: 0; background: transparent }`, the body's `color` and `font`
from the theme (§7.5), and the frame's height to the document's height as it
changes. When a panel fills a tab (§8.2), the frame instead has a fixed height and
`html`, `body` and `el` are `height: 100%`.

While the pointer is over a frame, the frontend SHOULD forward key presses made
outside any text input to it, as `keydown` events dispatched at the element under
the pointer. A module's keyboard controls then work on hover, as they would on the
page.

### 7.2 `render`

A module that renders an entry, or a custom view, exports:

```js
export async function render({ el, data, run, host }) {
  // draw into el
  return { update(change) {}, destroy() {} };   // optional
}
```

- `el`: an empty element the module owns.
- `data`: for a renderer, the media entry (§4.4) it is to draw, with `time`; for a
  view, the panel's `props` (§8.3), or `{}`.
- `run`: the run's meta (§3.1), as of the call.
- `host`: the host API (§7.3).

`render` may return nothing, or a **handle**, either directly or through a promise.
If it throws or rejects, the frontend shows the error in the panel; for a renderer
it also offers its generic display.

### 7.3 `host`

Every method returns a promise. Arguments and results are structured-clonable
(numbers, strings, plain objects, arrays, `ArrayBuffer`s, typed arrays).

| method | resolves to |
|---|---|
| `info()` | `{contract: 1, frontend: "<name>/<version>"}` |
| `run()` | the run's meta, read now |
| `metrics({since = 0} = {})` | `{rows, next}` (§5) |
| `entries({since = 0, key} = {})` | `{rows, next}`: media entries, only `key`'s if given; `next` counts every entry |
| `stream(name, {since = 0} = {})` | `{rows, next}` |
| `file(path)` | an `ArrayBuffer` of one of the run's files |
| `json(path)` | a file, parsed as JSON |
| `arrays(path)` | the arrays of an `.npz` file (§7.4) |
| `theme()` | `{mode: "light" \| "dark", vars: {"--sg-fg": "#3f2606", …}}` (§7.5) |
| `location()` | `{tab, step, state}` (§7.6) |
| `navigate({tab, step, state})` | asks the frontend to go somewhere (§7.6); resolves once it has, or decided not to |
| `getPref(key)` | a value the bundle's project stored under `key`, or `null` |
| `setPref(key, value)` | stores a JSON value of at most 64 KiB under `key`, for this project, in this browser |

A method fails (rejects) with an `Error` whose message says why, e.g. for a file
that does not exist.

### 7.4 Arrays

`arrays(path)` reads an `.npz` file, as written by `numpy.savez` or
`numpy.savez_compressed`, into `{name: {dtype, shape, data}}`: `shape` an array of
integers, `data` a typed array of the elements in C order.

| npy dtype | `dtype` | `data` |
|---|---|---|
| `\|b1` | `bool` | `Uint8Array` |
| `\|u1`, `\|i1` | `uint8`, `int8` | `Uint8Array`, `Int8Array` |
| `<u2`, `<i2` | `uint16`, `int16` | `Uint16Array`, `Int16Array` |
| `<u4`, `<i4` | `uint32`, `int32` | `Uint32Array`, `Int32Array` |
| `<u8`, `<i8` | `uint64`, `int64` | `BigUint64Array`, `BigInt64Array` |
| `<f2` | `float16` | `Float32Array` (widened) |
| `<f4`, `<f8` | `float32`, `float64` | `Float32Array`, `Float64Array` |

Big-endian, Fortran-ordered, structured, string and object arrays are not
supported; `arrays` rejects a file holding one.

### 7.5 Theme

The frontend sets these CSS custom properties on the frame's root element, and
`theme()` returns the same values:

| variable | use |
|---|---|
| `--sg-bg` | the page background |
| `--sg-panel` | a panel's background |
| `--sg-well` | inset areas: a plot's background, a code block |
| `--sg-edge` | borders and rules |
| `--sg-fg`, `--sg-fg-strong`, `--sg-dim`, `--sg-faint` | text, from emphasized to faint |
| `--sg-accent` | links and selection |
| `--sg-good`, `--sg-bad` | success and failure |
| `--sg-s1` … `--sg-s6` | series colours, in order |
| `--sg-font`, `--sg-mono` | font families |

A module may use them or keep its own palette.

### 7.6 Location

A run page has a **location**:

- `tab`: the title of the tab shown, or `null` for the first;
- `step`: the step the reader picked to look at, or `null` when following the
  latest. Panels show the run as of that step: tiles its values then, media the
  entry at or before it;
- `state`: string keys to string values that views keep in the page's address, such
  as which member a view has open, so a reload or a shared link opens it again.

`navigate({tab, step, state})` changes any of these. Fields left out stay as they
are; in `state`, a key set to `null` is removed and other keys are kept. A frontend
MAY refuse a request it cannot follow.

### 7.7 Handles

`render` may return a handle with either method:

- `update(change)`: something the module was given has changed. `change` has one or
  more of: `data` (the panel now shows another entry), `run` (the run's meta, read
  after it logged something new), `location` (§7.6), `theme` (§7.5). A module can
  then catch up, e.g. read `host.metrics({since})` from where it left off. Without
  `update`, a frontend renders the module again from scratch when `data` changes,
  and does not tell it about anything else.
- `destroy()`: the panel is going away. A frontend MAY instead discard the frame
  without calling it.

## 8. Layout (`layout.json`, version 1)

### 8.1 Top level

```json
{
  "contract": 1,
  "renderers": {"gridworld/episode": "episode.js"},
  "summary": ["return", "loss"],
  "tabs": [
    {"title": "Training", "rows": [
      [{"type": "tiles"}],
      [{"type": "chart", "title": "return", "metrics": ["return", "return/*"], "smooth": 10, "width": 2},
       {"type": "chart", "metrics": ["loss"], "log": true}],
      [{"type": "media", "keys": ["episode"]}],
      [{"type": "config"}]
    ]},
    {"title": "Explorer", "panel": {"type": "view", "module": "explorer.js", "props": {"size": 5}}}
  ]
}
```

| field | meaning |
|---|---|
| `contract` | required: `1` |
| `renderers` | media type → module path in the bundle |
| `summary` | metric patterns: the metrics that represent the run where runs are listed together, and the default tiles |
| `tabs` | the run page, as tabs; without it, the default layout (§8.5) |

A frontend MUST ignore fields it does not know, here and in panels.

### 8.2 Tabs and rows

A tab is `{"title", "rows"}` or `{"title", "panel"}`; titles are unique within a layout:

- `rows` is a list of rows, top to bottom; a row is a list of panels, left to right.
  A panel's `width` (default `1`) is its share of the row's width. A frontend MAY
  stack a row's panels on a narrow screen.
- `panel` is a single panel that fills the tab, to the bottom of the window: a custom
  view that is a page of its own.

A frontend shows the tab bar only when there is more than one tab.

### 8.3 Panels

Every panel has a `type` and may have a `title` and a `width`.

| type | fields | shows |
|---|---|---|
| `tiles` | `metrics`: patterns, default `summary` | each matching metric's latest value (as of the location's step) |
| `chart` | `metrics`: patterns (required); `split`: bool, default `false`; `smooth`: integer ≥ 0, default `0`; `log`: bool, default `false` | the matching metrics against step, as one chart, or with `split` one chart per group (§8.4); `smooth` draws a trailing moving average over that many points over the faint raw line; `log` uses a log-scale y axis |
| `media` | `keys`: patterns (required) | for each matching key, one card with that key's entries, drawn by the renderer for each entry's type, and a scrubber over the entries' steps |
| `view` | `module`: path in the bundle (required); `props`: object | a custom module (§7), given `props` as `data` |
| `config` | | the run's config, as tables |

**Patterns** match metric names or keys: `*` matches any run of characters
(including `/`), `?` any one character, and anything else itself. Matches come in
pattern order, then in the order the metrics or keys were first logged. A metric
matched by an earlier pattern is not repeated.

A panel's `title` defaults to its pattern when it has a single one, and is empty
otherwise.

**Renderers.** For an entry, a frontend uses the module `renderers` names for its
`type`. If there is none, or the entry has no type, or the module failed, it uses
its generic display, by the file's extension: `.npz` a table of the arrays (name,
dtype, shape, and their values or a summary), `.json` the value as an
expandable tree, images and video as they are, and anything else as a download
link.

### 8.4 Groups for `split`

Each matched metric goes into one group:

1. a name with a `/` goes into the group named by what comes before its last `/`,
   as the series named by what follows it (`loss/policy` → group `loss`, series
   `policy`);
2. otherwise, a name `min_X`, `mean_X` or `max_X`, when at least two of the three
   were logged, goes into group `X` as series `min`, `mean` or `max`;
3. otherwise a metric is a group of its own.

Groups come in the order of their first metric, series max, mean, min first and the
rest in order.

### 8.5 Default layout

A run without a bundle, or whose bundle is missing or targets an unsupported
contract, is drawn as if its layout were:

```json
{"contract": 1, "tabs": [{"title": "Run", "rows": [
  [{"type": "tiles", "metrics": ["*"]}],
  [{"type": "media", "keys": ["*"]}],
  [{"type": "chart", "metrics": ["*"], "split": true}],
  [{"type": "config"}]
]}]}
```

except that the tiles show at most the first 6 metrics. A bundle with no `tabs` has
this layout too, with its own `renderers` and `summary` (the tiles then show the
summary).

## 9. Conformance

`seaglass conformance <url>` runs the suite against the server at `<url>` and exits
non-zero if any case fails. The cases live in `seaglass/conformance/cases/*.json`;
they were written from exchanges with the reference server, and generalized so that
values a server picks (ids, names, times) are matched by kind rather than by value.
They only add runs, so they can run against a server that holds other runs.

A case is a list of exchanges:

```json
{
  "name": "metrics are read incrementally",
  "steps": [
    {"request": {"method": "POST", "path": "/api/runs", "json": {"project": "conformance"}},
     "response": {"status": 201, "json": {"id": {"$regex": "^\\d{8}-\\d{6}-[0-9a-f]{4}$", "$capture": "run"}}}},
    {"request": {"method": "GET", "path": "/api/runs/{{run}}/metrics?since=0"},
     "response": {"status": 200, "json": {"$exact": {"rows": [], "next": 0}}}}
  ]
}
```

A case may have a `setup`. Every case starts with the variable `nonce`, a fresh
random hex string, so a case can make data no earlier run of the suite made. For
each bundle in `setup.bundles` (`{"<name>": {"<path>": "<text>"}}`), the runner
computes `<name>.hash` (§6.2) and `<name>.files` (the files as base64, ready to
upload), after replacing variables in the texts.

A **request** has `method`, `path`, optional `headers`, and at most one body:
`json`, `text`, or `base64` (raw bytes). `{{name}}` in a path, a header, or a string
anywhere in a body (or an expected body) is replaced by a variable: a string that is
nothing but `{{name}}` becomes the variable's value, whatever its type; anywhere
else the value is spliced in as text.

A **response** has `status` (a status, or a list of those allowed), and optionally `headers` (names case-insensitive; only
those listed are checked) and one body: `json`, `text` or `base64`. A `json` body
matches the actual body this way:

- an object matches an object that has all of its keys, each matching (other keys
  are allowed);
- an array matches an array of the same length, element by element;
- anything else matches an equal value;
- an object whose keys all start with `$` is a matcher, and matches when all of its
  conditions hold:

  | matcher | holds when the value |
  |---|---|
  | `{"$any": true}` | exists |
  | `{"$type": t}` | is of JSON type `t`: `string`, `number`, `integer`, `boolean`, `null`, `object`, `array` |
  | `{"$regex": r}` | is a string that `r` matches (searched, not anchored) |
  | `{"$var": "name"}` | equals the value captured as `name` |
  | `{"$capture": "name"}` | (always holds) captures the value as `name` |
  | `{"$exact": v}` | matches `v`, where objects in `v` (at any depth) must have no other keys |
  | `{"$contains": [v, …]}` | is an array, and each `v` matches some element of it |
  | `{"$absent": true}` | used as an object's key: the key is not there |
  | `{"$gte": n}` | is a number ≥ `n` (or the captured number named, if `n` is a string) |

## 10. Storage layout

A server that keeps runs in a directory MUST use this layout, so that servers can
share one:

```
<root>/
  <run id>/
    meta.json              the run's meta (§3.1), replaced whole on each change
    metrics.jsonl          one metrics row per line
    media.jsonl            one media entry per line
    files/<path>           the run's files
    streams/<name>.jsonl   one row per line
  bundles/<hash>/<path>    each bundle's files
```

- `.jsonl` files hold one JSON object per line, each ending in `\n`. A reader ignores
  a last line without its `\n`: it is still being written. Row `N` of an
  incremental read (§2) is line `N`.
- `meta.json` and files are written to a temporary name and renamed into place.
- A bundle is written to a temporary directory and renamed into place when it is
  complete, so `bundles/<hash>` existing means the bundle is there.
- Directories under `<root>` whose names are not run ids are not runs.

## 11. Clients (informative)

The reference client (`seaglass.Monitor`) behaves as follows; other clients
SHOULD do the same.

- The server is the URL passed, else the environment variable `SEAGLASS_URL`, else
  `http://localhost:8008`.
- Tags are those passed, plus the comma-separated `SEAGLASS_TAGS`.
- At start it records provenance (§3.2), hashes its bundle directory, uploads the
  bundle if the server lacks it (§4.8), and creates the run (§4.1).
- Logging never raises and never blocks training: values are queued and sent in
  order by a background thread. If the server cannot be reached, the client says so
  once and drops what it cannot send; when the server comes back, it says so and
  carries on.
- While the run is going, it sends its current activity every 30 seconds (§4.6).
- `finish` waits until everything queued has been sent.

## 12. Frontends (informative)

The basic frontend that ships with the reference server polls: the run list every
5 seconds, a run's meta, metrics and media every 2 seconds, reading incrementally
(§2), while its page is visible. It has:

- a **run list**, filterable by project, tag and branch, with each run's status,
  progress, activity and summary metrics;
- a **run page**: a header (name, status, activity, provenance), a step bar that
  sets the location's step (§7.6), and the run's layout (§8), loading the run's
  bundle and running its modules as §7 describes. Clicking a chart picks a step.
  The page's address holds the location: `/run/<id>?tab=…&step=…&<state>…`, where
  `tab` and `step` are reserved and every other parameter is view state.
