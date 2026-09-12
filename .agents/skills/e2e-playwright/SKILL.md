---
name: e2e-playwright
description: Write or debug Nextcloud Playground Playwright specs in tests/e2e, including WASM readiness and nested app frames.
metadata:
  author: nextcloud-playground
  version: "1.0"
---

# Nextcloud Playground E2E tests

Use `tests/e2e/shell.spec.mjs` for the current readiness and blueprint patterns;
`playwright.config.mjs` owns server startup, timeouts, and concurrency.

## Readiness and frames

The shell becomes usable when `#address-input` is enabled and `#site-frame` has a
scoped source. Use the existing spec's `waitForRuntimeReady` pattern. For Nextcloud
content, wait inside both frame levels:

```js
const nextcloud = page.frameLocator("#site-frame").frameLocator("#remote-frame");
```

`#site-frame` alone is the remote host, not Nextcloud. Assert a real app selector
or result; an address-bar change or blueprint textarea value does not prove that
provisioning succeeded. Choose selectors appropriate to the active app and locale.
Use condition-based waits; a fixed sleep does not establish boot readiness.

## Isolation and reload

Browser contexts isolate scope state. `fullyParallel: false` is the existing
configuration, not evidence that every browser tab shares one PHP runtime.
Do not change worker counts as part of an unrelated test fix.

Reload tests exercise IndexedDB journals. Wait for the relevant writes before
reloading; shell readiness alone does not prove that the debounced flush finished.
A fresh context avoids scope reuse but does not by itself invalidate all cached
worker code. After runtime changes, rebuild and clear Service Worker caches.

## Running and debugging

```bash
make test-e2e
npx playwright test tests/e2e/shell.spec.mjs
npx playwright test --headed --debug
```

The configured server starts on 8085. To target another port, start an isolated
server and set both `PLAYWRIGHT_BASE_URL` and `PLAYWRIGHT_EXTERNAL_SERVER=1`.
Changing baseURL alone does not change the hardcoded server command's port.
Avoid sharing a dev server with sibling playgrounds via `reuseExistingServer`.

Use the configured trace on failure and the shell logs to distinguish boot errors
from a selector/readiness failure. Unit-level normalization and generated-script
checks belong in `tests/*.test.mjs`; use the CLI skill for terminal exploration.
