# Development

This page covers the architecture, the build pipeline, and how to add a
Nextcloud version. The authoritative reference for *why* Nextcloud runs at all
under php-wasm is [feasibility-spike.md](feasibility-spike.md) — read it first.

## Architecture

The playground is a static site with five layers and **no backend**. PHP runs in
the browser via `@php-wasm`.

```text
index.html
  -> src/shell/main.js            (toolbar, iframe host, blueprint import/export, status)
     -> remote.html
        -> src/remote/main.js     (registers the service worker, hosts the scoped iframe)
           -> sw.js               (intercepts same-origin requests, routes to the runtime)
              -> php-worker.js     (owns the @php-wasm PHP instance, crash recovery)
                 -> src/runtime/bootstrap.js   (mount core, install, config, blueprint, autologin)
                 -> src/runtime/vfs.js         (mount the readonly core bundle into MEMFS)
                 -> @php-wasm/web (via php-loader.js + php-compat.js)
```

Responsibilities:

- **Shell UI** (`index.html`, `src/shell/main.js`, `src/styles/app.css`) —
  address bar, side panel, blueprint editor, runtime/PHP-version settings.
- **Runtime host** (`remote.html`, `src/remote/main.js`) — registers the SW and
  hosts the scoped Nextcloud iframe with a boot progress overlay.
- **Routing** (`sw.js`, `php-worker.js`) — the service worker classifies
  requests (static asset / scoped runtime / other) and forwards scoped requests
  to the PHP worker; the worker runs them through `@php-wasm` with crash
  recovery.
- **Runtime boot** (`src/runtime/*`) — see the boot flow below.
- **Local dev server** (`scripts/dev-server.mjs`).

### Boot flow (`src/runtime/bootstrap.js`)

1. **Resolve config + blueprint.** Merge `playground.config.json` with the active
   blueprint into the effective config.
2. **Load the manifest** and compare to persisted state (`manifestVersion`). If
   the persisted DB matches the current bundle and we're not doing a clean boot,
   skip the install and just re-apply lightweight steps.
3. **Mount the readonly core** — extract the trimmed Nextcloud ZIP bundle into
   **MEMFS** under the Nextcloud root (`src/runtime/vfs.js`). The Phase-0 spike
   instead mounts the source over **NODEFS** (no copy) in Node; the browser must
   extract into MEMFS, which is the bundle-size constraint.
4. **Create the mutable layout** — data directory, SQLite location, sessions,
   under `/persist/...`.
5. **Write config and the PHP prepend.** `auto_prepend_file` installs the
   **posix polyfill** and per-request server setup (`src/runtime/php-prepend.js`,
   written to `/internal/shared/auto_prepend_file.php` — the only path `@php-wasm`
   reads). Apply php.ini via `setPhpIniEntries()`.
6. **Install Nextcloud** — run `occ maintenance:install --database sqlite ...`
   through the shebang-free `console.php` wrapper (see below), then set the
   WASM-safe config flags (`filelocking.enabled => false`,
   `enabledPreviewProviders => []`, `check_data_directory_permissions => false`,
   no `memcache.local`, plus `trusted_domains` and `overwrite.cli.url`).
7. **Apply the blueprint** — users, groups, apps, config, files, shares (each via
   `occ` or a web request). See [blueprint-json.md](blueprint-json.md).
8. **Autologin** the admin user (when enabled) so the iframe lands on the
   dashboard with a valid session cookie.

### Why the patches exist

Under `@php-wasm`, `php_sapi_name()` returns **`wasm`** and the build is
`--disable-posix`. Nextcloud is made to run with:

- a **posix polyfill** (`auto_prepend_file`, fake `www-data` uid 33), and
- a **five-patch source set** gated on `PHP_SAPI === 'wasm'` (no-ops on a real
  server): `base.php` CLI detection, two `Config.php` `flock` guards, the
  `console.php` owner check, and the `Avatar.php` letter-avatar bbox fallback.

The exact lines and rationale are in [feasibility-spike.md](feasibility-spike.md)
and the `nextcloud-internals` agent skill.

### The occ wrapper

`occ` cannot be `require`d directly — its `#!/usr/bin/env php` shebang is emitted
as text and breaks `declare(strict_types=1)`. Run a shebang-free wrapper as the
**main** script that sets `$_SERVER['argv']`/`argc`, `unset($_SERVER['REQUEST_URI'])`
(so patched `base.php` treats it as CLI), `chdir()`s into the Nextcloud root, and
`require`s `console.php`. The reference implementation is the `occ()` helper in
`spike/run-spike.mjs`.

### Storage model

- **Readonly core** — mounted into MEMFS under the Nextcloud root (never copied
  into persistent storage wholesale).
- **Mutable data dir + SQLite** — under `/persist/...`, journalled to browser
  persistence; ephemeral by default.
- **Sessions** — file-based under the persisted session path.

## Build pipeline

```bash
make deps        # npm install
make prepare     # sync-browser-deps + build-worker + prepare-runtime
make bundle      # fetch a Nextcloud release, trim it, emit bundle + manifest
make serve       # dev server (PORT, default 8085)
make up          # bundle + serve
```

Key scripts (`scripts/`):

- `fetch-nextcloud-release.sh` — download a Nextcloud release tarball.
- `build-nextcloud-bundle.sh` — trim and package the readonly core bundle.
- `generate-manifest.mjs` — emit the bundle manifest the runtime reads.
- `prepare-runtime.mjs`, `sync-browser-deps.mjs` — runtime/browser asset prep.
- `esbuild.worker.mjs` — bundle the service worker to a root-level classic IIFE
  (Firefox does not support ES-module service workers).

The runtime readers that must stay in sync with the bundle layout:
`src/runtime/manifest.js` and `src/runtime/vfs.js`. If you change the bundle
structure, update the manifest generator and these readers together.

### Bundle trimming (the size problem)

Nextcloud 31 extracts to **807 MB / 26,865 files** — too heavy for a browser
tab. The build trims aggressively: strip `**/tests/`, `**/*.map`, `**/cypress/`,
`**/screenshots/`, `**/l10n/*.po`; drop heavy optional apps and `updater/`; keep
`dist/` (compiled UI) and `3rdparty/`; keep the default-enabled core app set. If
a trimmed MEMFS bundle is still too large, the fallback is an OPFS-backed mount
for the readonly core. Details in [feasibility-spike.md](feasibility-spike.md)
and the `wasm-browser-runtime` skill.

## How to add a Nextcloud version

1. Add an entry to `src/shared/nextcloud-versions.js`:

   ```js
   { major: "33", release: "latest-33", php: "8.3", default: false }
   ```

   - `major` — used for the manifest file name and bundle directory.
   - `release` — the release id passed to `scripts/fetch-nextcloud-release.sh`.
   - `php` — the php-wasm runtime version it is built/tested against.
   - `default` — exactly one entry should be `true`.

2. Build the bundle for that release (`make bundle`, with the release override
   as needed) and confirm the manifest is generated.

3. Verify the WASM patch set still applies cleanly against the new source (the
   patched line numbers in `lib/base.php`, `lib/private/Config.php`,
   `console.php`, `lib/private/Avatar/Avatar.php` can shift between majors).

4. Smoke-test: `occ maintenance:install` exits 0, `occ status` / `status.php`
   reports installed with the right `versionstring`, and `/index.php/login`
   renders. The Phase-0 spike (`spike/run-spike.mjs`) is the template.

## Testing

```bash
make test       # node --test tests/*.test.mjs (pure helpers, blueprint, prepend)
make test-e2e   # Playwright browser suite (shell, runtime, blueprint)
make lint       # Biome — must pass clean
```

See the `unit-testing` and `e2e-playwright` agent skills for conventions.

## Performance comparisons

When working on boot time, bundle size, persistence, service worker
caching, or other performance-sensitive changes, use the comparison script:

```bash
node scripts/perf-compare.mjs \
  --base=https://nextcloud-playground.pages.dev/ \
  --candidate=https://<your-branch-or-pr>.nextcloud-playground.pages.dev/ \
  --iterations=5
```

Key flags:

- `--base` / `--candidate` (also accept `--prod` / `--preview`, `--before` / `--after`)
- `--iterations=N` (default 3; boots are expensive)
- `--no-clean` — measure warm boots (caches, SW, IndexedDB journals, OPcache)
- `--headed` — visible browser for debugging
- `--json` — machine-readable output for archiving results
- `--label-base=... --label-candidate=...` — nicer names in the report

The script forces **clean boots** by default (unique `?blueprint-data=` on every
run). This exercises the full expensive path: streaming the core bundle,
extracting into MEMFS, running `occ maintenance:install`, etc. This is usually
the path you care about for performance PRs.

Make target (basic usage):

```bash
BASE=https://nextcloud-playground.pages.dev/ \
CANDIDATE=https://my-pr-slug.nextcloud-playground.pages.dev/ \
ITERATIONS=5 make perf-compare
```

See the top of `scripts/perf-compare.mjs` for more examples and caveats
(network variance, Cloudflare POPs, etc.).

Typical workflow for a perf PR:

1. Open a PR → Cloudflare Pages posts a preview URL in the comments.
2. Run the comparison locally against production (or against `main`).
3. Paste the summary (or the JSON) into the PR description or a comment.
4. Optionally re-run with `--no-clean` to show warm-boot improvements.

## When to update docs

Update docs in the same change if you touch: `playground.config.json`, the
default blueprint, the boot flow in `src/runtime/bootstrap.js`, the storage /
manifest model, the bundle build, the WASM patch set, or the SW routing.
