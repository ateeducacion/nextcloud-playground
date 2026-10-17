import { expect, test } from "@playwright/test";

// OPcache's file cache (file_cache_only) is inert under php-wasm's `wasm` SAPI
// on PHP 8.3 and live with `?opcache=1`, which reports the `uwsgi` SAPI name.
// opcache_reset()/opcache_invalidate() are no-ops in this mode, so a PHP file
// compiled once and then rewritten must execute its new code on the next
// request purely through timestamp validation. The plain row proves the
// plumbing (and that the SAPI name is untouched); the `opcache` row is the real
// canary: it asserts the cache is active so it cannot pass vacuously, and that
// the bundle patches keyed on the SAPI name still let Nextcloud install.
// See docs/KNOWN-ISSUES.md#opcache.
test.describe.configure({ timeout: 420_000 });

const canaryIndex = `<?php
header('Content-Type: application/json');
$target = __DIR__ . '/target.php';
if (($_GET['step'] ?? '1') === '1') {
    // Older than opcache.file_update_protection so the first compile is stored.
    touch($target, time() - 10);
} else {
    file_put_contents($target, "<?php return 'v2';");
}
clearstatcache();
$value = include $target;
$status = function_exists('opcache_get_status') ? opcache_get_status(false) : null;
echo json_encode([
    'value' => $value,
    'fileCacheOnly' => is_array($status) && !empty($status['file_cache_only']),
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
]);`;

function buildBlueprintData() {
  const payload = {
    meta: { title: "OPcache canary" },
    steps: [
      {
        step: "writeFile",
        path: "/www/nextcloud/opcanary/index.php",
        content: canaryIndex,
      },
      {
        step: "writeFile",
        path: "/www/nextcloud/opcanary/target.php",
        content: "<?php return 'v1';",
      },
    ],
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function waitForScopedFrame(page) {
  await expect
    .poll(
      () =>
        page
          .frames()
          .find((frame) => /\/playground\/[^/]+\/[^/]+/.test(frame.url()))
          ? true
          : null,
      { timeout: 300_000 },
    )
    .toBe(true);
  return page
    .frames()
    .find((frame) => /\/playground\/[^/]+\/[^/]+/.test(frame.url()));
}

for (const opcache of [false, true]) {
  test(`rewritten PHP files recompile on PHP 8.3${opcache ? " with ?opcache=1" : ""}`, async ({
    page,
  }) => {
    const manifest = await page.request.get("assets/manifests/latest.json");
    test.skip(!manifest.ok(), "no core bundle is built here");

    await page.goto(
      `/?${opcache ? "opcache=1&" : ""}scope=opcanary-${crypto.randomUUID()}&blueprint-data=${buildBlueprintData()}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.locator("#address-input")).toBeEnabled({
      timeout: 300_000,
    });
    const frame = await waitForScopedFrame(page);

    const call = (step) =>
      frame.evaluate(async (step) => {
        const prefix = location.pathname.match(
          /^.*\/playground\/[^/]+\/[^/]+/u,
        )[0];
        const response = await fetch(
          `${prefix}/opcanary/index.php?step=${step}`,
          { cache: "no-store" },
        );
        return { status: response.status, body: await response.text() };
      }, step);

    // The frame may still be installing/logging in; wait for the canary route.
    let first;
    await expect
      .poll(
        async () => {
          first = await call(1);
          return first.status;
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe(200);
    const compiled = JSON.parse(first.body);
    expect(compiled.php.startsWith("8.3")).toBe(true);
    expect(compiled.value).toBe("v1");
    expect(compiled.sapi).toBe(opcache ? "uwsgi" : "wasm");
    expect(compiled.fileCacheOnly, "OPcache file cache is live").toBe(opcache);

    const second = await call(2);
    expect(second.status, second.body).toBe(200);
    expect(JSON.parse(second.body).value).toBe("v2");
  });
}
