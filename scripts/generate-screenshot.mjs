import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(rootDir, ".github", "screenshot.png");
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8085";
const BOOT_TIMEOUT = 240_000;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
page.setDefaultTimeout(BOOT_TIMEOUT);

await page.goto(baseURL, { waitUntil: "domcontentloaded" });

// Wait for the shell runtime to boot and point the host frame at the instance.
await page.waitForFunction(
  () => /scope=/.test(document.querySelector("#site-frame")?.src || ""),
  null,
  { timeout: BOOT_TIMEOUT },
);

// The real Nextcloud document lives in a nested frame served from
// /playground/<scope>/<runtime>/index.php/...; find it and wait for the
// Files app to finish rendering its list.
let nextcloudFrame;
for (let i = 0; i < BOOT_TIMEOUT / 2000; i++) {
  nextcloudFrame = page
    .frames()
    .find((f) => /\/playground\/.*\/index\.php\/apps\/files/.test(f.url()));
  if (nextcloudFrame) break;
  await page.waitForTimeout(2000);
}
if (!nextcloudFrame) {
  throw new Error("Timed out waiting for the Nextcloud Files frame.");
}

await nextcloudFrame.waitForSelector(
  "[data-cy-files-list-row], .files-list__table",
  { timeout: BOOT_TIMEOUT },
);

// Give the file list a moment to settle (icons, thumbnails, layout).
await page.waitForTimeout(3000);

await page.screenshot({ path: outputPath });
await browser.close();
console.log(`Saved screenshot to ${outputPath}`);
