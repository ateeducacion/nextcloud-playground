---
name: blueprint-provisioning
description: Implement or debug Nextcloud Playground blueprint normalization, step handlers, and occ provisioning. Not WordPress Blueprints.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Nextcloud blueprint provisioning

## Current contract

Read the relevant sections of [blueprint reference](../../../docs/blueprint-json.md)
for JSON shapes and supported steps. The schema is
`assets/blueprints/blueprint-schema.json`; normalization is in
`src/shared/blueprint.js`; execution is in `src/runtime/blueprint-steps.js`.
The Nextcloud normalizer is implemented, not a pending FacturaScripts migration.

- `admin` is preferred; legacy `login` credentials normalize into it.
- Top-level `apps` expands into `enableApp` steps before the explicit `steps`.
- `installNextcloud` is a declarative marker; bootstrap performs installation.
- Keep schema, normalizer, handler, documentation, and affected tests aligned.
- Query parameter precedence is defined by `resolveBlueprintForShell`; reuse it
  instead of implementing a second URL/base64 parser.

## PHP and occ

Use `buildOccScript` in `src/runtime/install-script.js`. It executes in-process:
there is no shell or native occ subprocess. Build an argv array, safely encode
values, pass passwords via env (`OC_PASS`), unset `REQUEST_URI`, change to
`/www/nextcloud`, then require `console.php`. Requiring `occ` emits its shebang
and breaks `strict_types`. The posix prepend must already be active.

The executor's `occ` helper checks exit status. Reuse existing error reporting;
never concatenate untrusted input into PHP or shell syntax. `login` uses
`php.request()` to capture session cookies; a successful explicit login suppresses
later admin autologin. `createShare` uses the internal share manager rather than
an invented occ command. User-file writes also need the existing files scan.

App ZIP handling and archive path validation live in the step executor and
`install-script.js`, not a legacy FacturaScripts `addons.js` flow. Keep paths
validated and preserve the existing proxy/resource handling for each step.

## Reload and failures

`bootstrap.js` skips installation for matching installed state, but still invokes
blueprint steps on reload. Steps must tolerate existing state where intended.
Failures are logged and execution continues. A failed `installApp` sets
`criticalFailure`; bootstrap does not mark a fresh install complete, so the next
boot can retry. Do not add Moodle's `critical` option without changing the contract.

A changed blueprint source triggers a clean environment; reloading the same source
reuses the journal. See `src/shared/paths.js` and `src/shell/main.js`.

## Verification

Use the nearest cases in `tests/blueprint.test.mjs` and
`tests/blueprint-steps.test.mjs` for normalization, safe argv generation, failures,
and aliases. Run affected unit tests. Rebuild with `npm run build-worker` before
browser verification and clear Service Worker caches; tests importing source do
not detect stale worker bundles. Assert actual Nextcloud content for provisioning.
