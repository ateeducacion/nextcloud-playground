# AGENTS.md — Nextcloud Playground

Guidance for AI agents and contributors working in this repository.

## What this is

A browser-based playground that runs **Nextcloud server** entirely client-side
via php-wasm (the WordPress Playground `@php-wasm` runtime), like the sibling
Moodle / Omeka S / FacturaScripts playgrounds. It is the first known port of
Nextcloud to php-wasm; the feasibility work and the exact patch set are in
[`docs/feasibility-spike.md`](docs/feasibility-spike.md) — **read it first**.

## Architecture

```
index.html → remote.html → sw.js (Service Worker) → php-worker.js
  → @php-wasm (PHP 8.3 + intl)
      ├─ Nextcloud core in MEMFS (extracted from a per-version ZIP bundle)
      └─ SQLite + data dir in MEMFS (ephemeral)
```

Boot sequence (`src/runtime/bootstrap.js`):
1. Resolve the per-version manifest (`assets/manifests/nextcloud-<major>.json`).
2. Extract the ZIP bundle into MEMFS at `/www/nextcloud` (`src/runtime/vfs.js`,
   `lib/nextcloud-loader.js`).
3. Write the **posix polyfill** prepend and set `auto_prepend_file` +
   `memory_limit=512M` (`src/runtime/php-prepend.js`).
4. Run `occ maintenance:install --database sqlite` in CLI mode
   (`src/runtime/install-script.js`), then merge playground config keys.
5. Execute blueprint steps via `occ` (`src/runtime/blueprint-steps.js`).
6. Serve pages through `php.request()` (`src/runtime/php-compat.js`), which maps
   `/index.php/...` PATH_INFO and clean URLs to the front controller.

## The WASM patch set (critical)

The build (`scripts/build-nextcloud-bundle.sh`) applies five source patches,
**all gated on `PHP_SAPI === 'wasm'`** so they are no-ops on a real server:

1. `lib/base.php` — treat occ (no `REQUEST_URI`) as CLI under the `wasm` SAPI.
2. `lib/private/Config.php` — skip the unreliable shared `flock` (×1).
3. `lib/private/Config.php` — skip the unreliable exclusive `flock` (×1).
4. `console.php` — skip the posix uid/owner-mismatch refusal.
5. `lib/private/Avatar/Avatar.php` — guard `imagettfbbox` returning `false`.

Plus the posix polyfill (the build is `--disable-posix`; Nextcloud requires
posix and calls it unguarded). occ is invoked by requiring `console.php`, never
`occ` directly (its shebang breaks `declare(strict_types=1)`).

## Build & commands

```
make prepare     # sync browser deps + build worker bundle
make bundle      # build one bundle (NC_MAJOR / NC_RELEASE env, default 31)
make bundle-all  # NC 30, 31, 32
make serve       # http://localhost:8085
make test        # node --test tests/*.test.mjs
make test-e2e    # Playwright
make lint        # Biome
```

Nextcloud **release tarballs** are pre-built (vendor/ + compiled JS included), so
the build does NO composer/npm — it downloads, patches, trims (~807 MB → ~345 MB),
and zips per version. Supported versions live in
`src/shared/nextcloud-versions.js`.

### Validation harnesses (node, headless)

- `spike/run-spike.mjs` — NODEFS-mount the raw source, install, render login.
- `spike/boot-from-bundle.mjs` — extract the BUILT bundle into MEMFS (the real
  browser path) and boot it. Run after `make bundle` to validate end-to-end.

## Blueprints

JSON → `occ` commands. Shape: `meta`, `debug`, `landingPage`, `siteOptions`,
`admin`, `apps[]` (shorthand for `enableApp`), `steps[]`. Step types:
`enableApp`, `disableApp`, `createUser`, `createGroup`, `addUserToGroup`,
`setConfig`, `runOcc`. Engine: `src/shared/blueprint.js` +
`src/runtime/blueprint-steps.js`. Schema: `assets/blueprints/blueprint-schema.json`.

## Skills

Specialist skills under `.agents/skills/`: `nextcloud-internals` (occ, config,
the patch set — start here), `wasm-browser-runtime`, `wp-playground-php-wasm`,
`blueprint-provisioning`, `unit-testing`, `e2e-playwright`.

## Gotchas

- SAPI is `wasm`, not `cli` — drives the base.php patch and occ vs web routing.
- `proc_open`/`exec` can't spawn; previews, office, antivirus are disabled in
  config (`enabledPreviewProviders => []`). See `docs/KNOWN-ISSUES.md`.
- State is ephemeral (MEMFS). Each boot reinstalls (~4 s).
- Bundle size is the main browser constraint; the build trims aggressively.
  Removing more shipped apps (in the build script's trim list) shrinks it further.
- Never add AI attribution to commits or PRs.

## Debugging

### By hand (in the browser)

Serve locally and open it in a browser:

```
make serve            # http://localhost:8085 (PORT defaults to 8085)
# PORT=9090 make serve # override; a port < 1024 fails with EACCES
```

Then open `http://localhost:<port>/`. The page at `/` is the **shell** — it boots a
Web Worker (PHP) plus a Service Worker that serves the actual Nextcloud app under
`/playground/<scope>/<runtime>/…` inside the `#site-frame` iframe. `<scope>` is a
sessionStorage id (a `crypto.randomUUID()` under `nextcloud-playground:active`), so a
scope lives only within the browser session. The runtime is **slow to boot** — it is
ready when `#address-input` is enabled (and `#site-frame`'s `src` carries a `scope=`),
so poll for it rather than assuming it is up. Log in with the admin creds from
`playground.config.json` (`admin` / `admin`).

Persistence lives in IndexedDB and is keyed two ways (see `src/runtime/fs-persistence.js`):

- `nextcloud-fs-journal:<scope>` — `/persist`, per-session **real** data only (DB,
  config, sessions); derived caches are deliberately *not* persisted here.
- `nextcloud-opcache:<phpVersion>` — `/internal/shared/opcache`, cross-session OPcache
  so PHP recompiles only once (later sessions boot much faster).

Both use the `ops` object store. Dump a journal from the **page console**:

```js
const dump = (name) => new Promise((resolve, reject) => {
  const open = indexedDB.open(name);
  open.onsuccess = () => {
    const all = open.result.transaction("ops", "readonly").objectStore("ops").getAll();
    all.onsuccess = () => resolve(all.result);
    all.onerror = () => reject(all.error);
  };
  open.onerror = () => reject(open.error);
});
const scope = sessionStorage.getItem("nextcloud-playground:active");
console.log("persist", await dump(`nextcloud-fs-journal:${scope}`));
console.log("opcache", await dump("nextcloud-opcache:8.3"));
```

On reload the journals are re-applied via `replayResilient`, which replays the whole
batch first and, on any failure, retries op-by-op and skips the un-appliable ones — so a
single bad journal op (e.g. a dangling unlink) never bricks boot. Note the core itself is
extracted into the webroot by PHP's `ZipArchive` (`buildCoreExtractScript` in
`src/runtime/install-script.js`), not unzipped in JS, to avoid MEMFS OOM.

### With the e2e suite (Playwright)

Tests live in `tests/e2e/*.spec.mjs` (currently `shell.spec.mjs`). Run them with:

```
make test-e2e   # = npm run test:e2e = playwright test
```

`playwright.config.mjs` starts the dev server on port 8085 itself (running `make up` if no
bundle exists yet) and points `baseURL` at `http://127.0.0.1:8085`; set
`PLAYWRIGHT_EXTERNAL_SERVER=1` to drive an already-running server. The specs cover the boot
gate (waiting on `#address-input` + the scoped `#site-frame` src), the side panel /
phpinfo / blueprint tabs, and the persistence round-trip.

**Gotcha:** run each sibling playground's e2e on its own. `reuseExistingServer` (enabled
outside CI) means concurrent Playwright runs latch onto whatever is already listening on
port 8085, so two playgrounds running at once share a dev server and cross-contaminate each
other's apps.

## Persistence model (per-tab storage + blueprint reset)

Mutable state under `/persist` is journaled to IndexedDB (`nextcloud-fs-journal:<scope>`) via
`@php-wasm/fs-journal`, so it survives reloads. Key facts for future work:

- **Per-tab, within-session.** `scopeId` lives in `sessionStorage`, so each
  browser tab/window has its own environment. Opening the playground in a new tab
  starts clean — nothing is shared (only *duplicating* a tab copies
  `sessionStorage`). State is lost when the tab closes.
- **A different blueprint starts fresh.** The persisted env is keyed by the
  blueprint *source* — `blueprintSourceKey(href)` in `src/shared/paths.js`
  (`url:<value>` for `?blueprint-url=`, `inline:<hash>` for `?blueprint=` /
  `?blueprint-data=`, else `default`) — remembered per scope in `sessionStorage`
  (`blueprint-source:<scope>`). Loading a **different** blueprint in the same tab
  forces a clean boot (discards the previous `/persist` and installs fresh);
  **reloading the same blueprint keeps the data.** (Same intent as WordPress
  Playground, which serves URL blueprints as temporary by default and keys
  persisted sites per site-slug.)
- **Clean boot wiring.** On a clean boot the shell adds `&clean=1` to the
  `#site-frame` remote URL; the worker then `clearJournal`s and **re-starts
  journaling** (`initFsPersistence` runs after the clear in
  `src/runtime/php-loader.js`) so the fresh env persists on later reloads. The
  `#reset-button` triggers the same path.
- **Flush.** On each debounced flush the journal collapses ops *before* hydrating
  (`collapseAndHydrate` = `hydrateUpdateFileOps(php, normalizeFilesystemOperations(ops))`)
  so a heavy install that rewrites the SQLite DB hundreds of times doesn't OOM.
- **Inspect:** `await indexedDB.databases()` → open `nextcloud-fs-journal:<scope>` → read the
  `ops` object store.
