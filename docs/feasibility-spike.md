# Phase 0 — Feasibility Spike

**Question:** Can Nextcloud server run in the browser under php-wasm (the WordPress
Playground `@php-wasm` runtime), like the Moodle / Omeka S / FacturaScripts
playgrounds? Nobody had done it before, and Nextcloud requires the `posix`
extension which the stock php-wasm build disables.

**Answer: YES (at the PHP layer).** Nextcloud 31.0.14 installs against SQLite and
serves its login page under php-wasm (PHP 8.3) with a posix polyfill and a small
set of source patches. The remaining hard problem is **bundle size / browser
memory**, addressed in Phase 2.

The spike harness lives in [`spike/`](https://github.com/ateeducacion/nextcloud-playground/tree/main/spike) (`run-spike.mjs` + `prepend.php`).
It runs headlessly with `@php-wasm/node`, mounting the extracted Nextcloud source
over NODEFS, running `occ maintenance:install`, then requesting `status.php` and
`/index.php/login`.

## Result (clean run)

```
occ install exit   : 0      → "Nextcloud was successfully installed"
installed=true     : true   → config/config.php written with 'installed' => true
status.php 200+json: true   → {"installed":true,...,"versionstring":"31.0.14"}
login render ok    : true   → HTTP 200, 17 KB of real Nextcloud login HTML
total: ~4.5s (NODEFS, warm)
```

## Runtime environment (confirmed via probe)

| Property | Value |
|---|---|
| PHP version | 8.3.31 |
| **`php_sapi_name()`** | **`wasm`** (not `cli`) — this flips Nextcloud's CLI/web detection |
| Present extensions | pdo_sqlite, sqlite3, gd (+FreeType), mbstring, openssl, curl, zip, dom, simplexml, xmlreader, xmlwriter, libxml, ctype, fileinfo, filter, hash, json, session, zlib, iconv, bcmath, exif |
| **`intl`** | NOT in base build, **but loadable** via `loadNodeRuntime("8.3", { extensions: ["intl"] })` — we load it |
| Absent | **posix**, pcntl, gmp, sodium, ftp, imap, ldap, apcu, redis, opcache(off) |
| proc_open/exec/shell_exec | functions exist but cannot spawn processes (Emscripten) |

## Required workarounds

### 1. posix polyfill (`auto_prepend_file`)
The build is `--disable-posix`; Nextcloud calls `posix_getuid()` / `posix_getpwuid()`
without guards. We stub the posix surface (fake `www-data`, uid 33) via an
`auto_prepend_file`. See [`spike/prepend.php`](https://github.com/ateeducacion/nextcloud-playground/blob/main/spike/prepend.php). This is the
single most important file and becomes `src/runtime/php-prepend.js` in the real build.

### 2. Source patches (applied at build time, gated on `PHP_SAPI === 'wasm'`)
All patches are no-ops on a normal server (they only trigger under the `wasm` SAPI),
so they are safe and minimal.

| # | File:line | Original | Patch | Why |
|---|---|---|---|---|
| 1 | `lib/base.php:610` | `self::$CLI = (php_sapi_name() == 'cli');` | `… \|\| (PHP_SAPI === 'wasm' && empty($_SERVER['REQUEST_URI']))` | SAPI is `wasm`, so occ (no REQUEST_URI) is treated as CLI while web requests are not |
| 2 | `lib/private/Config.php:204` | `if (!flock($fp, LOCK_SH)) {` | `if (!flock($fp, LOCK_SH) && PHP_SAPI !== 'wasm') {` | `flock` is unreliable under Emscripten; the shared lock on config.php returns false and would fatal |
| 3 | `lib/private/Config.php:285` | `if (!flock($fp, LOCK_EX)) {` | `… && PHP_SAPI !== 'wasm') {` | Same, for the config write path |
| 4 | `console.php:50` | `if ($user !== $configUser) {` | `… && PHP_SAPI !== 'wasm') {` | occ refuses to run when `posix_getuid()` (33) ≠ config.php owner; irrelevant in the sandbox |
| 5 | `lib/private/Avatar/Avatar.php:194` | (after `imagettfbbox(...)`) | `if (!is_array($box)) { return [0, (int)$size]; }` | php-wasm GD/FreeType cannot parse the bundled 8.7 MB `NotoSans-Regular.ttf`; `imagettfbbox` returns `false` → `abs(null)` TypeError during letter-avatar generation (triggered by `--admin-email` and in the UI) |

### 3. Invocation detail
`occ` cannot be `require`d directly — its `#!/usr/bin/env php` shebang is emitted as
text, breaking the `declare(strict_types=1)` "must be first statement" rule. Run a
shebang-free wrapper as the **main** script that sets `$_SERVER['argv']` and
`require`s `console.php` (exactly what `occ` does after `dropPrivileges()`).

### 4. config.php flags (post-install, for the playground)
Set after install to avoid features that cannot work in WASM:
`'filelocking.enabled' => false`, `'enabledPreviewProviders' => []`,
`'check_data_directory_permissions' => false`, no `memcache.local`,
plus `trusted_domains` and `overwrite.cli.url` for the playground origin.

## Non-fatal noise (safe to ignore)
- `/bin/sh: inkscape: command not found` — theming tries to rasterize SVG; harmless.
- "The process control (PCNTL) extensions are required …" — occ warning only; pcntl
  is optional and used solely for Ctrl-C handling.

## Dead / out-of-scope features (document in KNOWN-ISSUES)
Preview generation (ffmpeg/libreoffice/imagick), antivirus, anything using
`proc_open`/`exec`, real letter avatars (font unparseable → solid-color fallback),
Redis/APCu caching, and likely collaborative/office features. Basic file ops,
WebDAV via `remote.php`, and the core web UI are expected to work.

## The open risk: bundle size / browser memory
The node spike mounts the source over **NODEFS** (no copy). The browser playground
extracts the core ZIP into **MEMFS**, and Nextcloud 31 is **807 MB / 26,865 files**
extracted — far too heavy for a browser tab.

Size breakdown: `apps/` 509 MB, `core/` 120 MB, `3rdparty/` 90 MB, `dist/` 69 MB.
Much of `apps/` is source maps, tests, and heavy optional apps
(`password_policy` 112 MB, `photos` 57 MB, `text` 50 MB, `suspicious_login` 32 MB,
`files_pdfviewer` 26 MB…).

**Phase 2 trimming strategy** (build-time, target a small bundle):
- Strip `**/tests/`, `**/*.map`, `**/cypress/`, `**/screenshots/`, `**/l10n/*.po`.
- Remove heavy optional shipped apps not needed for a demo; keep the default-enabled
  core set (files, dav, dashboard, activity, settings, theming, notifications,
  comments, systemtags, files_sharing/trashbin/versions, viewer, text, firstrunwizard,
  provisioning_api, user_status, weather_status, federatedfilesharing, …).
- Drop the unused `updater/`, large fonts, and dev assets.
- Keep `dist/` (compiled UI) and `3rdparty/` vendor runtime code.

If a trimmed MEMFS bundle is still too large, fall back to an OPFS-backed mount for
the readonly core (the mutable data dir + SQLite stay in MEMFS/persisted).

## Bottom line
The scary unknown — *does Nextcloud's PHP run at all under php-wasm?* — is answered:
**yes, with a 5-patch set + posix polyfill + intl.** Proceed to scaffold the
playground (Phase 1) and solve bundle size in the build pipeline (Phase 2).
