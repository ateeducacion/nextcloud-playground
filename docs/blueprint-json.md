# `blueprint.json`

A **blueprint** is a portable JSON description of the initial state the Nextcloud
Playground should provision inside a browser scope. It is applied on boot, after
Nextcloud is installed against SQLite.

- Default blueprint: `assets/blueprints/default.blueprint.json`
- Schema: `assets/blueprints/blueprint-schema.json`
- Normalization: `src/shared/blueprint.js`
- Applied by: `src/runtime/bootstrap.js`

Provisioning steps run through Nextcloud's `occ` command (executed via the
shebang-free `console.php` wrapper described in
[development.md](development.md)), or through web requests for session-based
steps. Don't declare features that don't work under WebAssembly — see
[KNOWN-ISSUES](KNOWN-ISSUES.md).

## Loading a blueprint

The shell resolves a blueprint in this order
(`resolveBlueprintForShell` in `src/shared/blueprint.js`):

1. `?blueprint=` — inline base64 of the JSON (URL-safe alphabet, padding
   optional), or an `http(s)` URL.
2. `?blueprint-url=` — a remote URL (primary form).
3. `?blueprint-data=` — legacy alias for `?blueprint=` (deprecated).
4. `config.defaultBlueprintUrl` → `assets/blueprints/default.blueprint.json`.
5. The built-in default.

```
http://localhost:8085/?blueprint=<base64-of-json>
http://localhost:8085/?blueprint-url=https://example.com/demo.blueprint.json
```

## Top-level structure

| Property | Use | Notes |
|---|---|---|
| `$schema` | Schema reference | Optional but recommended. |
| `meta` | Descriptive metadata | `title`, `author`, `description`. |
| `debug.enabled` | Show PHP errors | Diagnostics only. |
| `browserCompatibility.sandboxedIframes` | Sandboxed app iframe handling | `strict` (default) or the explicit `service-worker` workaround described below. |
| `landingPage` | Entry route | Normalized to start with `/` (e.g. `/index.php/apps/dashboard/`). |
| `siteOptions` | Instance options | `title`, `locale`, `timezone`. |
| `login` | Legacy admin credentials | `username`, `password`. Folded into `admin` during normalization. |
| `admin` | Admin account for install / autologin | `username`, `password`, `email`. Preferred over `login`. |
| `steps` | Ordered provisioning steps | See the step reference below. |

```json
{
  "$schema": "./blueprint-schema.json",
  "meta": {
    "title": "Nextcloud demo",
    "author": "team",
    "description": "Baseline demo: a group, two users, an enabled app, a shared file."
  },
  "debug": { "enabled": false },
  "landingPage": "/index.php/apps/dashboard/",
  "siteOptions": { "title": "Nextcloud Playground", "locale": "en", "timezone": "UTC" },
  "admin": { "username": "admin", "password": "admin", "email": "admin@example.com" },
  "steps": [
    { "step": "installNextcloud" },
    { "step": "setConfig", "key": "default_phone_region", "value": "ES" },
    { "step": "createGroup", "gid": "teachers" },
    { "step": "createUser", "uid": "alice", "password": "alice-pass", "displayName": "Alice" },
    { "step": "addUserToGroup", "uid": "alice", "gid": "teachers" },
    { "step": "enableApp", "appId": "activity" },
    { "step": "disableApp", "appId": "firstrunwizard" },
    { "step": "writeFile", "path": "/admin/files/welcome.md", "contents": "# Welcome to the playground" },
    { "step": "createShare", "path": "/welcome.md", "shareType": "public" },
    { "step": "login", "username": "admin", "password": "admin" }
  ]
}
```

### Sandboxed app iframe compatibility

The default `browserCompatibility.sandboxedIframes` mode is `strict`. Some
trusted apps load a same-origin iframe with both `allow-same-origin` and the
`credentialless` attribute. That ephemeral browser context cannot use
Playground's Service Worker, so its PHP routes and packaged assets fail to
load. Such blueprints can opt into the workaround:

```json
{
  "browserCompatibility": { "sandboxedIframes": "service-worker" }
}
```

In this mode Playground removes `credentialless` only from scoped app iframes
that already declare `allow-same-origin`. It does not grant that sandbox token.
Removing the ephemeral context reduces iframe isolation, so only enable the
mode for trusted app code.

## Step reference

Steps run sequentially in array order. Each maps to an `occ` command or a web
request.

Field aliases accepted on every step (so both the documented names and the
runtime names work): `uid`/`username`/`owner`, `gid`/`group`, `appId`/`app`,
`contents`/`content`.

### `installNextcloud`

Idempotent marker. The real install (`occ maintenance:install` against SQLite)
runs once in bootstrap **before** steps, using top-level `admin`. Declaring this
step is optional; it is a no-op when the instance is already installed (the
usual case) so documented examples do not warn.

```json
{ "step": "installNextcloud" }
```

### `login`

Establishes a logged-in session for `username`/`password` (or `uid`) by running
the same server-side session helper as playground autologin (`UserSession::login`
+ session token). The request goes through `php.request()` so the cookie jar
captures `Set-Cookie`. A form POST to `/index.php/login` is not used — the
login CSRF token is awkward to round-trip under wasm.

A successful `login` step **replaces** the default admin autologin, so a
blueprint can land as a non-admin user. Without this step, `config.autologin`
still signs in the admin.

```json
{ "step": "login", "username": "admin", "password": "admin" }
```

### `createUser`

```json
{ "step": "createUser", "uid": "alice", "password": "alice-pass", "displayName": "Alice", "email": "alice@example.com" }
```

Maps to `OC_PASS=<password> occ user:add --password-from-env --display-name "<displayName>" <uid>`.
The password is passed via the `OC_PASS` env var (no interactive prompt is
possible). `username` is accepted as an alias for `uid`.

### `createGroup`

```json
{ "step": "createGroup", "gid": "teachers" }
```

Maps to `occ group:add <gid>`. `group` is accepted as an alias for `gid`.

### `addUserToGroup`

```json
{ "step": "addUserToGroup", "uid": "alice", "gid": "teachers" }
```

Maps to `occ group:adduser <gid> <uid>`. The user and group must already exist.

### `enableApp`

```json
{ "step": "enableApp", "appId": "activity" }
```

Maps to `occ app:enable --force <appId>`. The app must be present in the
trimmed bundle (or installed first with `installApp`). `app` is accepted as an
alias for `appId`.

### `disableApp`

```json
{ "step": "disableApp", "appId": "firstrunwizard" }
```

Maps to `occ app:disable <appId>`.

### `setConfig`

Sets a `config.php` system key.

```json
{ "step": "setConfig", "key": "default_phone_region", "value": "ES" }
{ "step": "setConfig", "key": "filelocking.enabled", "value": false, "type": "bool" }
{ "step": "setConfig", "key": "enabledPreviewProviders", "value": [], "type": "json" }
```

Maps to `occ config:system:set <key> [<subkey>...] --value <value> [--type bool|integer|json]`.
Specify `type` for non-string values.

### `writeFile`

Writes a file into the instance. Path resolution:

- `/<uid>/files/...` (documented shortcut) → that user's data directory,
  then `occ files:scan <uid>` so Files / shares can see it.
- relative paths (`config/mimetypemapping.json`, `data/admin/files/sample.md`)
  → the Nextcloud root (`/www/nextcloud/...`). A write under
  `data/<uid>/files/` is also scanned.
- already-absolute VFS paths (`/www/...`, `/persist/...`) are used as-is.

Contents come from `content` / `contents` (UTF-8, or base64 when
`"encoding": "base64"`) or are fetched from `url` (the host must allow CORS).
Parent directories are created as needed.

```json
{ "step": "writeFile", "path": "/admin/files/welcome.md", "contents": "# Welcome" }
{ "step": "writeFile", "path": "config/mimetypemapping.json", "content": "{\"elpx\":[\"application/vnd.exelearning.elpx\",\"application/zip\"]}" }
{ "step": "writeFile", "path": "data/admin/files/sample.elpx", "url": "https://raw.githubusercontent.com/owner/repo/main/fixtures/sample.elpx" }
```

Useful for registering a custom MIME type (write `config/mimetypemapping.json` +
`config/mimetypealiases.json`, then `runOcc` `maintenance:mimetype:update-js` and
`maintenance:mimetype:update-db`).

### `createShare`

Creates a share for an existing path in a user's files. Stock Nextcloud has
**no** `occ` command for this (so `runOcc` is not a workaround). The step
bootstraps Nextcloud and calls [`OCP\Share\IManager`](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-share-api.html)
— the same engine behind `POST /ocs/v2.php/apps/files_sharing/api/v1/shares`.

`path` is relative to the owner's files (`/welcome.md`). A writeFile-style
`/<uid>/files/...` or `data/<uid>/files/...` path is also accepted and implies
the owner. Default owner is `admin` (or an explicit `owner` / `uid` /
`username`). The file must already exist and be scanned (see `writeFile`).

```json
{ "step": "createShare", "path": "/welcome.md", "shareType": "public" }
{ "step": "createShare", "path": "/Reports", "shareType": "group", "shareWith": "teachers", "permissions": "read" }
{ "step": "createShare", "path": "/welcome.md", "shareType": "user", "shareWith": "alice", "permissions": ["read", "update"] }
```

| Field | Use |
|---|---|
| `shareType` | `public` / `link` (3), `user` (0), `group` (1). Names or OCS integers. |
| `shareWith` | Required for `user` / `group`. |
| `permissions` | `read` (1), `update` (2), `create` (4), `delete` (8), `share` (16), `all` (31), a bitmask, or an array of names. Default: **read** for public links, **all** otherwise (same as the OCS API). |
| `password` | Optional public-link password. |
| `expireDate` | Optional `YYYY-MM-DD` public-link expiry. |
| `note`, `label` | Optional share note / label. |

### `installApp`

Installs a Nextcloud app that is **not** part of the trimmed bundle by
downloading a ZIP archive, extracting it into the apps directory, and enabling
it. This is what lets an external app repository (e.g. `nextcloud-exelearning`)
ship a blueprint that boots the playground with its own app pre-installed.

```json
{ "step": "installApp", "appId": "exelearning", "url": "https://github.com/exelearning/nextcloud-exelearning/releases/download/playground/exelearning.zip" }
```

- `url` must point to a ZIP whose contents include the app's `appinfo/info.xml`.
  A single common leading folder is stripped automatically, so both a built
  app ZIP (`exelearning/appinfo/…`) and a GitHub source archive
  (`repo-branch/appinfo/…`) work.
- Files are written into `apps/<appId>` inside the readonly core's (writable
  MEMFS) apps path, so no `apps_paths` change is required.
- After extraction the app is enabled with `occ app:enable --force <appId>`
  (the `--force` bypasses the Nextcloud version requirement). Set
  `"enable": false` to extract without enabling.

The app **must** be a built artifact: source archives that rely on a compiled
`js/` bundle won't render in the browser unless that bundle is included in the
ZIP.

The fetch happens cross-origin from the runtime worker, so the ZIP host **must**
send `Access-Control-Allow-Origin`. `raw.githubusercontent.com` and GitHub Pages
do; **GitHub release-asset downloads do not** (they redirect to Azure Blob
without CORS headers). To serve a release asset, route it through a CORS proxy,
e.g. the shared `github-proxy` worker:

```
https://github-proxy.exelearning.dev/?repo=<owner/repo>&release=<tag>&asset=<file>.zip
```

### `unzip`

Fetches a ZIP or gzip-tar and extracts it into `destination` (relative to the
Nextcloud root, or absolute), stripping a single top-level wrapper folder.
Use this to overlay a standalone bundle (for example a static editor) into an
already-installed app.

```json
{ "step": "unzip", "url": "https://example.com/editor.zip", "destination": "apps/exelearning/js/editor" }
```

The ZIP host must send `Access-Control-Allow-Origin` (same CORS rule as
`installApp`).

### `runOcc`

Escape hatch for any `occ` command without a dedicated step.

```json
{ "step": "runOcc", "args": ["maintenance:mode", "--off"] }
```

Maps to `occ <args...>`. Use for one-off commands; prefer the typed steps above
where they exist.

## occ execution notes

- Every occ step runs through the shebang-free `console.php` wrapper with
  `$_SERVER['REQUEST_URI']` unset so patched `base.php` treats it as CLI.
- There is **no shell** — argv is passed as an array, never string-concatenated.
- Secrets go through env (`OC_PASS`), not argv where avoidable.
- A non-zero exit code surfaces the occ stdout/stderr for diagnosis.

## `debug.enabled`

When `true`, PHP `display_errors` is on and `error_reporting` is `E_ALL` — useful
when a step fails. Leave it off for normal runs.

## Validating a blueprint

```bash
make test    # exercises blueprint normalization
make lint
```

When you add or change a step type, update `assets/blueprints/blueprint-schema.json`,
the step handler, this document, and add a unit test under `tests/*.test.mjs`.
