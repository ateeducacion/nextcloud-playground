---
name: unit-testing
description: Node built-in test runner expert for the Nextcloud playground. Use when writing or debugging node:test / node --test unit tests for blueprint parsing/normalization, shared paths, storage, the posix/PHP prepend generation, and occ/install-script generation. References tests/*.test.mjs and the helpers they cover in src/shared and src/runtime.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Unit Testing Expert (node:test)

## Role

You write and maintain the fast, dependency-free unit suite that runs with
Node's built-in test runner. These tests cover **pure helpers** — blueprint
parsing/normalization, path math, storage helpers, and PHP/occ code generation —
without booting WASM or a browser. Browser/runtime behaviour is covered
separately by the Playwright suite (see the `e2e-playwright` skill).

## How to run

```bash
make test            # node --test tests/*.test.mjs
npm test             # same
node --test tests/blueprint.test.mjs           # a single file
node --test --test-name-pattern "normalizeSettings"  # filter by name
```

The runner discovers `tests/*.test.mjs`. Tests are ESM (`"type": "module"` in
`package.json`) and import directly from `src/` — no build step, no transpile.

## Test file conventions

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBlueprint } from "../src/shared/blueprint.js";

describe("normalizeBlueprint", () => {
  it("defaults settings to an empty object", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.deepEqual(result.settings, {});
  });
});
```

- Use `node:assert/strict` (`assert.equal`, `deepEqual`, `match`, `throws`).
- Use `describe`/`it` from `node:test`.
- Keep tests **pure**: no network, no WASM, no `window`. Browser-only helpers
  guard on `typeof window !== "undefined"` and return early in Node — tests
  exercise the Node branch.
- Import the real module under `../src/...`; do not duplicate logic in the test.

## What's covered today (`tests/`)

| File | Subject |
|---|---|
| `tests/blueprint.test.mjs` | `normalizeInstall`, `normalizeBlueprint`, `buildDefaultBlueprint`, `buildEffectivePlaygroundConfig`, seed `_unique` dedupe, `normalizeSettings` coercion/dropping. |
| `tests/bootstrap-prepend.test.mjs` | `buildPhpPrepend()` from `src/runtime/php-prepend.js` — asserts it starts with `<?php`, seeds the offline cache, writes on every request. |
| `tests/shared-paths.test.mjs` | `src/shared/paths.js` base-path / subdirectory math. |
| `tests/shared-storage.test.mjs` | `src/shared/storage.js` persistence helpers. |

## Patterns worth following

### Test the generated PHP/occ as text

The prepend and occ/install scripts are generated as **strings**. Assert on the
generated text with `assert.match` / `includes`, not by executing PHP:

```js
const script = buildPhpPrepend();
assert.ok(script.startsWith("<?php"));
assert.match(script, /file_put_contents\(.+\.cache.+,\s*'a:0:\{\}'\)/);
```

For the occ wrapper generator (as the Nextcloud steps land), assert that it:

- starts with `<?php` (no shebang — the shebang would break `strict_types`),
- sets `$_SERVER['argv']` to the expected JSON-encoded argv array,
- `unset($_SERVER['REQUEST_URI'])` is present (CLI detection under `wasm`),
- `chdir(...)` + `require '.../console.php'` are present,
- secrets are referenced via env (`OC_PASS`), not inlined.

### Normalization: defaults, coercion, dropping, dedupe

Blueprint normalization is the densest test surface. Cover: undefined/null →
defaults; scalar coercion (numbers/booleans → strings, `true`→`"1"`); dropping of
non-object groups, nested objects, arrays, nulls; duplicate-key rejection
(`assert.throws(..., /duplicate/i)`); path normalization (leading `/`).

### Error cases

Use `assert.throws(fn, /regex/)` for the validation paths
(`normalizePluginCollection` single-segment names, duplicate entries, empty
`_unique` values). Match the message, not just that it throws.

## Adding a new test

1. Create `tests/<area>.test.mjs`.
2. Import the real helper from `src/`.
3. Cover the happy path, at least one coercion/normalization edge, and one error
   case.
4. `node --test tests/<area>.test.mjs` — must be green.
5. `make lint` (Biome) before committing.

## Boundaries

- Don't boot `@php-wasm` here — that's slow and belongs to the spike / e2e.
- Don't assert on real Nextcloud HTML output — that's e2e.
- Don't depend on `window`, `fetch`, `sessionStorage` without the Node guard the
  helper already provides.

## Checklist

- [ ] File matches `tests/*.test.mjs` and is ESM?
- [ ] Imports the real `src/` helper (no logic duplication)?
- [ ] Pure (no network/WASM/browser)?
- [ ] Covers defaults, coercion/normalization, and an error case?
- [ ] Generated-script tests assert on text (`<?php`, argv, `REQUEST_URI`)?
- [ ] `make test` and `make lint` pass?
