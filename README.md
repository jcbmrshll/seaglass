# seaglass

Experiment monitoring for research code. Training runs log metrics and raw data to a
server over HTTP, and the server stores them and serves a web frontend. Each project
ships its own interactive renderers and layout, as a **bundle**. The bundle travels
with the project's runs, so any frontend that speaks the protocol can draw them.

- [`SPEC.md`](SPEC.md) is the protocol: ingest, reads, storage layout, bundles, the
  module contract and the layout schema. A conformance suite checks servers against
  it.
- The Python package has a client (`seaglass.Monitor`), a stdlib-only server, and a
  basic frontend in vanilla JS with no build step.

## Install

seaglass needs Python 3.12 or later. With [uv](https://docs.astral.sh/uv/):

```sh
uv add git+https://github.com/jcbmrshll/seaglass   # in your project
# or, to work on seaglass itself
git clone https://github.com/jcbmrshll/seaglass && cd seaglass && uv sync
```

The client depends on numpy and nothing else. The server depends on nothing beyond
the standard library.

## Serve

```sh
seaglass serve --dir runs --host 127.0.0.1 --port 8008
```

Runs are stored under `--dir`, laid out as described in SPEC.md §10. Open
http://127.0.0.1:8008 to see:

- **the run list**, filterable by project, tag and branch;
- **the project list**, each project with its run count and latest activity;
- **a project page**, which compares a project's runs: the runs down the side, each
  turned on or off, and a chart per metric with a line for each run turned on. The
  side expands into a table of how the runs' configs differ and how they did;
- **a run page**, which draws the run's layout with its bundle.

Pages poll while they're open, so a running run updates live.

## Log a run

```python
from seaglass import Arrays, Monitor, Row

# the server is $SEAGLASS_URL, else localhost:8008
monitor = Monitor(
    project="gridworld",
    views="views/",
    notes="does a smaller lr fix the late collapse?",
)
monitor.start(config={"lr": 3e-4}, total=300)
for step in range(300):
    monitor.activity(f"epoch {step}: training")
    ...
    data = {
        # a metric
        "loss": loss,
        # raw arrays, drawn by the bundle's renderer for the type
        "episode": Arrays("gridworld/episode", grid=g, path=p),
        # JSON, shown as a tree
        "summary": {"best": best},
        # a row of the "members" stream
        "members": Row(ids=ids, fitness=fitness),
    }
    monitor.log(step, data)
monitor.finish()
monitor.conclude("it does: no collapse by step 300, and the final return is 0.92")
```

- `log` only queues values. A background thread sends them, so the training loop never
  waits on the network.
- Logging never raises. If the server is down, the run keeps training and says so
  once.
- A heartbeat resends the current activity every 30 seconds, so the frontend can tell
  a busy run from a dead one.
- `with Monitor(...) as monitor:` finishes the run as `crashed` if the block raises.

What `log` takes:

| value | becomes |
|---|---|
| a number (python, numpy or jax scalar) | a metric; NaN and infinities are sent as null |
| `Arrays(type, **arrays)` | an `.npz` file and a media entry of that type |
| `Data(value, type=...)` or a plain dict | a `.json` file and a media entry |
| `File(bytes, ".png", type=...)` | a file and a media entry |
| `Row(**fields)` | a row of the stream named by the key |

At start the client also records provenance: git commit, branch and dirty flag, host,
argv and cwd. Three environment variables apply to every run:

- `SEAGLASS_URL`: the server, used when none is passed.
- `SEAGLASS_TAGS`: comma-separated labels attached to the run.
- `SEAGLASS_NOTES`: the run's notes, when none are passed, so you can say what a
  run is for as you launch it: `SEAGLASS_NOTES="lr warmup, 2x batch" python train.py`.

A run's **notes** say what it is testing and why. Its **conclusions** say what it
showed: a postmortem, kept with the run, of what was learned and what to try next.
A script can set them with `monitor.conclude(text)` (before or after `finish`; it
doesn't reopen the run), and anyone reading the run can write them later. Both show
at the top of the run's page, where you can write or edit them, and the run list and
the project page's filter search them. There is no environment variable for
conclusions, as a run hasn't shown anything when it's launched.

## Describe your metrics

`describe` says what a metric (or a media key) is, next to the code that logs it, so
someone reading the run can tell without asking you:

```python
monitor.describe("mean_return", "Mean undiscounted return of the epoch's episodes: "
                 "+1 at the goal, -0.01 a step.", better="higher", headline=True)
monitor.describe("loss/*", "TD loss per head. Spikes just after a target sync "
                 "are expected.", log=True, better="lower")
monitor.describe("episode_length", unit="steps")
monitor.describe("episode", "A greedy episode, played every 10 epochs.")
TD = monitor.describe("td_error", f"Mean |TD error|, gamma {cfg.gamma}.", log=True)
monitor.log(step, {TD: err, ...})   # describe returns the name: write it once
```

| argument | does |
|---|---|
| `description` | plain text behind an ⓘ on the metric's tile, chart and media card, on the run and project pages: what it measures, and what a good value looks like |
| `unit` | shown after its values |
| `log` | charts it on a log scale, unless a layout's chart says otherwise |
| `better` | `"higher"` or `"lower"`: the project page marks the best run's value and sorts best first |
| `headline` | one of the run's headline numbers: its tiles by default, and its columns in the run list and the project page's table |

- The first argument is a name or a pattern (`*` any characters, `?` any one); a
  name takes each field from the first description, in order, that matches it and
  has it.
- Call it before or after `start`. Describing a pattern again replaces what was said.
- Descriptions belong to the run, so a run is always shown with its own, and can say
  things about this run (`f"... over {cfg.decay} epochs"`).
- Once a run describes anything, the client prints the metrics it logs that have no
  description, and on finishing the descriptions that matched nothing it logged:
  what a renamed metric leaves behind.

[`examples/gridworld`](examples/gridworld) is a complete example: tabular Q-learning
whose episodes are drawn by its own bundle.

```sh
seaglass serve --dir runs &
uv run python examples/gridworld/train.py
```

## Write a bundle

A bundle is a directory with a `layout.json` and the ES modules it names. Pass it as
`Monitor(views=...)`. The client hashes the directory, uploads it if the server doesn't
already have that hash, and the run references the hash. Each run is drawn with the
bundle it shipped with, so changing the views later never changes how older runs
look.

**`layout.json`** says which module renders which media type, and lays out the run
page (SPEC.md §8). It only arranges: what each metric is comes from the run
(`describe`, above).

```json
{
  "contract": 1,
  "renderers": {"gridworld/episode": "episode.js"},
  "tabs": [
    {"title": "Training", "rows": [
      [{"type": "tiles"}],
      [{"type": "media", "keys": ["episode"]},
       {"type": "chart", "title": "return", "metrics": ["*_return"], "smooth": 5}],
      [{"type": "chart", "metrics": ["*"], "split": true}],
      [{"type": "config"}]
    ]},
    {"title": "Values", "panel": {"type": "view", "module": "values.js"}}
  ]
}
```

The panel types:

| type | shows |
|---|---|
| `tiles` | latest values: of `metrics`, else the run's headline metrics |
| `chart` | metrics by name or glob, with `smooth`, `log` and `split` options |
| `media` | a card per matching key, with a step scrubber; `columns` caps the cards in a row (`1`: each the full width) |
| `view` | a custom module |
| `config` | the run's config |

A `split` chart draws one chart per group of metrics (`loss/policy` and `loss/value`
together, `min_X`/`mean_X`/`max_X` together); its `groups` names more, as
`"groups": {"avg_outcome": "*_avg_outcome"}` charts every `<name>_avg_outcome`
together, with a series per `<name>`.

A row's panels share its width by their `width`. A tab with a single `panel` gives a
view the whole page. Anything beyond this vocabulary belongs in a custom view.

**A module** exports `render`:

```js
export async function render({ el, data, run, host }) {
  const arrays = await host.arrays(data.file);   // {name: {dtype, shape, data}}
  el.textContent = `${arrays.path.shape[0]} steps`;
  return {
    update(change) { /* change.data, .run, .location or .theme */ },
    destroy() {},
  };
}
```

- `data` is the media entry for a renderer, or the panel's `props` for a view.
- Every `host` method is async and passes only plain data (SPEC.md §7.3):
  - `run`, `metrics`, `entries`, `stream`: the run and its logs, read incrementally;
  - `file`, `json`, `arrays`: the run's files;
  - `theme`: the frontend's colours, which are also set as `--sg-*` CSS variables;
  - `location`, `navigate`: the step the page is looking at, its tab, and view state
    kept in the page's address. `navigate({state, replace: true})` updates the address
    without adding a Back entry, for state that tracks where the reader is (a move in
    a game they're stepping through) rather than somewhere to come back to;
  - `getPref`, `setPref`: preferences kept for the project.

Each module instance runs in its own sandboxed frame with an opaque origin, so a
module:

- can use its own document freely (styles in its `<head>`, key listeners, full
  screen);
- imports only relative paths inside its bundle. Vendor helpers rather than importing
  them from elsewhere; the client warns when it finds an import that breaks this;
- loads its own assets with `new URL("./style.css", import.meta.url)`;
- gets everything else from `host`. It can't use `localStorage`, and it can't reach the
  page around it.

`layout.json` declares the `contract` version it targets. A frontend draws a bundle
that targets a version it doesn't support with its default layout instead.

`examples/gridworld/views` shows all of this: an episode player that responds to the
keyboard, and a full-tab view that follows and moves the page's step.

## Embed the run page

Another app can draw a run, or compare runs, with this frontend's own pages: the
modules in `seaglass/static` depend on nothing of seaglass's page around them.

```js
import { mountRunPage } from "./seaglass/run-page.js";
import { mountCompare } from "./seaglass/comparison.js";
import { currentTheme } from "./seaglass/host.js";

const page = mountRunPage(el, {
  id,
  search: location.search,
  // where your server has the API and the bundles, and your address for a run
  paths: { api: "/seaglass/api", bundles: "/seaglass/bundles", run: (id) => `/seaglass/run/${id}` },
  theme: () => currentTheme(document.documentElement.dataset.theme),
  hooks: { head: (run) => closeButton, connected: (ok) => showConnected(ok) },
});
addEventListener("popstate", () => page.locationChanged(location.search));

const compare = mountCompare({ table, charts }, { runs, state: { smooth: "5", from: "100" } });
```

- Load `sg.css`, and set the `--sg-*` variables on `:root` to your colours.
- Each module's header comment lists its options and hooks: `run-page.js`,
  `comparison.js`, and `host.js` for a module's frame alone.
- A module's frame fetches nothing but its own bundle, so your server can refuse an
  opaque origin (`Origin: null`) everything else.

## Another server

Another implementation of the protocol can be checked against the suite:

```sh
seaglass conformance http://localhost:9000 -v
```

The cases live in `seaglass/conformance/cases/*.json`. Each is a recorded list of
request/response exchanges, whose matchers (SPEC.md §9) accept values a server picks
for itself. The cases only ever add runs, so the suite can run against a server that
already holds data.

## Develop

```sh
uv sync
uv run pytest                        # client, store, server, bundles, conformance, example
node --test tests/js/*.test.mjs      # the frontend's logic: layouts, charts' maths, npz, frames
uv run ruff check . && uv run ruff format --check . && uv run pyright
```
