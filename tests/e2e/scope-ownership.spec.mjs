import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 300_000 });
const prefix = "nextcloud-playground";

async function ready(page) {
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: 180_000,
  });
  const frame = page.frameLocator("#site-frame").frameLocator("#remote-frame");
  await expect(frame.locator("body")).toContainText(/Nextcloud|Files|Log in/, {
    timeout: 60_000,
  });
}

async function postOnce(page, scope, oldId = null) {
  return page.frame({ url: /remote\.html/u }).evaluate(
    async ({ prefix, scope, oldId }) => {
      const channel = new BroadcastChannel(`${prefix}-php:${scope}`);
      let id;
      const replies = [];
      channel.onmessage = ({ data }) => {
        if (
          data.kind === "http-request" &&
          data.request.url.includes("ownership-probe")
        ) {
          id = data.id;
          if (oldId)
            channel.postMessage({
              kind: "http-response",
              id: oldId,
              response: {
                status: 200,
                headers: {},
                body: new TextEncoder().encode("stale-reply"),
              },
            });
        }
        if (data.kind === "http-response" && data.id === id)
          replies.push(data.id);
      };
      const source = new URL(document.querySelector("#remote-frame").src);
      const root = source.pathname.match(
        /^(.*\/playground\/[^/]+\/[^/]+)\//u,
      )[1];
      const response = await fetch(
        `${root}/config/config.php?ownership-probe=1`,
        {
          method: "POST",
          body: "probe=1",
        },
      );
      // Observe duplicate worker replies after the first response wins the race.
      await new Promise((resolve) => setTimeout(resolve, 500));
      channel.close();
      const body = await response.text();
      return { replies, id, body };
    },
    { prefix, scope, oldId },
  );
}

for (const differentRuntime of [false, true]) {
  test(`a shared scope executes POST once (${differentRuntime ? "different" : "same"} runtime)`, async ({
    page,
    context,
  }) => {
    const scope = `ownership-${crypto.randomUUID()}`;
    await page.goto(`/?scope=${scope}`);
    await ready(page);
    const firstRuntime = await page.locator("#runtime-id-value").textContent();
    const second = await context.newPage();
    second.on("dialog", (dialog) => dialog.accept());
    await second.addInitScript(
      ({ prefix, scope, runtimeId }) => {
        sessionStorage.setItem(
          `${prefix}:${scope}:state`,
          JSON.stringify({ runtimeId }),
        );
      },
      {
        prefix,
        scope,
        runtimeId: differentRuntime ? "php83-nc31" : firstRuntime,
      },
    );
    await second.goto(`/?scope=${scope}`);
    // Baseline boots a second PHP runtime. Fixed code rejects it before storage/worker startup.
    await expect
      .poll(
        async () => {
          const status = await second
            .frameLocator("#site-frame")
            .locator("#remote-status")
            .textContent();
          return (
            status.includes("already open") ||
            (await second.locator("#address-input").isEnabled())
          );
        },
        { timeout: 180_000 },
      )
      .toBe(true);
    const result = await postOnce(page, scope);
    expect(result.replies).toHaveLength(1);
    await expect(
      second.frameLocator("#site-frame").locator("#remote-status"),
    ).toContainText("already open");
    expect(second.workers()).toHaveLength(0);
    await expect(page.locator("#address-input")).toBeEnabled();
    // No second core bundle is needed to verify rejection before worker startup.
    // The same-runtime case below covers handover and stale replies.
    if (differentRuntime) return;
    await page
      .locator("#site-frame")
      .evaluate((frame) =>
        frame.contentWindow.postMessage(
          { kind: "flush-persistence" },
          location.origin,
        ),
      );
    await expect(page.locator("#log-panel")).toContainText(
      "Persistence journal flushed",
    );
    await page.close();
    await second.reload({ waitUntil: "commit" });
    await ready(second);
    const afterHandover = await postOnce(second, scope, result.id);
    expect(afterHandover.replies).toHaveLength(1);
    expect(afterHandover.body).not.toBe("stale-reply");
  });
}

test("distinct scopes acquire ownership independently", async ({
  page,
  context,
}) => {
  const scope = `independent-${crypto.randomUUID()}`;
  const other = `independent-${crypto.randomUUID()}`;
  await page.goto(`/?scope=${scope}`);
  await ready(page);
  const second = await context.newPage();
  await second.goto(`/?scope=${other}`);
  await ready(second);
  const held = await page.evaluate(async () =>
    (await navigator.locks.query()).held.map((lock) => lock.name),
  );
  expect(held).toContain(`${prefix}-owner:${scope}`);
  expect(held).toContain(`${prefix}-owner:${other}`);
  expect((await postOnce(page, scope)).replies).toHaveLength(1);
  expect((await postOnce(second, other)).replies).toHaveLength(1);
});

test("Reset releases the old worker before starting a new owner", async ({
  page,
}) => {
  const scope = `reset-${crypto.randomUUID()}`;
  await page.goto(`/?scope=${scope}`);
  await ready(page);
  expect((await postOnce(page, scope)).replies).toHaveLength(1);
  const previous = page
    .frames()
    .find((frame) => frame.url().includes("/playground/"));
  await page.locator("#panel-toggle-button").click();
  await page.locator("#reset-button").click();
  await expect.poll(() => previous.isDetached()).toBe(true);
  await ready(page);
  expect((await postOnce(page, scope)).replies).toHaveLength(1);
});
