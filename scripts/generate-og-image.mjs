import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(rootDir, "og-image.png");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});

await page.setContent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nextcloud Playground social preview</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      width: 1200px;
      height: 630px;
      background: #0082c9;
      color: #ffffff;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      position: relative;
      width: 1200px;
      height: 630px;
      padding: 80px;
      overflow: hidden;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-height: 50px;
      padding: 0 24px;
      border-radius: 999px;
      background: #00598d;
      color: #ffffff;
      font-size: 25px;
      font-weight: 800;
      letter-spacing: 0.01em;
      white-space: nowrap;
      box-shadow: 0 16px 30px rgb(0 62 97 / 0.2);
    }

    .badge::before {
      content: "";
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: #79ff6b;
      flex: 0 0 auto;
    }

    h1 {
      margin: 74px 0 0;
      max-width: 1030px;
      font-size: 76px;
      line-height: 1.02;
      letter-spacing: 0;
      font-weight: 850;
    }

    h1 span {
      color: #b8eaff;
    }

    p {
      margin: 52px 0 0;
      max-width: 900px;
      font-size: 35px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .chips {
      position: absolute;
      left: 80px;
      bottom: 92px;
      display: flex;
      gap: 14px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      height: 46px;
      padding: 0 18px;
      border-radius: 8px;
      background: #00598d;
      font-size: 24px;
      font-weight: 800;
      white-space: nowrap;
    }

    .site {
      position: absolute;
      right: 80px;
      bottom: 46px;
      max-width: 1040px;
      color: #ffffff;
      font-size: 22px;
      line-height: 1;
      font-weight: 800;
      text-align: right;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <main>
    <div class="badge">OPEN SOURCE &middot; RUNS IN YOUR BROWSER</div>
    <h1>Nextcloud <span>Playground</span></h1>
    <p>A full Nextcloud server running in your browser via PHP WebAssembly. Instant demos, app testing, reproducible JSON blueprints. No install, no server.</p>
    <div class="chips" aria-hidden="true">
      <span class="chip">WebAssembly</span>
      <span class="chip">PHP 8.3</span>
      <span class="chip">SQLite</span>
      <span class="chip">Blueprints</span>
    </div>
    <div class="site">https://ateeducacion.github.io/nextcloud-playground</div>
  </main>
</body>
</html>`);

await page.screenshot({ path: outputPath });
await browser.close();
