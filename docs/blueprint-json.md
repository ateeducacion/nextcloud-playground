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
