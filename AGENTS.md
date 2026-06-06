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
