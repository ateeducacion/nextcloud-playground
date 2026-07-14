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
| `login` | Effective admin credentials | `username`, `password`. |
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
  "login": { "username": "admin", "password": "admin" },
  "steps": [
    { "step": "installNextcloud", "adminUser": "admin", "adminPass": "admin", "adminEmail": "admin@example.com" },
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

### `installNextcloud`

Installs Nextcloud against SQLite. In practice this is an idempotent marker: the
real install runs once during boot and is skipped if the persisted DB already
matches the current bundle.

```json
{ "step": "installNextcloud", "adminUser": "admin", "adminPass": "admin", "adminEmail": "admin@example.com" }
```

Maps to:
`occ maintenance:install --database sqlite --database-name nextcloud --admin-user admin --admin-pass admin --admin-email admin@example.com --data-dir <data>`,
followed by the WASM-safe config flags.

### `login`

Authenticates a user via a web request to `/index.php/login`, establishing a
session cookie (captured by the runtime cookie jar). This is **not** an occ
command.

```json
{ "step": "login", "username": "admin", "password": "admin" }
```

### `createUser`

```json
{ "step": "createUser", "uid": "alice", "password": "alice-pass", "displayName": "Alice", "email": "alice@example.com" }
```

Maps to `OC_PASS=<password> occ user:add --password-from-env --display-name "<displayName>" <uid>`.
The password is passed via the `OC_PASS` env var (no interactive prompt is
possible).

### `createGroup`

```json
{ "step": "createGroup", "gid": "teachers" }
```

Maps to `occ group:add <gid>`.

### `addUserToGroup`

```json
{ "step": "addUserToGroup", "uid": "alice", "gid": "teachers" }
```

Maps to `occ group:adduser <gid> <uid>`. The user and group must already exist.

### `enableApp`

```json
{ "step": "enableApp", "appId": "activity" }
```

Maps to `occ app:enable <appId>`. The app must be present in the trimmed bundle.

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

Writes a file into a user's files and indexes it.

```json
{ "step": "writeFile", "path": "/admin/files/welcome.md", "contents": "# Welcome" }
```

Writes the bytes into the user's data directory, then runs `occ files:scan <uid>`
so Nextcloud registers the file. `contents` can also be supplied from a resource
(URL / base64) rather than inline literal text.

### `createShare`

Creates a share for an existing path.

```json
{ "step": "createShare", "path": "/welcome.md", "shareType": "public" }
{ "step": "createShare", "path": "/Reports", "shareType": "group", "shareWith": "teachers", "permissions": "read" }
```

`shareType` is typically `public` (link), `user`, or `group`. For `user`/`group`
shares set `shareWith`; `permissions` defaults to read.

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

### `writeFile`

Writes a file into the instance. `path` is resolved against the Nextcloud root
(`/www/nextcloud`) unless it starts with `/`. The contents come from `content`
(UTF-8 text, or base64 when `"encoding": "base64"`) or are fetched from `url`
(handy for binary payloads too large to inline — the host must allow CORS).
Parent directories are created as needed.

```json
{ "step": "writeFile", "path": "config/mimetypemapping.json", "content": "{\"elpx\":[\"application/vnd.exelearning.elpx\",\"application/zip\"]}" }
{ "step": "writeFile", "path": "data/admin/files/sample.elpx", "url": "https://raw.githubusercontent.com/owner/repo/main/fixtures/sample.elpx" }
```

Useful for registering a custom MIME type (write `config/mimetypemapping.json` +
`config/mimetypealiases.json`, then `runOcc` `maintenance:mimetype:update-js` and
`maintenance:mimetype:update-db`). To make a file show up in a user's Files view,
write it under that user's data dir and follow with `runOcc` `files:scan <user>`.

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
