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
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"meta"/);
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"steps"/);
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

  await page.locator("#settings-button").click();
  await expect(page.locator("#settings-popover")).toHaveClass(/is-open/);
  const optionCount = await page
    .locator("#settings-php-version option")
    .count();
  expect(optionCount).toBeGreaterThan(0);
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
