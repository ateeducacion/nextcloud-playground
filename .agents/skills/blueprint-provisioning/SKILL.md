---
name: blueprint-provisioning
description: Blueprint JSON provisioning expert for the Nextcloud playground. Use when working with blueprint parsing/normalization, step handlers, executing occ commands for Nextcloud provisioning (installNextcloud, login, createUser, createGroup, addUserToGroup, enableApp, disableApp, setConfig, writeFile, createShare, runOcc), resource resolution, and PHP/occ code generation. References src/shared/blueprint.js, assets/blueprints/, and the occ wrapper pattern from spike/run-spike.mjs.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Blueprint Provisioning Expert (Nextcloud)

## Role

You are an expert in the Nextcloud Playground blueprint system — a declarative
JSON format describing the desired state of a playground instance, applied at
boot. You understand parsing/normalization, step handlers, **occ-based
provisioning**, resource resolution, and how to generate PHP/occ code that runs
correctly under the `wasm` SAPI.

## Where the code lives

| File | Responsibility |
|---|---|
| `src/shared/blueprint.js` | Parse (`?blueprint=`, base64, data-URL, URL), normalize, build the default blueprint, sessionStorage persistence, resolve for the shell. |
| `src/shared/config.js` | Merge blueprint over `playground.config.json` into the effective config. |
| `assets/blueprints/default.blueprint.json` | Default blueprint loaded by `defaultBlueprintUrl`. |
| `assets/blueprints/blueprint-schema.json` | JSON schema for the blueprint. |
| `src/runtime/bootstrap.js` | Applies the blueprint during boot (mount core → occ install → config → steps → autologin). |
| `src/runtime/addons.js` | Materializes blueprint-declared apps/plugins. |

> Migration note: the in-tree `blueprint.js` currently still carries the
> FacturaScripts shape (`normalizeInstall`/`seed.customers` etc.). The
> **target Nextcloud format** below is what the docs and step handlers describe;
> keep `blueprint.js`, the schema, and `docs/blueprint-json.md` in sync as the
> Nextcloud steps land.

## Blueprint resolution order (`resolveBlueprintForShell`)

1. `?blueprint=` — inline base64/JSON, or an `http(s)` URL (backward compat).
2. `?blueprint-url=` — remote URL (primary, matches moodle-playground).
3. `?blueprint-data=` — legacy alias for `?blueprint=` (deprecated).
4. `config.defaultBlueprintUrl` (`./assets/blueprints/default.blueprint.json`).
5. The built-in default blueprint.

Inline base64 accepts URL-safe alphabet and missing padding
(`decodeBase64Text`). The result is always run through `normalizeBlueprint`.

## Target Nextcloud blueprint format

```json
{
  "$schema": "./blueprint-schema.json",
  "meta": { "title": "Demo", "author": "team", "description": "..." },
  "debug": { "enabled": false },
  "landingPage": "/index.php/apps/dashboard/",
  "siteOptions": { "title": "Nextcloud Playground", "locale": "en", "timezone": "UTC" },
  "login": { "username": "admin", "password": "admin" },
  "steps": [
    { "step": "installNextcloud", "adminUser": "admin", "adminPass": "admin" },
    { "step": "setConfig", "key": "default_phone_region", "value": "ES" },
    { "step": "createGroup", "gid": "teachers" },
    { "step": "createUser", "uid": "alice", "password": "alice-pass", "displayName": "Alice" },
    { "step": "addUserToGroup", "uid": "alice", "gid": "teachers" },
    { "step": "enableApp", "appId": "activity" },
    { "step": "disableApp", "appId": "firstrunwizard" },
    { "step": "writeFile", "path": "/admin/files/welcome.md", "contents": "# Hi" },
    { "step": "createShare", "path": "/welcome.md", "shareType": "public" },
    { "step": "login", "username": "admin", "password": "admin" }
  ]
}
```

## Step types → occ mapping

Every provisioning step ultimately runs through the **occ wrapper** (shebang-free
script that sets `$_SERVER['argv']`, unsets `REQUEST_URI`, requires
`console.php`) — except web steps like `login`, `writeFile`, and HTTP requests.

| Step | occ / mechanism | Notes |
|---|---|---|
| `installNextcloud` | `occ maintenance:install --database sqlite --database-name nextcloud --admin-user <u> --admin-pass <p> --admin-email <e> --data-dir <dir>` | Idempotent marker in practice — the real install runs once in bootstrap; re-runs are skipped if `config.php` has `installed => true`. Then set WASM-safe config flags. |
| `login` | Web request to `/index.php/login` (or token login) | Establishes a session cookie captured by the wrapper's cookie jar. Not occ. |
| `createUser` | `OC_PASS=<pass> occ user:add --password-from-env --display-name "<name>" <uid>` | Password via env (no interactive prompt). |
| `createGroup` | `occ group:add <gid>` | |
| `addUserToGroup` | `occ group:adduser <gid> <uid>` | Group and user must exist first. |
| `enableApp` | `occ app:enable <appId>` | App must be present in the trimmed bundle. |
| `disableApp` | `occ app:disable <appId>` | E.g. disable `firstrunwizard`. |
| `setConfig` | `occ config:system:set <key> [<subkey>...] --value <v> [--type bool\|integer\|json]` | For `config.php` keys; coerce types explicitly. |
| `writeFile` | MEMFS write into the user's files dir + `occ files:scan <uid>` | Write the bytes, then scan so Nextcloud indexes the new file. |
| `createShare` | `occ` (sharing API) or `OCS` web call | Public link or user/group share for an existing path. |
| `runOcc` | Arbitrary `occ <args...>` | Escape hatch for commands without a dedicated step. |

### occ generation rules

- Build the argv array, JSON-encode it into the wrapper, never string-concat
  shell. There is **no shell** — occ runs in-process.
- Pass secrets via env (`OC_PASS`), not argv where avoidable.
- `chdir(NEXTCLOUD_ROOT)` and `require .../console.php` exactly as the spike does.
- Always `unset($_SERVER['REQUEST_URI'])` so patched `base.php` sees CLI.
- Check `exitCode === 0`; surface `stdout`/`stderr` on failure.

## Normalization (current `blueprint.js`)

`normalizeBlueprint(input, config)` always returns a fully-formed object with
defaults from `buildDefaultBlueprint(config)`:

- `$schema`, `meta.{title,author,description}`
- `debug.enabled` (strict `=== true`)
- `landingPage` normalized to start with `/` (accepts `landingPath` alias)
- `siteOptions.{title,locale,timezone}`
- `login.{username,password}`
- `settings` — `{ group: { key: value } }`, scalars coerced to strings,
  booleans → `"1"`/`"0"`, non-object groups / nested objects / arrays / null
  dropped (`normalizeSettings`).

`buildEffectivePlaygroundConfig` projects the blueprint onto the runtime config
(siteTitle, locale, timezone, landingPath, debug, admin credentials). The Nextcloud
step list (`steps[]`) is the additive piece to wire in as the runtime migrates
from the FacturaScripts shape.

## Resources

Steps that need file content (e.g. `writeFile`, `createShare` targets, app ZIPs)
resolve through named resources — typical types: `url` (fetched at boot, via the
addon/CORS proxy for CORS-safe ZIP downloads), `base64`, `literal`. URLs are
absolutized against `window.location` (`absolutizeUrl`). App/plugin installs from
remote ZIPs go through `src/runtime/addons.js` and the proxy
(`addonProxyUrl` / `phpCorsProxyUrl`).

## Execution & error handling

- Steps run **sequentially** in array order during `bootstrapNextcloud`.
- Install is gated by persisted state (`manifestVersion`): if the persisted DB
  matches the current bundle and `clean` is false, the install/setup steps are
  skipped and only lightweight steps re-run.
- Prefer non-fatal step failures (log + continue) unless a step is essential
  (install). Report a progress message per step via `publish(message, fraction)`.

## Checklist for blueprint changes

- [ ] New step registered in the executor and documented in `docs/blueprint-json.md`?
- [ ] Step added to `assets/blueprints/blueprint-schema.json`?
- [ ] occ steps run via the wrapper with `REQUEST_URI` unset and `exitCode` checked?
- [ ] Secrets passed via env (`OC_PASS`), not argv?
- [ ] Strings safely embedded (JSON-encoded into the wrapper, not shell-quoted)?
- [ ] Works with SQLite and the trimmed bundle (target app actually present)?
- [ ] Unit test added under `tests/*.test.mjs`?
- [ ] Install idempotency / version-skip path still correct?
