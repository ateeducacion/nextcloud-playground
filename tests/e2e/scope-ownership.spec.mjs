import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 300_000 });
const prefix = "nextcloud-playground";

async function ready(page, requireFiles = false) {
  await expect
    .poll(
      () =>
        page.evaluate(() => document.querySelector("#address-input")?.disabled),
      { timeout: 180_000 },
    )
    .toBe(false);
  // Resolve the current documents on each poll so readiness refers to the
  // active host after Reset, including when Firefox reuses a frame context.
  await expect
    .poll(
      () =>
        page.evaluate((requireFiles) => {
          const host = document.querySelector("#site-frame").contentDocument;
          const app = host?.querySelector("#remote-frame")?.contentDocument;
          return {
            body: app?.body?.id,
            files: !requireFiles || app?.body?.innerText.includes("Files"),
          };
        }, requireFiles),
      { timeout: 60_000 },
    )
    .toEqual({ body: "body-user", files: true });
}

function heldLocks(page) {
  return page.evaluate(async () =>
    (await navigator.locks.query()).held.map((lock) => lock.name),
  );
}

// URLs of the PHP workers serving `scope` in every open tab. A remote host
// starts its worker only after it owns the scope, so more than one means a
// POST on the scope's bridge would run twice.
function phpWorkers(context, scope) {
  return context
    .pages()
    .flatMap((page) => page.workers())
    .map((worker) => worker.url())
    .filter((href) => {
      const url = new URL(href);
      return (
        url.pathname.endsWith("/php-worker.bundle.js") &&
        url.searchParams.get("scope") === scope
      );
    });
}

async function postOnce(page, scope, oldId = null) {
  return page.evaluate(
    async ({ prefix, scope, oldId }) => {
      const name = `${prefix}-php:${scope}`;
      const channel = new BroadcastChannel(name);
      // A new BroadcastChannel joins its channel asynchronously. Wait until a
      // message posted after it was created reaches it, so the probe's request
      // and reply cannot be broadcast before this channel listens.
      const ping = new BroadcastChannel(name);
      await new Promise((resolve) => {
        channel.onmessage = ({ data }) => {
          if (data?.kind === "ownership-probe-listening") resolve();
        };
        ping.postMessage({ kind: "ownership-probe-listening" });
      });
      ping.close();
      let id;
      const replies = [];
      let replied;
      const reply = new Promise((resolve) => {
        replied = resolve;
      });
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
        if (data.kind === "http-response" && data.id === id) {
          replies.push(data.id);
          replied();
        }
      };
      const host = document.querySelector("#site-frame");
      const source = new URL(
        host.contentDocument.querySelector("#remote-frame").src,
      );
      const root = source.pathname.match(
        /^(.*\/playground\/[^/]+\/[^/]+)\//u,
      )[1];
      const response = await host.contentWindow.fetch(
        `${root}/config/config.php?ownership-probe=1`,
        {
          method: "POST",
          body: "probe=1",
        },
      );
      const body = await response.text();
      // The Service Worker answers from a bridge reply, which every channel
      // receives. Wait for this channel's copy instead of a fixed delay; the
      // bound only turns a missing reply into a readable failure.
      await Promise.race([
        reply,
        new Promise((resolve) => setTimeout(resolve, 30_000)),
      ]);
      channel.close();
      return { replies, id, body, status: response.status };
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
    expect(phpWorkers(context, scope)).toHaveLength(1);
    const result = await postOnce(page, scope);
    expect(result.replies, JSON.stringify(result)).toHaveLength(1);
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
    // Closing a tab releases its Web Lock asynchronously: reload only once the
    // scope is free, or the reloaded tab is rejected as a second owner again.
    await expect
      .poll(() => heldLocks(second))
      .not.toContain(`${prefix}-owner:${scope}`);
    await second.reload({ waitUntil: "commit" });
    await ready(second);
    expect(await heldLocks(second)).toContain(`${prefix}-owner:${scope}`);
    expect(phpWorkers(context, scope)).toHaveLength(1);
    const afterHandover = await postOnce(second, scope, result.id);
    expect(afterHandover.replies, JSON.stringify(afterHandover)).toHaveLength(
      1,
    );
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
  // Every worker on the registration: the controller plus any update being
  // installed or waiting, which would take over this tab once activated.
  const serviceWorkers = (target) =>
    target.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return [
        navigator.serviceWorker.controller,
        registration?.active,
        registration?.waiting,
        registration?.installing,
      ].map((worker) => worker?.scriptURL ?? null);
    });
  const [controller] = await serviceWorkers(page);
  expect(controller).toBeTruthy();
  const second = await context.newPage();
  await second.goto(`/?scope=${other}`);
  await ready(second);
  // Opening another scope must not install a new Service Worker under the
  // first tab: a swap mid-request can drop its bridge (issue #140).
  const unchanged = [controller, controller, null, null];
  expect(await serviceWorkers(page)).toEqual(unchanged);
  expect(await serviceWorkers(second)).toEqual(unchanged);
  const held = await heldLocks(page);
  expect(held).toContain(`${prefix}-owner:${scope}`);
  expect(held).toContain(`${prefix}-owner:${other}`);
  expect(phpWorkers(context, scope)).toHaveLength(1);
  expect(phpWorkers(context, other)).toHaveLength(1);
  const first = await postOnce(page, scope);
  expect(first.replies, JSON.stringify(first)).toHaveLength(1);
  const otherResult = await postOnce(second, other);
  expect(otherResult.replies, JSON.stringify(otherResult)).toHaveLength(1);
});

test("Reset releases the old worker before starting a new owner", async ({
  page,
}) => {
  page.on("dialog", async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.accept();
  });
  const scope = `reset-${crypto.randomUUID()}`;
  await page.goto(`/?scope=${scope}`);
  await ready(page, true);
  const before = await postOnce(page, scope);
  expect(before.replies, JSON.stringify(before)).toHaveLength(1);
  const previous = await page.locator("#site-frame").getAttribute("src");
  await page.locator("#panel-toggle-button").click();
  await page.locator("#reset-button").click();
  await expect(page.locator("#site-frame")).not.toHaveAttribute(
    "src",
    previous,
  );
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /clean=1/);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector("#site-frame").contentWindow.location.href,
      ),
    )
    .not.toBe(previous);
  await ready(page, true);
  // The old host's worker is terminated before the new owner starts its own.
  await expect.poll(() => phpWorkers(page.context(), scope).length).toBe(1);
  const after = await postOnce(page, scope);
  expect(after.replies, JSON.stringify(after)).toHaveLength(1);
});
