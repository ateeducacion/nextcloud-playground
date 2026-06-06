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

Absent: `pcntl`, `gmp`, `sodium`, `ftp`, `imap`, `ldap`, opcache off by default
(the playground enables a file-cache OPcache). `proc_open`/`exec`/`shell_exec`
exist as functions but cannot spawn processes. Anything depending on those
(external auth backends, shell integrations) won't work.

## Harmless boot noise

These appear during install and are safe to ignore:

- `/bin/sh: inkscape: command not found` — theming tries to rasterize SVG.
- "The process control (PCNTL) extensions are required …" — `pcntl` is optional
  (used only for Ctrl-C handling in occ).
