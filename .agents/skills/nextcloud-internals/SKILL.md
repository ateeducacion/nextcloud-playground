---
name: nextcloud-internals
description: Change Nextcloud install/configuration, app lifecycle, SQLite integration, or WASM compatibility patches in this playground.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Nextcloud Server Internals (php-wasm Playground)

## Evidence and current implementation

Use [feasibility notes](../../../docs/feasibility-spike.md) for the original
Node/NODEFS experiment and patch rationale. Check current build/runtime code for
implemented behavior; the spike is not a browser benchmark or a frozen contract.
Supported/default releases live in `src/shared/nextcloud-versions.js`.

## occ: the provisioning surface

`occ` is Nextcloud's CLI. In the playground it is **never run as a real CLI
process** (Emscripten cannot spawn processes). Instead a tiny PHP wrapper sets
`$_SERVER['argv']`/`argc`, unsets `REQUEST_URI`, `chdir()`s into the Nextcloud
root, and `require`s `console.php` — exactly what `occ` does internally after
`dropPrivileges()`. See the spike harness `occ()` helper in
`spike/run-spike.mjs`. You cannot `require('occ')` directly: its
`#!/usr/bin/env php` shebang is emitted as text and breaks the
`declare(strict_types=1)` "must be the first statement" rule.

### Commands used by the playground

| Command | Purpose |
|---|---|
| `occ maintenance:install --database sqlite --database-name nextcloud --admin-user admin --admin-pass admin --admin-email admin@example.com --data-dir <dir>` | One-shot install against SQLite. Writes `config/config.php` with `'installed' => true`. This is the install path the spike exercises. |
| `occ status` | Prints install state / versionstring; mirrors `status.php`. Use to verify a boot. |
| `occ app:enable <appid>` | Enable a shipped or installed app. |
| `occ app:disable <appid>` | Disable an app (e.g. ones that don't work under WASM). |
| `occ app:list` | List shipped/enabled/disabled apps. |
| `occ config:system:set <key> [<subkey>...] --value <v> [--type bool\|integer\|json]` | Write a `config.php` system key (e.g. `filelocking.enabled` `false`). |
| `occ config:system:get <key>` | Read a system key. |
| `occ user:add --password-from-env --display-name "<name>" <uid>` | Create a user. Password via `OC_PASS` env, since interactive prompts are impossible. |
| `occ group:add <gid>` | Create a group. |
| `occ group:adduser <gid> <uid>` | Add a user to a group. |
| `occ maintenance:mode --on\|--off` | Toggle maintenance mode. |

### occ invocation rules under WASM

1. Run the **shebang-free wrapper** as the main script (not `occ`, not `console.php` directly with a shebang).
2. Set `$_SERVER['argv'] = ['occ', ...args]` and `$_SERVER['argc']`.
3. **`unset($_SERVER['REQUEST_URI'])`** so `lib/base.php` treats it as CLI (see patch #1).
4. `chdir(NEXTCLOUD_ROOT)` before `require .../console.php`.
5. Pass secrets via env (e.g. `OC_PASS`) — never interactively.
6. The posix polyfill must already be active via `auto_prepend_file`.

Non-fatal noise you can ignore: `/bin/sh: inkscape: command not found`
(SVG rasterization for theming) and "The process control (PCNTL) extensions are
required …" (pcntl is optional, used only for Ctrl-C handling).

## config/config.php keys that matter

Nextcloud's config is a PHP file returning `$CONFIG = [...]`. `maintenance:install`
writes the baseline; the playground then sets WASM-safe flags. Set them with
`occ config:system:set` or by editing the array post-install.

| Key | Playground value | Why |
|---|---|---|
| `installed` | `true` | Written by install; gates the setup wizard. |
| `dbtype` | `sqlite3` | The only DB backend available (no MySQL/pgsql client in WASM). |
| `datadirectory` | playground data dir | Where SQLite + user files live; must be writable in MEMFS. |
| `trusted_domains` | playground origin/host | Otherwise Nextcloud refuses the request with "untrusted domain". |
| `overwrite.cli.url` | playground base URL | Base URL used for CLI-generated links; align with the deploy origin/subpath. |
| `filelocking.enabled` | `false` | `flock` is unreliable under Emscripten (see patch #2/#3). Transactional file locking must be off. |
| `enabledPreviewProviders` | `[]` | Preview generation needs ffmpeg/libreoffice/imagick — none exist in WASM. |
| `check_data_directory_permissions` | `false` | The posix/permission model is faked; the real check would fail. |
| `memcache.local` | (unset / omit) | APCu and Redis are absent. Leave local memcache unconfigured so Nextcloud uses no-op caching. |
| `overwriteprotocol` | `http`/`https` per origin | Helps generate correct asset URLs behind the SW/iframe. |
| `htaccess.RewriteBase` / index rewrites | depends on subpath | Front controller is `index.php`; pretty URLs depend on routing in `sw.js`. |

After install, the spike sets at minimum: `filelocking.enabled => false`,
`enabledPreviewProviders => []`, `check_data_directory_permissions => false`,
**no** `memcache.local`, plus `trusted_domains` and `overwrite.cli.url` for the
playground origin.

## apps/ and core/shipped.json

- `core/shipped.json` lists the apps that ship with Nextcloud (the "shipped"
  set), split into `shippedApps` and `defaultEnabled`.
- `apps/<appid>/appinfo/info.xml` declares each app's id, version,
  dependencies, and php/Nextcloud version constraints.
- Apps are enabled/disabled in the DB (`oc_appconfig` / `enabled`), driven by
  `occ app:enable|disable`. Shipped apps live under `apps/`; the playground keeps
  the **default-enabled core set** and strips heavy optional ones (see bundle
  trimming below).

Default-enabled core set worth keeping for a usable demo: `files`, `dav`,
`dashboard`, `activity`, `settings`, `theming`, `notifications`, `comments`,
`systemtags`, `files_sharing`, `files_trashbin`, `files_versions`, `viewer`,
`text`, `firstrunwizard`, `provisioning_api`, `user_status`, `weather_status`,
`federatedfilesharing`.

## SQLite usage

- DB is a single SQLite file under `datadirectory` (`owncloud.db` by default).
- `php-wasm` ships `pdo_sqlite` + `sqlite3`; the file lives in MEMFS, so it is
  volatile in MEMFS, with config/data journaled to IndexedDB for reloads.
- Because each `php.run()` is a fresh PHP lifecycle, the DB **must** be a real
  file, never `:memory:` — an in-memory DB would be empty on the next request.
- `filelocking.enabled => false` is required; SQLite's own locking plus
  Nextcloud's transactional file locking both rely on `flock`, which Emscripten
  cannot honour reliably.

## Cron / background jobs

- No real cron and no `pcntl`-based workers under WASM.
- Use **AJAX cron** (`config.php` `'cron' => 'ajax'` mode via the web UI's
  background-jobs setting), which piggybacks on web requests. There is no
  `cron.php` daemon and no system crontab in the browser.
- Long-running/background-heavy features (preview pre-generation, full-text
  indexing) effectively don't run.

## CRITICAL: the WASM patch set

The CLI/config-lock/owner-check patches are SAPI-gated. The avatar fallback
is guarded by the failed font operation itself. They are applied at build time
by `scripts/build-nextcloud-bundle.sh`; check that script for the exact gates. The posix polyfill is applied at runtime via
`auto_prepend_file`.

### 0. posix polyfill (`auto_prepend_file`)

The php-wasm build is `--disable-posix`, but Nextcloud lists posix as **required**
and calls `posix_getuid()` / `posix_getpwuid()` / etc. **without**
`function_exists()` guards (e.g. in `CheckSetupController` and `base.php`). Those
would be fatal "Call to undefined function" errors. The polyfill stubs the posix
surface with a fake `www-data` user, uid **33**, gid 33. Reference
implementation: `spike/prepend.php` (the canonical version); in the browser build
this becomes the runtime prepend (`src/runtime/php-prepend.js` writes the
playground prepend to `/internal/shared/auto_prepend_file.php`, the only path
@php-wasm reads).

Functions stubbed include: `posix_getuid/geteuid/getgid/getegid`,
`posix_getpid/getppid`, `posix_getpwuid/getpwnam` (return the `www-data` array),
`posix_getgrgid/getgrnam`, `posix_getgroups` (`[33]`), `posix_kill/setuid/setgid`
(return `true`), `posix_isatty` (`false`), `posix_uname`, `posix_errno`,
`posix_strerror`. Each is guarded with `if (!function_exists(...))` so it never
clobbers a real posix build.

### Source patches

| # | File:line | Original | Patch | Why |
|---|---|---|---|---|
| 1 | `lib/base.php:610` | `self::$CLI = (php_sapi_name() == 'cli');` | `… \|\| (PHP_SAPI === 'wasm' && empty($_SERVER['REQUEST_URI']))` | SAPI is `wasm`. occ (no `REQUEST_URI`) is treated as CLI; web requests (with `REQUEST_URI`) are not. This is why the occ wrapper must `unset($_SERVER['REQUEST_URI'])`. |
| 2 | `lib/private/Config.php:204` | `if (!flock($fp, LOCK_SH)) {` | `if (!flock($fp, LOCK_SH) && PHP_SAPI !== 'wasm') {` | `flock` is unreliable under Emscripten; the shared lock on `config.php` returns false and would fatal on read. |
| 3 | `lib/private/Config.php:285` | `if (!flock($fp, LOCK_EX)) {` | `… && PHP_SAPI !== 'wasm') {` | Same, for the config **write** path. |
| 4 | `console.php:50` | `if ($user !== $configUser) {` | `… && PHP_SAPI !== 'wasm') {` | occ refuses to run when `posix_getuid()` (33) ≠ the config.php file owner; that ownership check is meaningless in the sandbox. |
| 5 | `lib/private/Avatar/Avatar.php:194` | (after `imagettfbbox(...)`) | `if (!is_array($box)) { return [0, (int)$size]; }` | php-wasm GD/FreeType cannot parse the bundled 8.7 MB `NotoSans-Regular.ttf`; `imagettfbbox` returns `false` → `abs(null)` TypeError during letter-avatar generation (triggered by `--admin-email` and in the UI). The guard falls back to a solid-colour avatar. |

When you touch the Nextcloud source or the build pipeline, preserve the current
WASM-specific gates and failed-font guard. Widening the gate (e.g. dropping the
`REQUEST_URI` check on patch #1) breaks the CLI/web split and will route web
requests through occ logic.

## Dead / out-of-scope features (also see KNOWN-ISSUES.md)

Preview generation (ffmpeg/libreoffice/imagick), antivirus, anything using
`proc_open`/`exec`/`shell_exec` (functions exist but cannot spawn processes),
**real letter avatars** (font unparseable → solid-colour fallback via patch #5),
Redis/APCu caching, and likely collaborative/office features. What works: basic
file ops, **WebDAV via `remote.php`** (basic), and the core web UI.

## Bundle constraints

Current core extraction uses streaming tar.zst into MEMFS, not ZIP or NODEFS.
Use [bundle design](../../../docs/streaming-tar-zst-core-bundle.md) and the current
build trim list when changing size or contents. Keep compiled `dist/` and
`3rdparty/` runtime code. Do not add OPFS automatically based on historical spike
sizes; measure the current browser path first.

## Verification checklist

- [ ] `occ maintenance:install` exits 0 and `config.php` has `'installed' => true`?
- [ ] `status.php` (or `occ status`) reports installed with the right versionstring?
- [ ] `/index.php/login` returns 200 with real login HTML?
- [ ] posix polyfill active via `auto_prepend_file` before any request?
- [ ] Build patches retain their CLI/web gates and failed-font fallback?
- [ ] `filelocking.enabled => false`, `enabledPreviewProviders => []`, `check_data_directory_permissions => false`, no `memcache.local`?
- [ ] `trusted_domains` and `overwrite.cli.url` match the deploy origin/subpath?
- [ ] occ run via the shebang-free `console.php` wrapper with `REQUEST_URI` unset?
