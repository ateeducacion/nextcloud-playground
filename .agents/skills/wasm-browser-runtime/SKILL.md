---
name: wasm-browser-runtime
description: Debug Nextcloud Playground memory, core extraction, filesystem journaling, service-worker routing, or crash recovery.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Nextcloud browser runtime

## Extraction and memory

Browser files live in MEMFS; the feasibility spike used NODEFS and mounted host
files without copying them. A successful Node spike is not a browser memory test.
Use [feasibility notes](../../../docs/feasibility-spike.md) for historical evidence.

Current core extraction streams `tar.zst` through `src/runtime/vfs.js` and
`lib/streaming-tar-extract.js`; there is no ZIP core fallback. App ZIPs remain a
separate path. See [bundle design](../../../docs/streaming-tar-zst-core-bundle.md)
when changing the format. Keep integrity/file-count checks and fail on incomplete
extraction instead of caching a partial install.

The build trims the release tree in `scripts/build-nextcloud-bundle.sh`; preserve
compiled `dist/` and `3rdparty/`. Measure the current artifact rather than treating
old spike sizes or proposed app lists as a current budget. Use the installed
MEMFS path; an OPFS migration requires a separate design, not an automatic fallback.

The main loader configures 128 MiB initial WASM memory with growth. MEMFS contents
also occupy JS heap; PHP reads can copy them into linear memory. Streaming avoids
a full uncompressed tar allocation, but does not eliminate the compressed buffer
or final extracted tree. Retain memory bounds on extraction and recovery.

## Journaling and recovery

`src/runtime/fs-persistence.js` journals `/persist`, `/www/nextcloud/config`, and
`/www/nextcloud/data` to `nextcloud-fs-journal:<scope>`. OPcache uses the separate
`nextcloud-opcache:<phpVersion>` database. Both use an `ops` store. Do not copy
Moodle's cache exclusions or FacturaScripts' OPcache keys into this implementation.

The scope normally lives in sessionStorage; reload can restore mutable state.
Closing a tab does not guarantee IndexedDB deletion. Clean boot clears both
journals and reinitializes persistence. Normalize before hydration so repeated
SQLite writes are read only once. Preserve resilient replay and explicit flush
failure handling in the current implementation.

For crash recovery, read `php-worker.js` and `src/runtime/crash-recovery.js`.
MEMFS may remain readable after a WASM trap, but recovery still needs coherent
DB/file checkpoints and bounded memory. Preserve restart guards and GET/HEAD-only
replay; do not replay mutating requests.

## Routing and workers

The shell hosts `#site-frame`, then `#remote-frame` for Nextcloud. Keep the scoped
`/playground/<scope>/<runtime>/` path, front-controller/PATH_INFO handling, WebDAV
`remote.php`, and OCS endpoints intact. Query strings and HTML-escaped URLs must
survive rewriting. Use `src/shared/paths.js` for root/subdirectory hosting.

`trusted_domains` holds the host, `overwriteprotocol` holds only the scheme, and
`overwrite.cli.url` carries the appropriate URL/base path. Do not put a subpath in
the protocol field. Check the current config generator and HTTP adapter together.

`src/shared/protocol.js` and worker callers define message shapes. The classic
Service Worker bundle must stay at the app root to control the application.
Rebuild via `npm run build-worker` after source/import changes and clear worker
caches for browser checks; reset/clean boot only resets data.

Verify affected routing in a real browser under both root and subpath hosting;
verify cold extraction and warm reload when changing storage or bootstrap.
