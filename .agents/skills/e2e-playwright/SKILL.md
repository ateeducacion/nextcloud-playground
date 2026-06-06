---
name: e2e-playwright
description: Playwright E2E expert for the Nextcloud playground. Use when writing or debugging browser end-to-end tests — booting the shell, waiting for the WASM runtime to be ready, verifying the Nextcloud login/dashboard renders, applying blueprints via query params, exercising the side panel / settings, and fixing flaky waits. References playwright.config.mjs and tests/e2e/.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Playwright E2E Expert (Nextcloud Playground)

## Role

You write and stabilize the browser end-to-end tests that boot the playground
shell, wait for the WASM runtime, and verify real behaviour (login/dashboard
rendering, blueprint application, side panel, settings). Unit-level logic is
covered by `node:test` (see the `unit-testing` skill); e2e is for the
shell→SW→worker→`@php-wasm` path that only a real browser exercises.

## How to run

```bash
make test-e2e           # npm run test:e2e → playwright test
npx playwright test tests/e2e/shell.spec.mjs
npx playwright test --headed --debug
PLAYWRIGHT_EXTERNAL_SERVER=1 npx playwright test   # reuse an already-running server
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8085 npx playwright test
```

## Config (`playwright.config.mjs`)

- `testDir: ./tests/e2e`, **`fullyParallel: false`** (single WASM runtime; don't
  parallelize tabs).
- `timeout: 180_000` per test, `expect.timeout: 30_000` — WASM boot is slow.
- `baseURL` from `PLAYWRIGHT_BASE_URL` or `http://127.0.0.1:8085`.
- `webServer.command`: serves the app, building the bundle first if needed —
  `if [ -f assets/manifests/latest.json ]; then PORT=8085 make serve; else PORT=8085 make up; fi`.
  Set `PLAYWRIGHT_EXTERNAL_SERVER=1` to skip and reuse a running server.
- `reuseExistingServer: !CI`; `webServer.timeout: 300_000` (first build is long).
- `trace: "on-first-retry"` — open traces with `npx playwright show-trace`.

## Booting and the readiness gate

The shell boots a service worker, a PHP worker, extracts the bundle into MEMFS,
runs the occ install (or restores persisted state), then autologs in. A test must
**wait for the runtime to be ready**, not for a fixed timeout. The current helper:

```js
async function waitForRuntimeReady(page) {
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
}
```

Gate on **observable shell state** (enabled address bar, iframe `src` carrying a
`scope=` param), not on `page.waitForTimeout`. For Nextcloud-content assertions,
reach into the playground iframe and wait for a real selector.

## Key shell selectors (from `tests/e2e/shell.spec.mjs`)

| Selector | Meaning |
|---|---|
| `#address-input` | Address bar; `toBeEnabled()` ⇒ runtime up. Holds the current landing path. |
| `#site-frame` | The Nextcloud iframe; `src` matches `/scope=/` when scoped. |
| `#panel-toggle-button` | Side-panel toggle; `aria-expanded` reflects state. |
| `#side-panel` | Side panel; `is-collapsed` class when closed. |
| `#phpinfo-tab` / `#phpinfo-frame` | phpinfo panel (`srcdoc` matches `/PHP Version/`). |
| `#blueprint-tab` / `#blueprint-textarea` | Blueprint editor; value reflects the active blueprint JSON. |
| `#settings-button` / `#settings-popover` | Settings popover (`is-open`). |
| `#settings-php-version option` | PHP-version options (count > 0). |

## Applying a blueprint in a test

Blueprints are passed as base64url via query param. The current spec uses
`?blueprint-data=` (legacy alias); `?blueprint=` is the preferred param going
forward — both accept inline base64.

```js
function buildBlueprintData(overrides = {}) {
  const payload = {
    meta: { title: "Playwright E2E Blueprint", description: "Smoke test." },
    landingPage: "/index.php/apps/dashboard/",
    siteOptions: { title: "E2E Site", locale: "en", timezone: "UTC" },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

await page.goto(`/?blueprint=${buildBlueprintData()}`);
await waitForRuntimeReady(page);
await expect(page.locator("#address-input")).toHaveValue(/dashboard/i);
```

Verify the blueprint took effect by checking the address bar landing path, the
blueprint textarea contents, and (for content) a selector inside `#site-frame`.

## Verifying Nextcloud rendering

To assert the real Nextcloud UI rendered (login → dashboard after autologin):

```js
const frame = page.frameLocator("#site-frame");
await expect(frame.locator("body")).toBeVisible();
// After autologin, the dashboard / app menu should be present:
await expect(frame.locator("#header, .app-menu, #app-dashboard")).toBeVisible();
// Or, if not auto-logged-in, the login form:
// await expect(frame.locator("form[name='login'], #submit-form")).toBeVisible();
```

Prefer stable, semantic selectors over text that changes with locale/version.
Remember `siteOptions.locale` affects visible strings.

## Debugging flaky waits

- **Never** `page.waitForTimeout(...)` as a readiness gate — boot time varies
  with bundle size and cold vs warm caches. Wait on a concrete locator/attribute.
- WASM boot can exceed default Playwright timeouts; the config already raises them
  — keep new tests inside those budgets and add `test.describe.configure({ timeout })`
  for unusually heavy flows.
- A cold first run builds the bundle (up to 5 min via `make up`); subsequent runs
  reuse `assets/manifests/latest.json`. CI must allow for the cold build.
- For iframe assertions, use `frameLocator("#site-frame")`; the SW rewrites
  in-iframe URLs, so navigations stay scoped — assert on the rewritten state.
- Service-worker staleness across runs can cause odd boots; a clean scope (fresh
  context) avoids leaking persisted state between tests.
- On failure, inspect the trace (`trace: "on-first-retry"`):
  `npx playwright show-trace test-results/.../trace.zip`.

## Adding an e2e test

1. Add `tests/e2e/<name>.spec.mjs`.
2. `goto('/')` (optionally with `?blueprint=`), then `waitForRuntimeReady(page)`.
3. Assert on shell state and/or `frameLocator("#site-frame")` content.
4. Keep it serial-safe (`fullyParallel: false`) and within the timeout budget.
5. Run `make test-e2e`; if it fails on a cold machine, run `make up` once first.

## Checklist

- [ ] Readiness gated on a locator/attribute, not a fixed timeout?
- [ ] Nextcloud-content assertions go through `frameLocator("#site-frame")`?
- [ ] Selectors stable across locale/version (no brittle text)?
- [ ] Blueprint passed as base64url via `?blueprint=`?
- [ ] Within the 180s test / 30s expect budgets (raise locally if justified)?
- [ ] Works against a freshly built bundle (`make up`) and a warm one?
