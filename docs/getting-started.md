# Getting started

## Try it online

Open the hosted build (the live demo link in the repository's README / GitHub
Pages site). Wait for the boot overlay to finish — on a cold load the browser
downloads and extracts the trimmed Nextcloud core bundle, then installs
Nextcloud against SQLite in the tab. This can take a while the first time; warm
loads are faster.

When boot completes you land on the Nextcloud login page (`/index.php/login`),
or — with autologin enabled — directly on the dashboard.

**Default credentials:**

- user: `admin`
- password: `admin`

Everything runs in your browser. State is **ephemeral by default**: closing or
hard-refreshing the tab discards changes (see [KNOWN-ISSUES](KNOWN-ISSUES.md)).

## Run locally

### Prerequisites

- Node.js 18+
- npm
- Git

(Composer is not required to run the playground; the Nextcloud core is fetched as
a release tarball, not built from source. Python 3 is only needed to preview the
docs with MkDocs.)

### Quick start

```bash
git clone https://github.com/ateeducacion/nextcloud-playground.git
cd nextcloud-playground
make up
```

Then open <http://localhost:8085/> and sign in with `admin` / `admin`.

`make up` builds the readonly Nextcloud bundle (first run only) and starts the
local dev server. Subsequent runs reuse the existing bundle.

### What `make up` does

```
make up = make bundle + make serve
```

- `make deps` — `npm install`
- `make prepare` — sync browser deps, build the service-worker bundle, prepare
  runtime assets
- `make bundle` — fetch a Nextcloud release, trim it, and produce the readonly
  bundle + manifest
- `make serve` — start the dev server on `PORT` (default 8085)

Override the port: `PORT=9090 make serve`.

## Common commands

```bash
make deps        # install npm dependencies
make prepare     # sync browser deps + build worker + prepare runtime
make bundle      # build the readonly Nextcloud bundle
make serve       # start the local dev server
make up          # bundle + serve
make test        # node --test unit tests
make test-e2e    # Playwright browser tests
make lint        # Biome linter (must pass clean)
make format      # auto-fix lint/format
make clean       # remove caches and bundle artifacts
make reset       # clean + drop the source cache
```

## Configuration at a glance

Two files drive the defaults:

- `playground.config.json` — global runtime defaults: `siteTitle`,
  `landingPath`, `locale`, `timezone`, `autologin`, `resetOnVersionMismatch`,
  `admin.{username,password,email}`, and the list of selectable PHP `runtimes`.
- `assets/blueprints/default.blueprint.json` — the blueprint applied on boot
  (landing page, login credentials, apps, config, users/groups, files, shares).

To change the admin password, edit `admin.password` in `playground.config.json`
and/or `login.password` in the default blueprint. See
[blueprint-json.md](blueprint-json.md) for the full blueprint reference.

## Loading a custom blueprint

Pass a blueprint inline (base64 of the JSON) or by URL:

```
http://localhost:8085/?blueprint=<base64-of-json>
http://localhost:8085/?blueprint-url=https://example.com/my.blueprint.json
```

## Rebuild the bundle

```bash
make bundle
```

To build against a different Nextcloud release, override the release id (see
`src/shared/nextcloud-versions.js` and `scripts/fetch-nextcloud-release.sh`).
Supported majors today: 30, 31 (default), 32 — all on php-wasm 8.3.

## Preview the documentation

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-docs.txt
mkdocs serve   # http://127.0.0.1:8000/
```

## Sanity checks

```bash
make test
make lint
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
```
