import { expect, test } from "@playwright/test";
import { buildSandboxedIframeCompatibilityScript } from "../../src/shared/sandboxed-iframes.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/playground/**", (route) => route.abort());
  await page.goto("/assets/blueprints/blueprint-schema.json");
  await page.addScriptTag({
    content: buildSandboxedIframeCompatibilityScript(
      "/playground/scope/php83-nc33",
    ),
  });
});

test("prepares an opted-in same-origin iframe before insertion", async ({
  page,
}) => {
  const state = await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts allow-same-origin";
    iframe.setAttribute("credentialless", "true");
    iframe.src = "/playground/scope/php83-nc33/apps/viewer/frame";
    document.body.append(iframe);

    return {
      credentialless: iframe.hasAttribute("credentialless"),
      sandbox: iframe.getAttribute("sandbox"),
      url: iframe.src,
    };
  });

  expect(state.credentialless).toBe(false);
  expect(state.sandbox).toBe("allow-scripts allow-same-origin");
  expect(new URL(state.url).searchParams.get("__playground_iframe")).toBe("1");
});

test("leaves origin-opaque sandboxed iframes unchanged", async ({ page }) => {
  const state = await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-scripts";
    iframe.setAttribute("credentialless", "true");
    iframe.src = "/playground/scope/php83-nc33/apps/viewer/frame";
    document.body.append(iframe);

    return {
      credentialless: iframe.hasAttribute("credentialless"),
      sandbox: iframe.getAttribute("sandbox"),
      url: iframe.src,
    };
  });

  expect(state.credentialless).toBe(true);
  expect(state.sandbox).toBe("allow-scripts");
  expect(new URL(state.url).searchParams.has("__playground_iframe")).toBe(
    false,
  );
});
