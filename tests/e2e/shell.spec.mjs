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

test("serves build metadata matching the Build ID shown in the info panel", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  const metadata = await page.evaluate(async () => {
    const response = await fetch(
      new URL("assets/build-version.json", window.location.href),
      { cache: "no-store" },
    );
    return response.ok ? response.json() : null;
  });

  expect(metadata).not.toBeNull();
  expect(metadata.buildVersion).toMatch(
    /^\d{8}T\d{6}Z-(?:[0-9a-f]{8}|nogit)(?:-dirty)?$/,
  );
  expect(metadata).toMatchObject({
    gitSha: expect.any(String),
    generatedAt: expect.any(String),
    dirty: expect.any(Boolean),
  });

  // The deployed artifact and the UI must report the same build.
  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#build-id-value")).toHaveText(
    metadata.buildVersion,
  );
});

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

  // The OPcache toggle alone is not destructive: it swaps the warning for the
  // reload note and relabels the button. Reverting clears it like the select.
  const opcache = page.locator("#info-opcache");
  await expect(opcache).toBeChecked();
  await opcache.uncheck();
  await expect(page.locator("#config-apply")).toHaveText("Apply & Reload");
  await expect(page.locator("#config-apply")).not.toHaveClass(/danger/);
  await expect(page.locator("#config-reload-note")).toBeVisible();
  await expect(page.locator("#config-warning")).toBeHidden();
  if (other) {
    // A version change on top of it brings the destructive flow back.
    await page.locator("#info-runtime-version").selectOption(other);
    await expect(page.locator("#config-apply")).toHaveText("Apply & Reset");
    await expect(page.locator("#config-warning")).toBeVisible();
    await expect(page.locator("#config-reload-note")).toBeHidden();
    await page.locator("#info-runtime-version").selectOption(current);
  }
  await opcache.check();
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-reload-note")).toBeHidden();
});

test("turns OPcache off from the info panel and restarts PHP without the cache", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await waitForRuntimeReady(page);
  const frame = page.locator("#site-frame");
  const scope = (await frame.getAttribute("src")).match(/scope=([^&]+)/)[1];

  // Opening the PHP tab asks the worker for phpinfo; the first capture after a
  // (re)boot can race the remote host's listener, so retry the click. phpinfo
  // prints the SAPI's pretty name, not php_sapi_name(), so the proof that the
  // uwsgi name took effect is OPcache's own status row.
  const expectOpcodeCaching = async (pattern) => {
    await expect(async () => {
      await page.locator("#phpinfo-tab").click();
      await expect(page.locator("#phpinfo-frame")).toHaveAttribute(
        "srcdoc",
        pattern,
        { timeout: 5_000 },
      );
    }).toPass({ timeout: 180_000 });
  };

  await page.locator("#panel-toggle-button").click();
  await expectOpcodeCaching(
    /Opcode Caching\s*<\/td>\s*<td[^>]*>\s*Up and Running/,
  );

  await page.locator("#info-tab").click();
  await page.locator("#info-opcache").uncheck();
  await page.locator("#config-apply").click();

  // The journal is flushed before the runtime restarts (an unflushed install
  // marker would make the next boot reinstall), then: same scope, no clean
  // boot, URL carries the flag for manual reloads.
  await expect(page.locator("#log-panel")).toContainText(
    "Persistence journal flushed",
  );
  await expect(page).toHaveURL(/[?&]opcache=0/);
  await expect(frame).toHaveAttribute("src", /opcache=0/);
  await expect(frame).toHaveAttribute("src", new RegExp(`scope=${scope}`));
  await expect(frame).not.toHaveAttribute("src", /clean=1/);
  await expect(page.locator("#info-opcache")).not.toBeChecked();
  await expect(page.locator("#config-apply")).toBeHidden();

  await expectOpcodeCaching(/Opcode Caching\s*<\/td>\s*<td[^>]*>\s*Disabled/);
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

test("keeps an address being typed when the site frame navigates", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
  const appPath = () =>
    page.evaluate(() => {
      const host = document.querySelector("#site-frame").contentDocument;
      const app = host?.querySelector("#remote-frame")?.contentWindow;
      return `${app?.location.pathname}${app?.location.search}`;
    });
  await expect.poll(appPath).toMatch(/\/index\.php\/apps\/files\//u);

  // A page finishing its load in the frame reports its path to the shell.
  // That must not replace what the user is typing: the toolbar unlocks before
  // the landing page has loaded, so typing can overlap that load.
  await page.locator("#address-input").fill("/index.php/settings/user");
  await page
    .frameLocator("#site-frame")
    .frameLocator("#remote-frame")
    .locator("body")
    .evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("dir", "/Documents");
      location.assign(url);
    });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.endsWith(":state"))
          .map((key) => JSON.parse(sessionStorage.getItem(key)).path),
      ),
    )
    .toContainEqual(expect.stringContaining("dir="));
  await expect(page.locator("#address-input")).toHaveValue(
    "/index.php/settings/user",
  );

  await page.locator("#address-input").press("Enter");
  await expect.poll(appPath).toMatch(/\/index\.php\/settings\/user$/u);
});
