import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

function buildBlueprintData(overrides = {}) {
  const payload = {
    meta: {
      title: "Playwright E2E Blueprint",
      description: "Smoke test for the Nextcloud Playground shell.",
    },
    landingPage: "/index.php/login",
    siteOptions: {
      title: "Playwright E2E Site",
      locale: "en",
      timezone: "UTC",
    },
    ...overrides,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function waitForRuntimeReady(page) {
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
}

test("loads the shell and opens the runtime side panel", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#side-panel")).not.toHaveClass(/is-collapsed/);

  await page.locator("#phpinfo-tab").click();
  await expect(page.locator("#phpinfo-frame")).toHaveAttribute(
    "srcdoc",
    /PHP Version/,
  );

  await page.locator("#blueprint-tab").click();
  // The CodeJar editor visually supersedes the textarea; #blueprint-textarea
  // stays in the DOM as a hidden compatibility bridge (see
  // src/shell/blueprint-editor.js), so its value is still readable here.
  await expect(page.locator("#blueprint-editor")).toBeVisible();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"meta"/);
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"steps"/);
});

test("blueprint editor validates edits and gates the Run button", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();

  await expect(page.locator("#run-button")).toBeEnabled();
  await expect(page.locator("#blueprint-status")).toHaveText(/valid/i);

  const editor = page.locator("#blueprint-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("not json at all");

  await expect(page.locator("#blueprint-status")).toContainText(/invalid/i);
  await expect(page.locator("#run-button")).toBeDisabled();

  // Invalid content must never trigger a navigation/reload.
  expect(new URL(page.url()).searchParams.has("blueprint")).toBe(false);
});

test("loads blueprint overrides and exposes runtime settings", async ({
  page,
}) => {
  await page.goto(`/?blueprint-data=${buildBlueprintData()}`);
  await waitForRuntimeReady(page);

  await expect(page.locator("#address-input")).toHaveValue(/login/i);
  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#side-panel")).not.toHaveClass(/is-collapsed/);
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(
    /Playwright E2E Blueprint/,
  );
  await expect(page.locator("#blueprint-textarea")).toHaveValue(
    /Playwright E2E Site/,
  );

  // The floating settings popover and gear button are gone — the version config
  // now lives in the Info panel (single source of truth).
  await expect(page.locator("#settings-button")).toHaveCount(0);
  await expect(page.locator("#settings-popover")).toHaveCount(0);

  await page.locator("#info-tab").click();
  const optionCount = await page
    .locator("#info-runtime-version option")
    .count();
  expect(optionCount).toBeGreaterThan(0);

  // Clean state: no Apply button and no destructive warning.
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-warning")).toBeHidden();

  // Changing the version reveals the Apply button + the warning. Reselecting the
  // original value clears the dirty state (no Discard button needed).
  const current = await page.locator("#info-runtime-version").inputValue();
  const other = await page
    .locator("#info-runtime-version option")
    .evaluateAll(
      (opts, cur) => opts.find((o) => o.value !== cur)?.value,
      current,
    );
  if (other) {
    await page.locator("#info-runtime-version").selectOption(other);
    await expect(page.locator("#config-apply")).toBeVisible();
    await expect(page.locator("#config-warning")).toBeVisible();

    await page.locator("#info-runtime-version").selectOption(current);
    await expect(page.locator("#config-apply")).toBeHidden();
    await expect(page.locator("#config-warning")).toBeHidden();
  }
});

test("persists /persist to IndexedDB and reboots from it on reload", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // The persistence layer journals /persist to a "nextcloud-fs-journal:<scope>"
  // IndexedDB; its presence proves mutable state is being persisted.
  const journaled = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name?.startsWith("nextcloud-fs-journal:"));
  });
  expect(journaled).toBeTruthy();

  // Reload in the same tab (sessionStorage keeps the scopeId): the runtime must
  // reboot by replaying the persisted journal — exercising the resilient replay
  // that must never let one bad op brick the boot.
  await page.waitForTimeout(2500);
  await page.reload();
  await waitForRuntimeReady(page);
});
