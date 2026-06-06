---
name: wp-playground-php-wasm
description: WordPress Playground / @php-wasm runtime expert for the Nextcloud playground. Use when working with the PHP WebAssembly runtime — PHP instance lifecycle, php.run() vs php.request(), loadWebRuntime / loadNodeRuntime, filesystem mounting (createNodeFsMountHandler, MEMFS), setPhpIniEntries, auto_prepend_file, the intl extension, php_sapi_name()=='wasm' detection, tcpOverFetch networking, and filesystem ops. References how src/runtime/php-loader.js and the spike (spike/run-spike.mjs) use these.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# @php-wasm / WordPress Playground Runtime Expert (Nextcloud)

## Role

You are an expert in the `@php-wasm/web`, `@php-wasm/universal`, and
`@php-wasm/node` packages that power the PHP execution layer (the same runtime
behind WordPress Playground). You know the PHP instance lifecycle, the difference
between `php.run()` and `php.request()`, how php.ini and `auto_prepend_file` are
wired, and the Nextcloud-specific quirk that **`php_sapi_name()` returns `wasm`**.

This project depends on `@php-wasm/universal` and `@php-wasm/web` `^3.1.36`
(plus `@php-wasm/node` as a dev dependency for the spike). See `package.json`.

## Runtime creation

### Browser (`loadWebRuntime`)

`src/runtime/php-loader.js` creates the runtime:

```js
import { __private__dont__use, PHP, setPhpIniEntries } from "@php-wasm/universal";
import { generateCertificate, certificateToPEM, loadWebRuntime } from "@php-wasm/web";

const tcpOverFetch = await getTcpOverFetchOptions(corsProxyUrl); // CA + proxy
const runtimeId = await loadWebRuntime(phpVersion, { tcpOverFetch });
const php = new PHP(runtimeId);
const FS = php[__private__dont__use].FS; // raw Emscripten FS
```

Note the playground does **not** pass `extensions: ['intl']` to `loadWebRuntime`
the way the node spike does — the browser build/version selection handles
extension availability differently. If a Nextcloud feature needs `intl`, verify
it is actually present in the chosen web runtime (see the spike note below).

### Node spike (`loadNodeRuntime`)

`spike/run-spike.mjs` uses the node runtime and explicitly loads `intl`:

```js
import { PHP, setPhpIniEntries } from "@php-wasm/universal";
import { createNodeFsMountHandler, loadNodeRuntime } from "@php-wasm/node";

const php = new PHP(await loadNodeRuntime("8.3", {
  extensions: ["intl"],
  emscriptenOptions: { processId: 1 },
}));
```

`intl` is **not** in the base php-wasm build but is **loadable** via the
`extensions` option — the spike loads it because Nextcloud uses it.

## Extensions available (PHP 8.3, confirmed by the spike probe)

Present: `pdo_sqlite`, `sqlite3`, `gd` (+FreeType), `mbstring`, `openssl`, `curl`,
`zip`, `dom`, `simplexml`, `xmlreader`, `xmlwriter`, `libxml`, `ctype`,
`fileinfo`, `filter`, `hash`, `json`, `session`, `zlib`, `iconv`, `bcmath`,
`exif`. **`intl`** is loadable via the `extensions` option.

**Absent:** `posix` (the build is `--disable-posix` → needs the polyfill),
`pcntl`, `gmp`, `sodium`, `ftp`, `imap`, `ldap`, `apcu`, `redis`, opcache off by
default. `proc_open`/`exec`/`shell_exec` exist but **cannot spawn processes**
under Emscripten.

## `php_sapi_name()` === `'wasm'` (the critical quirk)

Under this runtime, `php_sapi_name()` / `PHP_SAPI` is **`wasm`**, not `cli` and
not a CGI SAPI. This flips Nextcloud's CLI/web detection in `lib/base.php`, which
is exactly why the Nextcloud patch set keys off `PHP_SAPI === 'wasm'`. Two
practical consequences:

- **occ (CLI)** is distinguished from web by the **absence of `REQUEST_URI`**:
  the occ wrapper does `unset($_SERVER['REQUEST_URI'])` so patched `base.php`
  treats it as CLI.
- Several Nextcloud code paths that branch on `php_sapi_name() == 'cli'` won't
  fire — handle that in the patches, not by faking the SAPI string.

See the `nextcloud-internals` skill for the full patch table.

## `php.run()` vs `php.request()`

| Call | Use | Behaviour |
|---|---|---|
| `php.run({ scriptPath, $_SERVER, method, body })` | Low-level execution of one script | One complete PHP lifecycle. Returns `{ httpStatusCode, headers, bytes, text, errors, exitCode }`. Used by the spike for both occ (CLI wrapper) and raw web requests. |
| `php.request(new Request(url, ...))` | Front-controller HTTP requests | Wraps `run` with cookie-jar and `$_SERVER` population (in this repo via `wrapPhpInstance` in `php-compat.js`). Used in bootstrap so `Set-Cookie` is captured in the cookie jar for autologin. |

**Stateless model:** each call is a full PHP lifecycle — globals, PDO handles,
sessions all reset. This is why the SQLite DB must be a **file** (not `:memory:`)
and why the cookie jar lives in the JS wrapper, not in PHP between requests.

### occ via run() (the wrapper pattern)

You cannot `php.run({ scriptPath: '.../occ' })` — the `#!/usr/bin/env php`
shebang is emitted as text and breaks `declare(strict_types=1)`. Run a
shebang-free wrapper as the **main** script:

```php
<?php
$_SERVER['argv'] = ['occ', /* ...args */];
$_SERVER['argc'] = /* count */;
$argv = $_SERVER['argv']; $argc = $_SERVER['argc'];
unset($_SERVER['REQUEST_URI']);   // makes base.php treat this as CLI
chdir('/www/nextcloud');
require '/www/nextcloud/console.php';
```

## Filesystem operations

The raw `PHP` / Emscripten FS exposes (used on `php` or `php[__private__dont__use].FS`):

| Method | Purpose |
|---|---|
| `php.writeFile(path, data)` | Write string/Uint8Array |
| `php.readFileAsBuffer(path)` / `readFileAsText` | Read |
| `php.mkdir(path)` / `php.mkdirTree(path)` | Create dir(s) |
| `php.analyzePath(path)` | `{ exists, object }` |
| `php.unlink(path)` | Delete |
| `php.mount(vfsPath, handler)` | Mount a backend (NODEFS via `createNodeFsMountHandler` in the spike) |

In the spike: `php.mkdirTree('/www')`, then
`await php.mount('/www/nextcloud', createNodeFsMountHandler(hostDir))` to mount the
extracted Nextcloud source with **no copy**. In the browser, the readonly core is
extracted into MEMFS instead (`src/runtime/vfs.js`).

## php.ini configuration

`@php-wasm` reads php.ini only from a fixed internal path; set everything via
`setPhpIniEntries()` **before** any request. The spike uses:

```js
await setPhpIniEntries(php, {
  memory_limit: "1024M",
  max_execution_time: "0",
  display_errors: "On",
  error_reporting: "E_ALL",
  "date.timezone": "UTC",
  auto_prepend_file: "/internal/prepend.php", // posix polyfill
  "session.save_path": "/tmp",
  upload_tmp_dir: "/tmp",
});
```

The browser loader (`php-loader.js`) sets a leaner `memory_limit: "256M"`, points
`session.save_path` at `/persist/mutable/session`, configures OPcache
(`file_cache_only`, `validate_timestamps=0`, higher `max_accelerated_files`), and
sets `openssl.cafile` / `curl.cainfo` to the generated `tcpOverFetch` CA.

## auto_prepend_file (posix polyfill + request setup)

`auto_prepend_file` runs before **every** request. It does two jobs in this repo:

1. **posix polyfill** — stub `posix_*` (fake `www-data`, uid 33) because the
   build is `--disable-posix` and Nextcloud calls posix functions unguarded.
   Canonical source: `spike/prepend.php`. The browser build writes the playground
   prepend via `src/runtime/php-prepend.js` to the **only** path @php-wasm reads
   (`/internal/shared/auto_prepend_file.php`); writing elsewhere has no effect.
2. **request/server setup** — ensure the SQLite file exists, set `SERVER_PORT`,
   `DOCUMENT_ROOT`, `SCRIPT_FILENAME` when missing.

## Outbound networking (tcpOverFetch)

`@php-wasm/web`'s real `curl` does **not** route through `globalThis.fetch`; JS
fetch interceptors won't catch it. Outbound HTTP from PHP uses `tcpOverFetch`
with a generated CA (`/internal/shared/playground-ca.pem`) and an optional CORS
proxy (`phpCorsProxyUrl` in `playground.config.json`). Keep `openssl.cafile` /
`curl.cainfo` pointed at that CA whenever `tcpOverFetch` is active, or all
outbound HTTPS from PHP breaks. The playground is otherwise offline-first
(Nextcloud's app store / update checks should not reach the network at boot).

## Checklist for php-wasm-touching changes

- [ ] Does it work with the stateless `php.run()`/`php.request()` model?
- [ ] Are ini settings applied via `setPhpIniEntries()` before any request?
- [ ] Is `auto_prepend_file` at `/internal/shared/auto_prepend_file.php` (browser)?
- [ ] Is the posix polyfill active before any Nextcloud code runs?
- [ ] Is occ run via the shebang-free `console.php` wrapper with `REQUEST_URI` unset?
- [ ] If a feature needs `intl`, is it actually present in the chosen runtime?
- [ ] Are `openssl.cafile`/`curl.cainfo` set when `tcpOverFetch` is on?
- [ ] Is the SQLite DB a real file (never `:memory:`)?
