# AGENTS.md — Nextcloud Playground debugging & dev guide

A practical guide for AI agents and humans working on this **browser PHP-WASM
playground**. It runs a full Nextcloud server entirely client-side: PHP is
compiled to WebAssembly (the WordPress Playground `@php-wasm` runtime) and the
whole stack (web server, PHP 8.3 + intl, SQLite) lives in the page. There is
**no backend** — everything happens in the browser tab. It is the first known
port of Nextcloud to php-wasm; the feasibility work and the exact patch set are
in [`docs/feasibility-spike.md`](docs/feasibility-spike.md) — **read it first**.

This is one of four sibling php-wasm playgrounds (nextcloud, moodle, omeka,
facturascripts) that share the same architecture. **nextcloud is the
original/reference implementation for the persistence model** described below.

---

## Overview / Architecture

The runtime is split across a few layers:

| Layer | File(s) | Role |
| --- | --- | --- |
| Shell (top window) | `index.html`, `src/shell/main.js`, `src/styles/app.css` | Chrome: address bar, side panel, settings, blueprint editor. Owns the `scopeId`. Renders `#site-frame`. |
| Remote bootstrapper | `remote.html`, `src/remote/main.js` | Loaded inside `#site-frame`. Registers the service worker + spawns the PHP worker, then points a nested iframe at the real scoped path. |
| Service worker | `sw.js` | Intercepts requests under the scoped path and forwards them to the PHP worker over a `BroadcastChannel`. Caches static assets. |
| PHP worker | `php-worker.js` (bundled → `dist/php-worker.bundle.js`) | Boots the PHP-WASM runtime, bootstraps Nextcloud, serves HTTP requests. Serial request queue + crash recovery. |
| Runtime internals | `src/runtime/*` | PHP loader, bootstrap/install scripts, FS persistence, blueprint steps, crash recovery, networking, VFS, spawn handler. |
| Shared helpers | `src/shared/*` | `config.js`, `paths.js` (URL routing), `protocol.js` (channel names), `storage.js` (scope/session), `blueprint.js`. |
| App loader | `lib/nextcloud-loader.js` | Downloads + caches the core bundle ZIP (manifest-driven, SHA-256 verified), unzips via fflate for the JS fallback path. |

Boot sequence (`src/runtime/bootstrap.js`):

1. Resolve the manifest (`assets/manifests/latest.json`) and download the core
   bundle ZIP (`lib/nextcloud-loader.js`, SHA-256 verified, Cache API cached).
2. Extract the Nextcloud core into MEMFS at `/www/nextcloud` (see
   "Core extraction via PHP `ZipArchive`" below).
3. Write the **posix polyfill** prepend and set `auto_prepend_file`
   (`src/runtime/php-prepend.js`).
4. Run `occ maintenance:install --database sqlite` in CLI mode
   (`src/runtime/install-script.js`), then merge playground config keys.
5. Execute blueprint steps via `occ` (`src/runtime/blueprint-steps.js`).
6. Serve pages through `php.request()` (`src/runtime/php-compat.js`), which maps
   `/index.php/...` PATH_INFO and clean URLs to the front controller.

**Provisioning is blueprint-driven.** A blueprint JSON (default
`assets/blueprints/default.blueprint.json`, overridable via
`?blueprint`/`?blueprint-url`/`?blueprint-data` query params) drives the
install + post-install steps. Shape: `meta`, `debug`, `landingPage`,
`siteOptions`, `admin`, `apps[]`, `steps[]` (`enableApp`, `disableApp`,
`createUser`, `createGroup`, `addUserToGroup`, `setConfig`, `runOcc`). Engine:
`src/shared/blueprint.js` + `src/runtime/blueprint-steps.js`.

**The worker is esbuild-bundled.** `php-worker.js` plus its `@php-wasm/*`
imports and the chosen PHP `.wasm` runtimes are bundled into
`dist/php-worker.bundle.js` (config: `scripts/esbuild.worker.mjs`,
`outdir: dist`, `entryNames: php-worker.bundle`). `src/remote/main.js` spawns
the worker from `../../dist/php-worker.bundle.js`, so **this file must exist
before the page can boot** — run `make bundle` first.

**Lint is Biome** (`biome.json`, `make lint`). **`@php-wasm/*` is pinned at
`^3.1.36`** (see `package.json`). Top-level Make targets: `make test`,
`make lint`, `make bundle`, `make serve`.

### The WASM patch set (critical)

The build (`scripts/build-nextcloud-bundle.sh`) applies source patches **gated
on `PHP_SAPI === 'wasm'`** so they are no-ops on a real server: treat occ (no
`REQUEST_URI`) as CLI under the `wasm` SAPI in `lib/base.php`, skip the
unreliable `flock` calls in `lib/private/Config.php`, skip the posix
owner-mismatch refusal in `console.php`, and guard `imagettfbbox` returning
`false`. Plus a posix polyfill (the runtime is built `--disable-posix`).
`proc_open`/`exec` cannot spawn, so previews/office/antivirus are disabled in
config. **SAPI is `wasm`, not `cli`** — that single fact drives base.php's occ
vs web routing.

---

## Running locally

```sh
make bundle    # builds dist/php-worker.bundle.js (deps + sync vendor + esbuild + bundle)
make serve     # starts the local dev server (scripts/dev-server.mjs)
# or: make up  # = bundle + serve
```

The serve target is literally:

```makefile
serve:
	PORT=$(PORT) node ./scripts/dev-server.mjs
```

`PORT` defaults to **8085** (top of the `Makefile`); the server binds
`127.0.0.1`, so open `http://127.0.0.1:8085/`.

> **CRITICAL gotcha — never use a privileged port.** The dev server binds the
> port from `PORT`. A privileged port (`<1024`, e.g. `80`) fails with
> `EACCES: permission denied`. **Always use a high port.** Examples:
>
> ```sh
> PORT=8087 make serve
> PORT=8087 node ./scripts/dev-server.mjs
> ```

> **`dist/php-worker.bundle.js` and `index.html` must exist** before you serve,
> otherwise the page loads but the worker spawn 404s and the runtime never
> boots. If you skipped it, run `make bundle` (or `npm run build-worker` for
> just the worker bundle). Note that `make bundle` also downloads + patches +
> trims the Nextcloud core (defaults `NC_MAJOR=33 NC_RELEASE=latest-33`), which
> takes a while the first time; `make bundle-all` builds NC 30/31/32/33.

The dev server (`scripts/dev-server.mjs`) is a tiny static file server that
also exposes an addon-download proxy at `/__addon_proxy__` (allow-listed hosts
only) used to fetch Nextcloud apps/plugins past CORS during local dev. It logs
`listening on http://127.0.0.1:<port>`.

---

## Scoped URL routing

The shell lives at the app root (`/` locally, `/nextcloud-playground/` on
GitHub Pages). The Nextcloud instance is served under a **scoped path** so the
service worker knows which PHP worker to route a request to:

```
<basePath>playground/<scopeId>/<runtimeId>/<path-inside-nextcloud>
```

- **`scopeId`** — a `crypto.randomUUID()` minted once and kept in
  `sessionStorage` under `nextcloud-playground:active`
  (`src/shared/storage.js`, `getOrCreateScopeId`). One scope per browser tab
  session. Can be pinned via `?scope=` in the URL.
- **`runtimeId`** — the id from `playground.config.json` `runtimes[]`, format
  `php<major><minor>-nc<version>`, e.g. **`php83-nc33`** (default),
  `php83-nc30/31/32`. Each maps to a PHP version + a Nextcloud version.

The scoped path is built by `buildScopedSitePath(scopeId, runtimeId, path)` in
`src/shared/paths.js`.

How the frames nest:

1. Shell renders `#site-frame` whose `src` is
   `remote.html?scope=<scopeId>&runtime=<runtimeId>&path=<path>`
   (`resolveRemoteUrl` in `src/shared/paths.js`).
2. `remote.html` (`src/remote/main.js`) registers `sw.js?scope=...&runtime=...`,
   spawns `php-worker.js?scope=...&runtime=...`, then points its own nested
   iframe at the real scoped path
   `playground/<scopeId>/<runtimeId>/<path>`.
3. The service worker intercepts that scoped request, strips the prefix, and
   forwards the unscoped request to the matching PHP worker over the
   `nextcloud-playground-php:<scopeId>` BroadcastChannel
   (`src/shared/protocol.js`).

Channel names: shell ↔ remote use `nextcloud-playground-shell:<scopeId>`;
SW ↔ PHP worker use `nextcloud-playground-php:<scopeId>`.

---

## Boot & readiness

**Boot is slow** — the PHP `.wasm` runtime loads, then the Nextcloud core is
extracted and `occ maintenance:install` runs against SQLite. This takes **tens
of seconds** (longer on a cold cache while the core bundle downloads). **Do not
assume the page is ready right after navigation; poll.**

Readiness signals (mirrored by the Playwright e2e suite, `tests/e2e/`):

- `#address-input` becomes **enabled** (it starts disabled).
- `#site-frame`'s `src` attribute **contains `scope=`**.

The e2e helper is the canonical check:

```js
// tests/e2e/shell.spec.mjs
await expect(page.locator("#address-input")).toBeEnabled();
await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
```

When driving the page from an automation tool, poll for **both** conditions
with a generous timeout (the e2e suite uses 180s).

---

## Persistence model

**nextcloud is the reference persistence implementation** for the sibling
playgrounds. All of it lives in `src/runtime/fs-persistence.js`, built on
`@php-wasm/fs-journal`. The VFS is MEMFS (resets on reload), so two journals
are kept in IndexedDB and replayed onto the fresh instance at boot.

Both journals use IndexedDB databases with a single object store named **`ops`**
(`autoIncrement` keys), `DB_VERSION = 1`, with a 1.5s debounced flush.

### 1. `/persist` — mutable app data (per scope)

- **Path journaled:** `/persist` — holds the **SQLite DB, config.php, and
  sessions** (i.e. real DATA, **not** derived caches).
- **IndexedDB name:** `nextcloud-fs-journal:<scopeId>`
  (`PERSIST_DB_PREFIX = "nextcloud-fs-journal"`).
- **Keyed by `scopeId`** → durability **within the session** (tab). A fresh
  tab gets a fresh scope and a fresh instance.
- Ephemeral SQLite temp files (`*.sqlite-journal`, `*.sqlite-wal`,
  `*.sqlite-shm`) are **skipped** — they live and die inside one transaction
  and cause hydration failures if journaled.

> **Why nextcloud never hit the moodle "persisting caches" bug:** its
> `/persist` holds DB/config/sessions only — *data, not derived caches*. The
> general lesson is **persist DATA, not derived caches.**

### 2. OPcache journal — cross-session, keyed by PHP version

- **Path journaled:** `/internal/shared/opcache` — PHP's compiled bytecode.
- **IndexedDB name:** `nextcloud-opcache:<phpVersion>`
  (`OPCACHE_DB_PREFIX = "nextcloud-opcache"`), e.g. `nextcloud-opcache:8.3`.
- **Keyed by `phpVersion`** → shared **across sessions/tabs** for the same PHP
  build. Persisting compiled bytecode means PHP compiles each file once across
  reloads, so **second and subsequent boots are dramatically faster**.
- OPcache ops are **replayed first** (before `/persist`) so the bytecode is on
  disk before any script runs.

This OPcache journal is **specific to nextcloud** among the siblings — it is
the extra optimization the reference implementation adds on top of the shared
`/persist` model.

### `replayResilient` — never brick boot on one bad op

Replay goes through `replayResilient(rawPhp, ops)`:

1. **Fast path:** replay the whole batch in one call (`replayFSJournal`).
2. **On any throw:** fall back to replaying **op-by-op**, skipping any op that
   throws.

**Why this matters (document this — it's the load-bearing pattern):** a journal
can contain a *dangling* op — e.g. a delete/unlink whose matching create was
never journaled (a CREATE in one runtime followed by a DELETE in another).
Replayed naively onto a fresh MEMFS, that unlink throws (the file isn't there),
and `replayFSJournal` aborts the **entire** batch — **bricking the boot**. A
failed unlink just means the file is already gone, which is the intended end
state, so skipping it is safe. `replayResilient` guarantees **one bad op never
prevents the rest of the journal from loading.**

> **General lesson (both halves):** (1) persist DATA, not derived caches; and
> (2) a persistence replay must NEVER brick boot on a single bad op — hence
> `replayResilient`.

---

## Core extraction via PHP `ZipArchive`

The Nextcloud core bundle is **huge** (~167 MB / ~15,500 files). It is
extracted into the webroot with **PHP's native `ZipArchive::extractTo`**, not
JavaScript — see `buildCoreExtractScript()` in
`src/runtime/install-script.js`.

**Why native, not JS:** the JS path (fflate `unzipSync` +
`writeEntriesToPhp` in `lib/nextcloud-loader.js`) decompresses every entry into
the JS heap at once, then copies the whole tree into MEMFS — that peak risks
**MEMFS OOM** on constrained clients (a partial install then 404s at runtime).
The streaming `decodeZip` alternative inflates one entry at a time but is far
too slow at this file count (boot blows past the readiness gate). libzip's
`extractTo()` inflates **and** writes one entry at a time in native code: fast
regardless of file count, with ~one-entry peak memory.

**Contract** — the script prints exactly one sentinel on stdout:

- `NO_ZIP_EXT` — the build lacks `ext/zip` (caller fails loud).
- `INSTALL_OK <count>` — extracted `<count>` entries into the target.
- `INSTALL_ERR <message>` — anything else (caller fails loud).

**Wrapper-folder detection:** the core zip wraps everything in a single
top-level folder (e.g. `nextcloud/`). The script extracts to a stage, and if
there is exactly **one** top-level entry and it's a directory, it descends into
that lone wrapper before moving it into place (root-level bundles with several
top entries are used as-is).

> **Watch out:** when deriving a wrapper prefix, derive it from the **RAW entry
> name**, not a sanitized one — sanitizing first can produce **doubled paths**.

`decodeZip` / the fflate JS path is now only used for **small add-ons** (apps),
via `buildZipExtractScript()` which does the same native-extract trick per app
with a JS fallback. The core always goes through `buildCoreExtractScript()`.

---

## Debugging recipes (copy-paste page-console snippets)

Run these in the **DevTools console of the page** (the top window / shell
origin). IndexedDB is per-origin, so the journals are visible from any frame on
the same origin.

**List all playground IndexedDB databases:**

```js
(await indexedDB.databases()).map((d) => d.name);
// expect: nextcloud-fs-journal:<scopeId>, nextcloud-opcache:<phpVersion>
```

**Find the current scope and runtime:**

```js
sessionStorage.getItem("nextcloud-playground:active");           // scopeId
document.querySelector("#site-frame")?.src;                      // contains scope= & runtime=
```

**Dump the `/persist` journal ops for the current scope:**

```js
const scope = sessionStorage.getItem("nextcloud-playground:active");
const db = await new Promise((res, rej) => {
  const r = indexedDB.open(`nextcloud-fs-journal:${scope}`, 1);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const ops = await new Promise((res, rej) => {
  const r = db.transaction("ops", "readonly").objectStore("ops").getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
console.log(ops.length, ops);   // each op has an operation + path
```

**Dump the OPcache journal (cross-session, keyed by PHP version):**

```js
const db = await new Promise((res, rej) => {
  const r = indexedDB.open("nextcloud-opcache:8.3", 1);   // adjust PHP version
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const ops = await new Promise((res, rej) => {
  const r = db.transaction("ops", "readonly").objectStore("ops").getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
console.log(ops.length);
```

**Wipe persistence for a truly clean boot** (e.g. when a corrupt journal is
suspected — though `replayResilient` should prevent bricking):

```js
const scope = sessionStorage.getItem("nextcloud-playground:active");
indexedDB.deleteDatabase(`nextcloud-fs-journal:${scope}`);
indexedDB.deleteDatabase("nextcloud-opcache:8.3");
sessionStorage.clear();
// then hard-reload
```

**Inspect the cached core bundle** (Cache API, name
`nextcloud-playground-bundles`):

```js
const c = await caches.open("nextcloud-playground-bundles");
(await c.keys()).map((r) => r.url);
```

**Admin credentials:** the playground keeps an admin session. Per
`playground.config.json`: username **`admin`**, password **`admin`**
(email `admin@example.com`). Auto-login is enabled (`autologin: true`).

---

## Build & test

```sh
make lint     # Biome:  npx @biomejs/biome check
make format   # Biome autofix:  npx @biomejs/biome check --fix
make test     # unit tests:  node --test tests/*.test.mjs
make test-e2e # Playwright:  npm run test:e2e  (tests/e2e/*.spec.mjs)
make bundle   # full bundle (deps + sync-browser-deps + build-worker + bundle)
```

- **`make lint` (Biome) auto-wraps long lines and enforces 2-space indent.**
  Match its formatting exactly — run `make format` (or `make lint`) before
  committing or the CI lint job fails.
- **Just the worker bundle:** `npm run build-worker` →
  `dist/php-worker.bundle.js`.
- **Confirm a change actually reached the bundle** (the worker runs the
  *bundled* file, not your source):

  ```sh
  grep <your-token> dist/php-worker.bundle.js
  ```

  If your edit is in `src/runtime/*` or `php-worker.js`, it does **nothing** at
  runtime until you re-bundle.

---

## CI gotchas

CI lives in `.github/workflows/ci.yml` (job `test` = unit + lint + docs, job
`e2e` = Playwright). Things that bite:

- **`vendor/` is absent in the unit-test job.** The `test` job runs
  `npm install` then `make test` / `make lint` **before**
  `npm run sync-browser-deps`, and `vendor/` is gitignored. So source files
  that are loaded by the unit tests / syntax-checked must import shared deps as
  **bare specifiers** — `import ... from "@php-wasm/fs-journal"`,
  `"fflate"`, `"@php-wasm/universal"`, etc. — **never** `../vendor/...`. The
  esbuild bundle + `sync-browser-deps` resolve those; the raw test run relies on
  Node resolving `node_modules`.
- **NEVER `git add -A`.** It sweeps in local `.claude/` artifacts and other
  untracked junk. **Stage explicit files only**, e.g. `git add AGENTS.md`.
- **CodeQL / least privilege:** the workflow sets
  `permissions: contents: read` at the top. Keep it — adding write scopes
  without need will trip security review.
- **e2e is a separate CI job** and it **does** build the bundle
  (`make bundle`, which needs PHP 8.3 via `setup-php`) before running
  Playwright. The unit-test job does **not** build the bundle.
- **The `test` job also builds the docs** (`mkdocs build --strict`), so a
  broken doc link fails CI. This `AGENTS.md` lives at the repo root and is not
  part of the mkdocs site, so it does not affect `--strict`.

---

## File map (quick reference)

| Concern | File |
| --- | --- |
| Make targets, default `PORT=8085`, `NC_MAJOR=33` | `Makefile` |
| Runtimes, admin creds, defaults | `playground.config.json` |
| FS persistence + `replayResilient` + OPcache | `src/runtime/fs-persistence.js` |
| Core/app extraction (`buildCoreExtractScript`, `buildZipExtractScript`) | `src/runtime/install-script.js` |
| VFS paths (`NEXTCLOUD_ROOT`, opcache dir) | `src/runtime/bootstrap-paths.js` |
| PHP worker entry (bundled) | `php-worker.js` → `dist/php-worker.bundle.js` |
| Scoped URL helpers | `src/shared/paths.js` |
| Scope/session storage | `src/shared/storage.js` |
| Channel names | `src/shared/protocol.js` |
| Service worker (request routing) | `sw.js` |
| Bundle download/cache, JS unzip fallback | `lib/nextcloud-loader.js` |
| Dev server + addon proxy | `scripts/dev-server.mjs` |
| Worker esbuild config | `scripts/esbuild.worker.mjs` |
| WASM patch set + bundle build | `scripts/build-nextcloud-bundle.sh` |
| Feasibility write-up + patch rationale | `docs/feasibility-spike.md` |
| e2e smoke tests | `tests/e2e/shell.spec.mjs` |
