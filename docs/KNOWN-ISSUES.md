# Known issues and limitations

Nextcloud Playground runs Nextcloud's PHP under the `@php-wasm` WebAssembly
runtime, where `php_sapi_name()` is `wasm`, the `posix` extension is absent, and
no external processes can be spawned. The core web UI, basic file operations, and
WebDAV work, but several features are **dead or degraded** in this sandbox.

Everything below is grounded in the Phase-0
[feasibility spike](feasibility-spike.md). Don't promise features the spike says
don't work.

## No previews / thumbnails

Preview and thumbnail generation needs `ffmpeg`, `libreoffice`, or `imagick` —
none exist in WASM, and `proc_open`/`exec` cannot spawn processes. The playground
sets `enabledPreviewProviders => []`. Image/video/PDF thumbnails and the photos
preview pipeline are off.

## No office / collaborative editing

Office and document-collaboration features (which rely on external services or
process spawning) do not work. Collabora/OnlyOffice integrations are out of
scope.

## No antivirus

Antivirus scanning (`files_antivirus`, ClamAV, etc.) requires an external daemon
and process spawning — unavailable.

## Letter avatars fall back to a solid colour

php-wasm's GD/FreeType cannot parse Nextcloud's bundled `NotoSans-Regular.ttf`,
so `imagettfbbox()` returns `false`. Without a guard this throws a TypeError
during letter-avatar generation (triggered by `--admin-email` at install and in
the UI). The `Avatar.php` patch (#5) returns a fallback box, so avatars render as
**solid-colour tiles** instead of drawn initials. Uploaded avatar images still
work.

## No real cron — AJAX only

There is no `cron.php` daemon, no system crontab, and no `pcntl`-based workers in
the browser. Background jobs run only via **AJAX cron**, piggybacking on web
requests. Jobs that expect a reliable background scheduler (preview
pre-generation, full-text indexing, heavy maintenance) effectively don't run.

## WebDAV is basic only

File access via `remote.php` (WebDAV) works for basic operations. Advanced
sync-client behaviour, chunked uploads at scale, and locking-dependent flows are
not guaranteed — see file locking below.

## File locking is disabled

`flock` is unreliable under Emscripten; the shared/exclusive locks on
`config.php` return false and would fatal. The `Config.php` patches (#2/#3)
bypass those locks under `wasm`, and `filelocking.enabled => false` turns off
Nextcloud's transactional file locking. Concurrent-write protection that relies
on locking is therefore not in effect (the runtime is single-threaded anyway).

## No Redis / APCu caching

`apcu` and `redis` extensions are absent. No `memcache.local` is configured, so
Nextcloud uses no-op caching. Expect slower repeated operations than a normal
server with a memory cache.

## Memory limits

Nextcloud 31 extracts to **807 MB / 26,865 files**; the playground ships a
**trimmed** bundle and still operates close to browser memory limits. WASM linear
memory grows but never shrinks, and large operations (big uploads, bulk imports)
can exhaust memory and crash the runtime (`memory access out of bounds` /
`unreachable`). Crash recovery restarts the runtime, but in-flight non-idempotent
work is lost. Keep operations modest.

## Ephemeral by default

Mutable state (the SQLite database, user files, sessions) lives in the browser's
in-memory filesystem with optional journalling. **Closing or hard-refreshing the
tab can discard changes**, and a bundle/version mismatch resets state when
`resetOnVersionMismatch` is enabled. Treat the playground as a disposable demo,
not durable storage.

## Trimmed app set

To fit the browser, heavy optional shipped apps are removed from the bundle
(e.g. `password_policy`, `photos`, `text`, `suspicious_login`,
`files_pdfviewer`). Only the default-enabled core set is guaranteed present;
`enableApp` only works for apps actually included in the bundle.

## Other absent extensions / capabilities

Absent: `pcntl`, `gmp`, `sodium`, `ftp`, `imap`, `ldap`. OPcache's file cache is
on by default (see below). `proc_open`/`exec`/`shell_exec`
exist as functions but cannot spawn processes. Anything depending on those
(external auth backends, shell integrations) won't work.

## OPcache

`src/runtime/php-loader.js` configures OPcache's **file cache**
(`opcache.file_cache_only=1`, bytecode under `/internal/shared/opcache`). Two
PHP-side facts shape what that means:

- **PHP 8.3/8.4 never start OPcache under php-wasm's `wasm` SAPI** (php-src
  only accepts a fixed list of SAPI names), which is why the runtime reports
  `uwsgi` instead (below). With `?opcache=0` `opcache_get_status()` returns
  `false` and nothing is cached. PHP 8.5 removed that whitelist, so the cache
  would run for real there (not offered by this playground today).
- In file-cache-only mode `opcache_reset()` and `opcache_invalidate()` are
  **no-ops**. The only invalidation is the script's mtime, compared in whole
  seconds (`opcache.validate_timestamps=1`, `revalidate_freq=0`; PHP's default
  2 s `file_update_protection` keeps a freshly written file out of the cache).
  Never set `validate_timestamps=0` here: files do change within a session
  (app install, `writeFile`/`unzip` steps) and would keep executing old
  bytecode. `/internal/eval.php`, the single path every `php.run({ code })`
  compiles, is blacklisted so snippets are never cached.

**On by default** (`"opcache": true` in `playground.config.json`; `?opcache=0`
turns it off and `?opcache=1` forces it on; the "OPcache file cache" checkbox in
the Info panel sets the same parameter and restarts only the PHP runtime,
keeping the data): the runtime reports the `uwsgi` SAPI name before the first
request, which is on PHP's whitelist, so the file cache starts on PHP 8.3.
The default was flipped after the soak test in issue #106, using the
measurements of Moodle Playground
([ADR-0046](https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0046-opcache-on-by-default.md):
2–3.5× faster navigation in Chromium, Firefox and WebKit, unchanged install
and reload time, about 400 MB lower peak browser RSS, no memory errors).
Consequences:

- `PHP_SAPI`/`php_sapi_name()` return `uwsgi` inside Nextcloud. The audit of
  the shipped Nextcloud 33 core found no branch on that name; the only
  SAPI-dependent code paths are `cli`/`phpdbg` (Composer autoloaders,
  `Server.php`, Snowflake, `updater/`), `cli-server` (`Setup.php`,
  `Log/File.php`) and the playground's own `wasm` patches (`lib/base.php` occ
  detection, `Config.php` flock bypass, `console.php` owner check), which
  `scripts/build-nextcloud-bundle.sh` now gates on `wasm` **or** `uwsgi`.
  The cache therefore needs a core bundle built from that script version:
  with an older bundle `occ` is not recognised as CLI and the install fails.
- Memory: the cached `.bin` files live in MEMFS (tens of MB for Nextcloud) and
  WASM linear memory grows accordingly. Moodle Playground measured +32…71 MiB
  of WASM memory, yet a lower peak browser RSS with the cache live; Nextcloud
  was not measured separately. Its bootstrap already raises `memory_limit` to
  512M (`src/runtime/bootstrap.js`), the ceiling Moodle needed with the cache
  live (its ADR-0044), so no limit change was needed; the canary asserts it.
- Persistence: the bytecode is **not** journaled. Until October 2026
  `fs-persistence.js` mirrored `/internal/shared/opcache` into the IndexedDB
  store `nextcloud-opcache:<phpVersion>`; the core is re-extracted into MEMFS
  on every boot with fresh mtimes, so restored bytecode never passed timestamp
  validation, and with the cache live the journal alone made a clean boot
  ~2.4× slower (7.1 s → 17.4 s locally). The store was removed; boots delete
  any `nextcloud-opcache:*` database left by older sessions. Reloads
  recompile from scratch, which is the ephemeral model this playground follows.
- A rewrite that restores a file's previous mtime to the second is the known
  blind spot of timestamp validation; no playground write path does that.

Same decisions as Moodle Playground
[ADR-0038](https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0038-opcache-file-cache-timestamp-validation.md)
and
[ADR-0039](https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0039-experimental-opcache-via-sapi-name.md);
upstream discussion in WordPress/wordpress-playground#4465.

## Harmless boot noise

These appear during install and are safe to ignore:

- `/bin/sh: inkscape: command not found` — theming tries to rasterize SVG.
- "The process control (PCNTL) extensions are required …" — `pcntl` is optional
  (used only for Ctrl-C handling in occ).
