# Nextcloud testing reference

Local details for the shared testing skills. Read only the relevant section.
This reference stays outside remotely installed skill directories.

## Unit tests

- Tests are tests/*.test.mjs; use make test or node --test with a specific file.
  They import source directly with node:test and node:assert/strict.
- Blueprint tests use the Nextcloud admin/apps/steps shape and existing handlers.
  Generated occ tests check argv/env escaping, REQUEST_URI removal, console.php,
  exit status, user-file scans, and explicit login. Do not use Moodle CLI_SCRIPT
  or old FacturaScripts normalizeSettings/Forja-cache examples.
- Persistence includes Nextcloud data/config outside /persist. Check actual
  journal roots and rename destinations in fs-persistence tests.

## E2E

- tests/e2e/shell.spec.mjs has a local waitForRuntimeReady helper using the enabled
  address bar and scoped #site-frame source. There is no Moodle helpers.mjs API.
  For app content, target #site-frame then #remote-frame and wait for real content.
- playwright.config.mjs owns timeouts and startup. The server command uses 8085;
  changing PLAYWRIGHT_BASE_URL alone does not change that command. For another
  port, start an external server and set PLAYWRIGHT_EXTERNAL_SERVER=1 plus its URL.
- Use npm run test:e2e or npx playwright test tests/e2e/shell.spec.mjs. Do not copy
  Moodle's browser-project names or PLAYWRIGHT_PORT setting into this repository.
- Reload tests must wait for relevant journal writes and assert retained app data.
  Reset/different blueprint source clears state. Storage policy is in
  [runtime reference](php-wasm-runtime.md).
