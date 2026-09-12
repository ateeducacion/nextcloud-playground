---
name: unit-testing
description: Write or review Nextcloud Playground Node unit tests for normalization, paths, journaling, and generated PHP/occ scripts.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Nextcloud Playground unit tests

The suite uses `node:test` and `node:assert/strict`, importing source directly.
Tests live in `tests/*.test.mjs`; use the nearest test's setup instead of creating
another framework or duplicating a helper.

```bash
make test
node --test tests/blueprint.test.mjs
node --test tests/blueprint-steps.test.mjs
```

## Useful checks

- Blueprint normalization: actual Nextcloud `admin`, `apps`, and `steps` shapes,
  legacy aliases, defaults, invalid inputs, and handler dispatch.
- Generated occ scripts: safe argv/env encoding, no shebang, `REQUEST_URI` unset,
  and the `console.php` wrapper. Use current `buildOccScript` output, not an
  obsolete FacturaScripts Forja-cache or `normalizeSettings` example.
- Step results: exit-status/error handling, user-file scans, and explicit login.
- Persistence and paths: scoped keys, normalization before hydration, rename
  destinations, failure behavior, and subdirectory routing.

Assert observable behavior or a specific generated-code invariant that would
catch a regression. Mocks should cover only the boundary needed by the test;
exercise browser-dependent helpers with suitable fakes when that is the target,
rather than only testing their early-return Node branch.

Actual Nextcloud HTML, service-worker interception, and browser boot need E2E
verification. The Node/NODEFS spike can check PHP execution but does not establish
browser MEMFS behavior. Keep those checks separate from fast unit tests.

Run the affected tests and code lint after logic/test edits; use the full unit
suite when shared behavior changes. Source tests do not rebuild worker bundles.
