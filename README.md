# Nextcloud Playground

> Run a full Nextcloud server in the browser — no server required.

Nextcloud Playground runs [Nextcloud](https://nextcloud.com) entirely in the
browser using WebAssembly, powered by [WordPress Playground](https://github.com/WordPress/wordpress-playground)'s
`@php-wasm` runtime. Every page load boots a fresh Nextcloud instance backed by
an in-browser SQLite database — nothing is stored on a server and nothing leaves
your browser.

It is a sibling of the Moodle, Omeka S, and FacturaScripts playgrounds, and the
**first known port of Nextcloud to php-wasm**. See
[`docs/feasibility-spike.md`](docs/feasibility-spike.md) for how that was proven.

## Getting started

### Run it locally

```bash
git clone https://github.com/ateeducacion/nextcloud-playground.git
cd nextcloud-playground
make up
```

Then open <http://localhost:8085>.

**Default credentials:** username `admin`, password `admin`.

### Prerequisites

- Node.js 18+
- npm
- PHP 8.3 (used by the build to read the bundled release version)
- Python 3 (for the docs site, optional)

## How it works

```text
index.html          Shell UI (toolbar, address bar, log panel)
  └─ remote.html    Runtime host — registers the Service Worker
       ├─ sw.js     Intercepts requests → routes to the PHP worker
       └─ php-worker.js
            └─ @php-wasm (WebAssembly, PHP 8.3 + intl)
                 ├─ Nextcloud core in writable MEMFS  (extracted from a ZIP bundle)
                 └─ In-memory state                   (SQLite + data dir in MEMFS)
```

On boot the PHP worker extracts the Nextcloud bundle into MEMFS, installs a
**posix polyfill** (`auto_prepend_file`), and runs `occ maintenance:install`
against SQLite. A handful of `PHP_SAPI === 'wasm'`-gated source patches make
Nextcloud's posix, file-locking, and avatar code paths WASM-safe — see
[`docs/feasibility-spike.md`](docs/feasibility-spike.md).

State is **ephemeral by design** (MEMFS resets when you close the tab), matching
the sibling playgrounds.

### Supported versions

Multi-version: **Nextcloud 30 / 31 / 32** on PHP 8.3 (default 31). Versions are
declared in [`src/shared/nextcloud-versions.js`](src/shared/nextcloud-versions.js).

## Blueprints

Blueprints are JSON files that provision an instance at boot, translated to
`occ` commands. Override the default with `?blueprint-url=<url>` or
`?blueprint=<inline-json-or-base64>`.

```json
{
  "landingPage": "/index.php/apps/dashboard",
  "admin": { "username": "admin", "password": "admin" },
  "apps": ["activity", "text"],
  "steps": [
    { "step": "createGroup", "group": "staff" },
    { "step": "createUser", "username": "alice", "password": "alicepass", "groups": ["staff"] },
    { "step": "setConfig", "key": "default_language", "value": "en" }
  ]
}
```

See [`docs/blueprint-json.md`](docs/blueprint-json.md) for all step types and
[`assets/blueprints/default.blueprint.json`](assets/blueprints/default.blueprint.json).

## Development

```bash
make prepare     # sync browser deps + build the worker bundle
make bundle      # build one Nextcloud bundle (default NC 31)
make bundle-all  # build NC 30, 31 and 32
make serve       # serve at http://localhost:8085
make test        # unit tests
make test-e2e    # Playwright browser tests
make lint        # Biome
```

The build downloads a Nextcloud **release tarball** (pre-built, no
composer/npm), applies the WASM patches, trims it (~807 MB → ~345 MB), and zips
it per version into `assets/nextcloud/`. See
[`docs/development.md`](docs/development.md).

## Known limitations

Preview generation, office/collaborative editing, antivirus, and anything using
`proc_open`/`exec` do not work under WASM; letter avatars fall back to a solid
colour; cron is AJAX-only; storage is ephemeral. See
[`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md).

## License

[AGPL-3.0-or-later](LICENSE).
