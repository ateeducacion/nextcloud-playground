---
name: wasm-browser-runtime
description: WebAssembly and browser runtime expert for the Nextcloud playground. Use when debugging WASM crashes (OOM, unreachable traps, memory access out of bounds), working with Emscripten MEMFS vs NODEFS, the Nextcloud bundle-size / memory problem (807 MB extracted), trimming strategy, a possible OPFS-backed core mount, service worker request routing, Web Worker comms, crash recovery, and GitHub Pages subpath handling. Adapted from the Moodle skill of the same name to this repo's specifics.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# WebAssembly & Browser Runtime Expert (Nextcloud)

## Role

You are an expert in running server-side PHP/Nextcloud inside a browser sandbox
via WebAssembly: Emscripten's virtual filesystem (MEMFS / NODEFS), Web Worker
and Service Worker architecture, browser memory limits, crash recovery, and the
**single biggest risk in this project — Nextcloud's bundle size vs browser
memory**. Ground every memory/bundle claim in
[`docs/feasibility-spike.md`](../../../docs/feasibility-spike.md).

## When to activate

- Investigating WASM crashes (`RuntimeError: unreachable`,
  `memory access out of bounds`, `table index is out of bounds`)
- Working on crash recovery (`src/runtime/crash-recovery.js`)
- Bundle trimming / memory pressure during boot (the 807 MB problem)
- Considering an OPFS-backed mount for the readonly core
- Working on the service worker (`sw.js`) — routing, caching, HTML rewriting
- Web Worker comms (`php-worker.js` ↔ main / remote)
- GitHub Pages / static subpath deployment

## MEMFS vs NODEFS

Two Emscripten filesystem backends are relevant; the playground uses **MEMFS** in
the browser, while the Phase-0 node spike used **NODEFS**.

| Backend | Where | Behaviour |
|---|---|---|
| **MEMFS** | Browser runtime | File contents are JS `Uint8Array` objects on the JS heap; the dir tree is a JS object graph. Fast, synchronous, **ephemeral** (tab close = data loss), bounded by JS heap. The Nextcloud core ZIP is extracted **into MEMFS**. |
| **NODEFS** | `@php-wasm/node` spike only | Mounts a real host directory with **no copy** (`createNodeFsMountHandler`). The spike mounts the extracted Nextcloud source over NODEFS — which is why the spike doesn't hit the browser memory wall. |

**Key consequence:** the spike's 4.5s warm install over NODEFS does **not** prove
the browser case. In the browser, all 807 MB would have to be extracted into
MEMFS (JS heap) — the open risk Phase 2 must solve.

When PHP reads a MEMFS file, Emscripten copies bytes from the JS `Uint8Array`
into WASM linear memory; writes go the other way. Large files transiently consume
memory in **both** places. ZIP extraction of the core bundle is the peak memory
moment.

## The bundle-size / memory problem (this repo's defining constraint)

Nextcloud 31 extracts to **807 MB / 26,865 files**. Breakdown: `apps/` 509 MB,
`core/` 120 MB, `3rdparty/` 90 MB, `dist/` 69 MB. Much of `apps/` is source maps,
tests, and heavy optional apps (`password_policy` 112 MB, `photos` 57 MB,
`text` 50 MB, `suspicious_login` 32 MB, `files_pdfviewer` 26 MB…). A browser tab
cannot hold that in MEMFS.

### Build-time trimming strategy (Phase 2)

Target a small MEMFS bundle:

- Strip `**/tests/`, `**/*.map`, `**/cypress/`, `**/screenshots/`, `**/l10n/*.po`.
- Remove heavy optional shipped apps not needed for a demo; keep the
  default-enabled core set (`files`, `dav`, `dashboard`, `activity`, `settings`,
  `theming`, `notifications`, `comments`, `systemtags`,
  `files_sharing`/`files_trashbin`/`files_versions`, `viewer`, `text`,
  `firstrunwizard`, `provisioning_api`, `user_status`, `weather_status`,
  `federatedfilesharing`, …).
- Drop the unused `updater/`, large fonts, and dev assets.
- **Keep** `dist/` (compiled UI) and `3rdparty/` vendor runtime code.

This trimming lives in the bundle build (`scripts/build-nextcloud-bundle.sh`,
`scripts/fetch-nextcloud-release.sh`, `scripts/generate-manifest.mjs`). Keep the
manifest generator and the runtime mount reader (`src/runtime/vfs.js`,
`src/runtime/manifest.js`) in sync when the bundle layout changes.

### OPFS fallback

If a trimmed MEMFS bundle is still too large, fall back to an **OPFS-backed mount**
for the readonly core, while the mutable data dir + SQLite stay in MEMFS/persisted.
OPFS gives durable, larger storage at the cost of async I/O and more complex
mounting; treat it as the escape hatch, not the default.

## WASM memory model

- Linear memory starts at ~256 MB and grows up to ~2–4 GB (browser-dependent);
  it can only **grow**, never shrink.
- OOM manifests as `RuntimeError: memory access out of bounds` or `unreachable`.
- Total pressure = WASM linear memory + JS heap (MEMFS contents) + DOM. With
  Nextcloud, MEMFS is the dominant term — hence aggressive trimming.
- File descriptors: Emscripten's table (~1024) can be exhausted over long
  sessions; exhaustion also surfaces as `unreachable`.
- Single-threaded: each PHP request runs sequentially; `max_execution_time` is
  `0` to avoid timeouts on slow boots.

### Surviving a crash

MEMFS data lives in the JS heap, **not** WASM linear memory, so after a WASM trap
the filesystem is still readable. Crash recovery can snapshot the SQLite DB and
mutable data dir from the dying runtime before creating a fresh one.

## Service Worker architecture (`sw.js`)

```
Browser/iframe
  → Service Worker (sw.js)
     ├── static asset?  → Cache API / network
     ├── scoped runtime request? → Web Worker (php-worker.js) → php.run(...)
     └── other → network
  → SW rewrites HTML responses (links/forms/redirects) to stay in scope
```

Nextcloud-specific routing notes:

- Front controller is `index.php`; pretty URLs like `/index.php/login` and
  `remote.php`/`ocs/` endpoints flow through the SW.
- WebDAV goes through `remote.php`; keep its routing intact.
- `overwrite.cli.url`, `overwriteprotocol`, and `trusted_domains` must match the
  origin/subpath the SW serves, or Nextcloud rejects the request as untrusted or
  builds wrong asset URLs.
- Preserve query strings and fragments across scoped redirects.

### Firefox / classic SW

ES-module Service Workers are unsupported in Firefox; the SW is bundled to an
IIFE (`scripts/esbuild.worker.mjs` → `npm run build-worker`) and **must live at
the project root** so its scope covers the app. Don't move it into `dist/`.

## Web Worker communication (`php-worker.js`)

`php-worker.js` owns the `@php-wasm/web` PHP instance for a scope and bridges
requests via `postMessage`/`BroadcastChannel` (`src/shared/protocol.js`). It
reports boot progress through phases (runtime init → ZIP extraction → occ install
→ config/blueprint → autologin). Keep messages serializable (no
non-transferable objects).

## Crash recovery (`src/runtime/crash-recovery.js`)

1. Detect a fatal WASM error by message pattern (`unreachable`,
   `memory access out of bounds`, …).
2. Snapshot the SQLite DB + mutable data dir from MEMFS (JS heap survives).
3. Discard the old PHP instance; create a fresh one via `loadWebRuntime()`.
4. Re-bootstrap (mount core → restore snapshot → config), then re-register state.
5. Replay only idempotent (GET/HEAD) requests; never replay POST/PUT/DELETE.
6. Anti-loop guards bound the number of restarts per session.

## GitHub Pages / subpath deployment

- Do not assume the app is hosted at `/`; it may run under a subdirectory
  (`/nextcloud-playground/...`). Use `src/shared/paths.js` for base-path math.
- `overwrite.cli.url` / `overwriteprotocol` must include the subpath so
  Nextcloud's generated URLs land back inside the scoped runtime.
- `.nojekyll` is present so Pages serves `_`-prefixed and WASM assets verbatim.
- SW updates may require a hard refresh / clearing the old worker after redeploy.

## Checklist for runtime-touching changes

- [ ] Does this increase peak MEMFS / WASM memory during boot?
- [ ] Is the bundle still within the trimmed size budget?
- [ ] Are MEMFS vs NODEFS assumptions correct (browser vs spike)?
- [ ] Does the change survive a WASM crash + recovery?
- [ ] Are SW cache keys scoped, and HTML rewriting query-string-safe?
- [ ] Do `trusted_domains` / `overwrite.cli.url` match the deploy origin/subpath?
- [ ] Does it work under a GitHub Pages subpath?
- [ ] Is the SW still a root-level classic IIFE for Firefox?
