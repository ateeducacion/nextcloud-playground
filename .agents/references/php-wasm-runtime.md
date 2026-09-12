# Nextcloud runtime reference

Local details for the shared PHP-WASM and browser-runtime skills. Keep this file
outside installed skill directories; read the section needed for the task.

## PHP integration

- `src/runtime/php-loader.js` requests `extensions: ["intl"]` and creates the raw
  PHP instance; `php-compat.js` provides request adaptation and cookies.
- Bootstrap sets Nextcloud's effective memory limit, timezone, and session path
  (`/persist/mutable/session`) before provisioning. Inspect loader and bootstrap
  together rather than copying a baseline ini value from another playground.
- SAPI is `wasm`. `buildOccScript` in `src/runtime/install-script.js` encodes argv/
  env, unsets REQUEST_URI, changes to the core root, and requires `console.php`.
  Requiring `occ` emits its shebang and breaks strict_types. Keep REQUEST_URI for
  HTTP requests so CLI detection does not misroute them.
- The posix polyfill in `src/runtime/php-prepend.js` must run before Nextcloud.
  Its browser path is `/internal/shared/auto_prepend_file.php`. Preserve graceful
  spawn-handler behavior for unavailable external binaries.
- PHP networking uses tcpOverFetch, its generated CA, and phpCorsProxyUrl; retain
  the matching openssl.cafile/curl.cainfo and configured proxy policy. App ZIP
  downloads and PHP requests are separate paths.
- `trusted_domains` holds the host, `overwriteprotocol` only the scheme, and
  `overwrite.cli.url` the appropriate URL/base path. Preserve front-controller,
  WebDAV remote.php, and OCS routing in the adapter and SW.
- Domain rules and exact patches: [nextcloud-internals](../skills/nextcloud-internals/SKILL.md).

## Storage and recovery

- Core streams from tar.zst into `/www/nextcloud`; no ZIP core fallback. Preserve
  integrity/file-count checks in `src/runtime/vfs.js`. App ZIPs are separate.
  Read [bundle design](../../docs/streaming-tar-zst-core-bundle.md) for format work;
  the historical NODEFS spike is not a current browser memory benchmark.
- `nextcloud-fs-journal:<scope>` journals `/persist`, `/www/nextcloud/config`, and
  `/www/nextcloud/data`; the DB is `data/owncloud.db`. See bootstrap-paths.js and
  fs-persistence.js. Do not restrict journaling to /persist or add Moodle exclusions.
- OPcache uses `nextcloud-opcache:<phpVersion>`, unlike FacturaScripts' bundle-hash
  namespace. Clean boot clears both journals and initializes them again.
- Installation is reused for matching installed config and manifest state, but
  blueprint steps still run on reload. Failed installApp prevents caching a fresh
  install as complete. See [blueprint skill](../skills/blueprint-provisioning/SKILL.md).
- Read `php-worker.js` and `src/runtime/crash-recovery.js` for actual checkpoint
  coverage, bounded copying, fallback, and restart guards. Preserve coherent DB/
  file recovery and safe-request replay. Do not import Moodle filedir assumptions.
- The main loader starts WASM at 128 MiB with growth. Streaming still retains the
  compressed buffer and final MEMFS tree; measure current artifacts before tuning.
