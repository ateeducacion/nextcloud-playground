import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { decodeBlueprintParam } from "../src/shared/blueprint.js";
import { loadPlaygroundConfig } from "../src/shared/config.js";
import { installDom, tick, until } from "./fixtures/shell/dom.mjs";

// Drives src/shell/main.js top to bottom against index.html's real markup: each
// boot() installs a fresh happy-dom document and stubbed browser APIs, then
// imports a fresh copy of the module (query-string cache busting).

const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const BODY = indexHtml.slice(
  indexHtml.indexOf(">", indexHtml.indexOf("<body")) + 1,
  indexHtml.indexOf("</body>"),
);

const CONFIG = {
  siteTitle: "Nextcloud Playground",
  landingPath: "/index.php/apps/files",
  autologin: true,
  opcache: true,
  sentry: { dsn: "https://key@sentry.test/42" },
  admin: { username: "admin", password: "admin", email: "a@example.com" },
  runtimes: [
    { id: "php83-nc30", label: "PHP 8.3 + Nextcloud 30" },
    { id: "php83-nc33", label: "PHP 8.3 + Nextcloud 33", default: true },
  ],
};

class FakeChannel {
  static all = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.closed = false;
    FakeChannel.all.push(this);
  }
  addEventListener(_type, listener) {
    this.listeners.push(listener);
  }
  close() {
    this.closed = true;
  }
}
globalThis.BroadcastChannel = FakeChannel;

let bootCount = 0;
const sentry = [];

/**
 * Boot a fresh shell. `sw` shapes navigator.serviceWorker (null = absent).
 */
async function boot({
  href = "http://localhost:8080/",
  session = {},
  sw = {},
  configResponse,
  frameWindow = true,
  html = BODY,
  waitForFrame = true,
  routes = {},
} = {}) {
  const dom = installDom({ html, href });
  for (const [key, value] of Object.entries(session)) {
    dom.window.sessionStorage.setItem(key, value);
  }

  const registered = [];
  const swListeners = [];
  if (sw !== null) {
    dom.navigator.serviceWorker = {
      controller: "controller" in sw ? sw.controller : {},
      ready: Promise.resolve(),
      register:
        sw.register ||
        (async (url, options) => {
          registered.push({ url: String(url), options });
          return { update: async () => {} };
        }),
      addEventListener: (_type, listener) => swListeners.push(listener),
    };
  }

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/envelope/")) {
      sentry.push(String(init.body));
      return new Response("{}");
    }
    if (url.endsWith("playground.config.json")) {
      return configResponse ? configResponse() : Response.json(CONFIG);
    }
    if (routes[url]) {
      return Response.json(routes[url]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const frame = dom.document.querySelector("#site-frame");
  const posted = [];
  const remote = {
    postMessage: (message, origin) => posted.push({ message, origin }),
  };
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => (frameWindow ? remote : null),
  });

  const channelsBefore = FakeChannel.all.length;
  bootCount += 1;
  await import(`../src/shell/main.js?boot=${bootCount}`);
  if (waitForFrame) {
    await until(() => frame.getAttribute("src"), "frame src");
  }

  const $ = (selector) => dom.document.querySelector(selector);
  const shell = {
    ...dom,
    $,
    frame,
    posted,
    registered,
    swListeners,
    channel: () => {
      const mine = FakeChannel.all.slice(channelsBefore);
      return mine[mine.length - 1];
    },
    send(message) {
      for (const listener of shell.channel().listeners) {
        listener({ data: message });
      }
    },
    logs: () => $("#log-panel").textContent,
    frameUrl: () => new URL(frame.getAttribute("src")),
    click(selector) {
      $(selector).click();
    },
    setFrameWindow(value) {
      frameWindow = value;
    },
  };
  return shell;
}

function change(element) {
  element.dispatchEvent(new element.ownerDocument.defaultView.Event("change"));
}

// Must run first: loadPlaygroundConfig() memoizes only a successful fetch.
describe("config load failure", () => {
  it("keeps the UI locked, shows the error and never loads the remote host", async () => {
    const shell = await boot({
      configResponse: () => new Response("nope", { status: 500 }),
      waitForFrame: false,
    });
    await until(() => shell.logs().includes("Unable to load"), "error log");
    assert.match(shell.logs(), /Unable to load playground config: 500/u);
    assert.ok(shell.$("#log-panel .error"));
    // #127: no runtime is known, so the runtime controls stay locked and the
    // reason is on screen instead of an empty frame.
    assert.equal(
      shell.$("#blocking-error").textContent,
      "Unable to load playground config: 500",
    );
    assert.equal(shell.$("#address-input").disabled, true);
    assert.equal(shell.$("#reset-button").disabled, true);

    // Without a config there is nothing to ask the worker for.
    shell.click("#phpinfo-tab");
    assert.match(
      shell.logs(),
      /Cannot capture PHP info before the playground configuration/u,
    );
    assert.equal(shell.posted.length, 0);

    // Home and Refresh must not point the frame at remote.html?runtime=undefined.
    shell.click("#home-button");
    shell.click("#refresh-button");
    await tick();
    assert.equal(shell.frame.getAttribute("src"), null);
    assert.equal(shell.registered.length, 0);
  });
});

describe("non-Error boot failure", () => {
  it("shows the rejection value itself", async () => {
    const shell = await boot({
      configResponse: () => {
        throw "offline";
      },
      waitForFrame: false,
    });
    await until(() => shell.$("#blocking-error"), "blocking error");
    assert.equal(shell.$("#blocking-error").textContent, "offline");
    assert.equal(shell.$("#address-input").disabled, true);
  });
});

describe("blueprint load failure", () => {
  it("keeps the UI locked too: the runtime is still unknown", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?blueprint-url=https://bp.test/missing.json",
      waitForFrame: false,
    });
    await until(() => shell.$("#blocking-error"), "blocking error");
    assert.match(
      shell.$("#blocking-error").textContent,
      /unexpected fetch https:\/\/bp\.test\/missing\.json/u,
    );
    assert.equal(shell.$("#address-input").disabled, true);
    shell.click("#reset-button");
    shell.click("#home-button");
    await tick();
    assert.equal(shell.frame.getAttribute("src"), null);
  });
});

describe("normal boot", () => {
  it("registers the classic SW and points the frame at the remote host", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s1" });
    const sw = new URL(shell.registered[0].url);
    assert.match(sw.pathname, /\/sw\.bundle\.js$/u);
    // The script URL is the registration's identity: only the build may
    // change it, or a new scope/runtime swaps the worker under other tabs.
    assert.equal(sw.search, `?v=${BUILD_VERSION}`);
    assert.deepEqual(shell.registered[0].options, {
      scope: "./",
      updateViaCache: "none",
    });

    const url = shell.frameUrl();
    assert.equal(url.pathname, "/remote.html");
    assert.equal(url.searchParams.get("scope"), "s1");
    assert.equal(url.searchParams.get("runtime"), "php83-nc33");
    assert.equal(url.searchParams.get("path"), "/index.php/apps/files");
    assert.ok(url.searchParams.get("instance"));
    assert.equal(url.searchParams.has("clean"), false);
    assert.equal(
      shell.channel().name.includes(url.searchParams.get("instance")),
      true,
    );

    assert.match(
      shell.logs(),
      new RegExp(`Playground build ${BUILD_VERSION}`, "u"),
    );
    assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);
    assert.equal(
      shell.$("#build-id-chip").title,
      `Copy Playground build ID (${BUILD_VERSION})`,
    );
    assert.equal(shell.$("#runtime-id-value").textContent, "php83-nc33");
    const select = shell.$("#info-runtime-version");
    assert.deepEqual(
      [...select.options].map((o) => [o.value, o.textContent]),
      CONFIG.runtimes.map((r) => [r.id, r.label]),
    );
    assert.equal(select.value, "php83-nc33");
    assert.equal(shell.$("#info-opcache").checked, true);
    assert.equal(shell.$("#address-input").value, "/index.php/apps/files");
    assert.equal(
      shell.$("#address-input").disabled,
      true,
      "locked until ready",
    );
    assert.match(
      shell.$("#phpinfo-frame").getAttribute("srcdoc"),
      /No PHP diagnostics captured yet/u,
    );
    // The editor shows the default blueprint as JSON.
    assert.equal(
      JSON.parse(shell.$("#blueprint-textarea").value).landingPage,
      "/index.php/apps/files",
    );
    // The control-reload marker is cleared once the page is controlled.
    assert.equal(
      shell.window.sessionStorage.getItem(
        "nextcloud-playground:s1:sw-controlled",
      ),
      null,
    );

    // SW debug messages are mirrored into the log; others are ignored.
    for (const listener of shell.swListeners) {
      listener({ data: { kind: "sw-debug", detail: "hello from sw" } });
      listener({ data: { kind: "other" } });
      listener({ data: null });
    }
    assert.match(shell.logs(), /\[sw\] hello from sw/u);
  });

  it("follows the remote host's progress, ready and navigate messages", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s2" });
    const address = shell.$("#address-input");
    const back = shell.$("#back-button");

    shell.send({ kind: "progress", title: "Boot", detail: "extracting" });
    assert.match(shell.logs(), /Boot: extracting/u);
    assert.equal(address.disabled, true);

    shell.send({
      kind: "ready",
      path: "/index.php/apps/files/",
      bootstrapped: true,
    });
    assert.equal(address.disabled, false);
    assert.equal(address.value, "/index.php/apps/files/");
    assert.equal(back.disabled, true, "landing redirect is not a back entry");
    assert.deepEqual(shell.posted.at(-1), {
      message: { kind: "navigate-site", path: "/index.php/apps/files/" },
      origin: "http://localhost:8080",
    });
    const state = JSON.parse(
      shell.window.sessionStorage.getItem("nextcloud-playground:s2:state"),
    );
    assert.equal(state.path, "/index.php/apps/files/");
    assert.equal(state.runtimeId, "php83-nc33");
    assert.ok(state.lastReadyAt);

    // A second "ready" is an in-site navigation and becomes a back entry.
    shell.send({ kind: "ready", path: "/index.php/settings" });
    assert.equal(back.disabled, false);
    shell.send({ kind: "ready" });
    assert.equal(address.value, "/index.php/settings");

    shell.send({ kind: "navigate", path: "/index.php/apps/photos" });
    assert.equal(address.value, "/index.php/apps/photos");
    shell.send({ kind: "navigate" });
    assert.equal(address.value, "/");

    // Back walks the shell's own history without recording the hop itself.
    back.click();
    assert.equal(address.value, "/index.php/apps/photos");
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/index.php/apps/photos",
    });
    back.click();
    assert.equal(address.value, "/index.php/settings");
    back.click();
    assert.equal(address.value, "/index.php/apps/files/");
    assert.equal(back.disabled, true);
    back.dispatchEvent(new shell.win.Event("click"));
    assert.equal(
      address.value,
      "/index.php/apps/files/",
      "empty stack is a no-op",
    );

    shell.click("#home-button");
    assert.equal(address.value, "/");
    assert.match(shell.logs(), /Navigating site to \//u);
    shell.click("#refresh-button");
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/",
    });

    address.value = "/index.php/apps/calendar";
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    assert.equal(shell.posted.at(-1).message.path, "/index.php/apps/calendar");
    address.value = "";
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    assert.equal(shell.posted.at(-1).message.path, "/");

    // Unknown and trace messages.
    shell.send({ kind: "trace", detail: "trace line" });
    shell.send({ kind: "trace" });
    shell.send({ kind: "something-else" });
    assert.match(shell.logs(), /trace line/u);
    assert.match(shell.logs(), /\[trace\]/u);
  });

  it("ignores navigation while the UI is locked", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s3" });
    const src = shell.frame.getAttribute("src");
    shell.click("#home-button");
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    const clickEvent = () => new shell.win.Event("click");
    shell.$("#export-button").dispatchEvent(clickEvent());
    shell.$("#reset-button").dispatchEvent(clickEvent());
    shell.$("#back-button").dispatchEvent(clickEvent());
    await tick();
    assert.doesNotMatch(shell.logs(), /Cannot export/u);
    assert.equal(shell.frame.getAttribute("src"), src);
    assert.equal(shell.posted.length, 0);
    assert.equal(shell.$("#address-input").value, "/index.php/apps/files");
  });

  it("reloads the frame when the remote host is not booted yet", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=s4&opcache=0",
    });
    assert.equal(shell.frameUrl().searchParams.get("opcache"), "0");
    assert.equal(shell.$("#info-opcache").checked, false);
    shell.send({ kind: "error", detail: "boot failed" });
    const first = shell.frame.getAttribute("src");
    shell.click("#home-button");
    await until(
      () => shell.frame.getAttribute("src") !== first,
      "new frame src",
    );
    assert.equal(shell.frameUrl().searchParams.get("path"), "/");
    assert.equal(shell.frameUrl().searchParams.get("opcache"), "0");

    // Booted but no frame window: navigation falls back to reloading the frame.
    shell.send({ kind: "ready", path: "/" });
    shell.setFrameWindow(false);
    const second = shell.frame.getAttribute("src");
    shell.$("#address-input").value = "/x";
    shell
      .$("#address-form")
      .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
    await until(
      () => shell.frame.getAttribute("src") !== second,
      "fallback reload",
    );
    assert.equal(shell.frameUrl().searchParams.get("path"), "/x");
  });

  it("reports runtime errors, warnings and diagnostics", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s5" });
    sentry.length = 0;

    shell.send({
      kind: "error",
      detail: "PHP fatal on /x",
      path: "/x",
      monitoring: { level: "warning", source: "php-request" },
    });
    assert.equal(shell.$("#address-input").disabled, false);
    assert.match(shell.logs(), /PHP fatal on \/x/u);
    assert.match(
      shell.logs(),
      /Requesting PHP runtime diagnostics \(bootstrap-error\)/u,
    );
    assert.deepEqual(shell.posted.at(-1).message, { kind: "capture-phpinfo" });
    await until(() => sentry.length, "sentry");
    assert.match(sentry[0], /PHP fatal on \/x/u);
    assert.match(sentry[0], /"level":"warning"/u);
    assert.match(sentry[0], /php-request/u);
    assert.equal(shell.$("#blocking-error"), null);

    shell.send({
      kind: "error",
      detail: "long detail",
      summary: "No Service Worker here",
      monitoring: { source: "service-worker-unsupported" },
    });
    assert.equal(
      shell.$("#blocking-error").textContent,
      "No Service Worker here",
    );
    assert.equal(shell.$("#blocking-error").getAttribute("role"), "alert");
    shell.send({
      kind: "error",
      detail: "detail only",
      monitoring: { source: "service-worker-unsupported" },
    });
    assert.equal(shell.document.querySelectorAll("#blocking-error").length, 1);
    assert.equal(shell.$("#blocking-error").textContent, "detail only");
    await until(
      () => sentry.some((body) => body.includes("detail only")),
      "sentry 2",
    );
    assert.ok(
      sentry.some(
        (body) =>
          body.includes('"level":"error"') && body.includes("long detail"),
      ),
    );

    shell.send({
      kind: "wasm-network-error",
      detail: "net failed",
      path: "/apps/x",
    });
    shell.send({
      kind: "wasm-network-error",
      detail: "net failed",
      path: "/apps/y",
    });
    const banners = shell.document.querySelectorAll("#wasm-network-warning");
    assert.equal(banners.length, 1);
    assert.match(banners[0].textContent, /"\/apps\/y" could not load/u);
    banners[0].querySelector("button").click();
    assert.equal(shell.$("#wasm-network-warning"), null);

    shell.send({
      kind: "phpinfo",
      html: "<html><head><title>phpinfo</title></head><body>PHP 8.3</body></html>",
    });
    const srcdoc = shell.$("#phpinfo-frame").getAttribute("srcdoc");
    assert.match(
      srcdoc,
      /<style>[\s\S]*\.center table[\s\S]*<\/style><\/head>/u,
    );
    assert.match(srcdoc, /PHP 8.3/u);
    assert.match(shell.logs(), /Captured PHP runtime diagnostics\./u);
    shell.send({ kind: "phpinfo" });
    assert.match(
      shell.$("#phpinfo-frame").getAttribute("srcdoc"),
      /No PHP diagnostics/u,
    );
    shell.send({ kind: "phpinfo", detail: "custom detail", html: 42 });
    assert.match(
      shell.$("#phpinfo-frame").getAttribute("srcdoc"),
      /No PHP diagnostics/u,
    );
    assert.match(shell.logs(), /custom detail/u);

    // Once diagnostics exist an error no longer re-requests them... unless
    // they were cleared again (html 42 above reset them).
    shell.send({ kind: "phpinfo", html: "<head></head>x" });
    const before = shell.posted.length;
    shell.send({ kind: "error", detail: "again" });
    assert.equal(shell.posted.length, before);

    shell.send({ kind: "persistence-flushed" });
    shell.send({ kind: "persistence-flushed", detail: "flushed 3 ops" });
    assert.match(shell.logs(), /Persistence journal flushed\./u);
    assert.match(shell.logs(), /flushed 3 ops/u);
  });

  it("switches side-panel tabs and toggles the panel", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s6" });
    const tabs = ["info", "logs", "phpinfo", "blueprint"];
    const visible = () =>
      tabs.filter(
        (name) => !shell.$(`#${name}-panel`).classList.contains("is-hidden"),
      );
    for (const name of tabs) {
      shell.click(`#${name}-tab`);
      assert.deepEqual(visible(), [name]);
      assert.equal(
        shell.$(`#${name}-tab`).getAttribute("aria-selected"),
        "true",
      );
      assert.ok(shell.$(`#${name}-tab`).classList.contains("is-active"));
    }
    assert.match(
      shell.logs(),
      /Requesting PHP runtime diagnostics \(tab-click\)/u,
    );

    shell.click("#info-tab");
    shell.send({ kind: "ready", path: "/" });
    shell.click("#refresh-phpinfo-button");
    assert.deepEqual(visible(), ["phpinfo"]);
    assert.match(shell.logs(), /\(manual\)/u);

    shell.setFrameWindow(false);
    shell.click("#refresh-phpinfo-button");
    assert.match(shell.logs(), /remote frame not available/u);

    const side = shell.$("#side-panel");
    const toggle = shell.$("#panel-toggle-button");
    shell.click("#panel-toggle-button");
    assert.equal(side.classList.contains("is-collapsed"), false);
    assert.equal(
      shell.$("#workspace").classList.contains("is-panel-collapsed"),
      false,
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    shell.click("#panel-close-button");
    assert.equal(side.classList.contains("is-collapsed"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    shell.click("#panel-close-button");
    assert.equal(
      side.classList.contains("is-collapsed"),
      true,
      "close keeps it closed",
    );
  });

  it("copies and clears logs and copies the runtime and build IDs", async (t) => {
    const shell = await boot({ href: "http://localhost:8080/?scope=s7" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const clipboard = shell.navigator.clipboard;
    const copyLogs = shell.$("#copy-logs-button");
    const icon = copyLogs.innerHTML;

    shell.click("#copy-logs-button");
    await until(() => clipboard.writes.length === 1, "copy logs");
    await tick();
    assert.match(clipboard.writes[0], /Playground build/u);
    assert.equal(copyLogs.textContent, "✓");
    t.mock.timers.tick(1200);
    assert.equal(copyLogs.innerHTML, icon);

    shell.click("#clear-logs-button");
    assert.equal(shell.logs(), "");
    shell.click("#copy-logs-button");
    await until(() => clipboard.writes.length === 2, "copy empty logs");
    assert.equal(clipboard.writes[1], "");

    shell.click("#runtime-id-chip");
    assert.equal(clipboard.writes.at(-1), "php83-nc33");
    assert.equal(shell.$("#runtime-id-value").textContent, "✓ copied");
    t.mock.timers.tick(1400);
    assert.equal(shell.$("#runtime-id-value").textContent, "php83-nc33");

    shell.click("#build-id-chip");
    assert.equal(clipboard.writes.at(-1), BUILD_VERSION);
    assert.equal(shell.$("#build-id-value").textContent, "✓ copied");
    t.mock.timers.tick(1400);
    assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);

    // No Clipboard API (insecure context): the chips still flash, nothing throws.
    delete shell.navigator.clipboard;
    shell.click("#runtime-id-chip");
    shell.click("#build-id-chip");
    assert.equal(shell.$("#runtime-id-value").textContent, "✓ copied");
    assert.equal(shell.$("#build-id-value").textContent, "✓ copied");
  });
});

describe("blueprint export and import", () => {
  it("exports the editor blueprint as a JSON download", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=e1" });
    shell.send({ kind: "ready", path: "/" });
    const clicks = [];
    const created = [];
    const revoked = [];
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = (blob) => {
      created.push(blob);
      return "blob:export";
    };
    URL.revokeObjectURL = (url) => revoked.push(url);
    shell.win.HTMLAnchorElement.prototype.click = function click() {
      clicks.push({ href: this.href, download: this.download });
    };
    try {
      shell.click("#export-button");
      assert.deepEqual(clicks, [
        {
          href: "blob:export",
          download: "nextcloud-playground.blueprint.json",
        },
      ]);
      assert.deepEqual(revoked, ["blob:export"]);
      assert.equal(created[0].type, "application/json");
      const exported = JSON.parse(await created[0].text());
      assert.equal(exported.landingPage, "/index.php/apps/files");

      // An invalid editor blocks the export.
      const textarea = shell.$("#blueprint-textarea");
      textarea.value = "{oops";
      textarea.dispatchEvent(new shell.win.Event("input"));
      shell.click("#export-button");
      assert.equal(clicks.length, 1);
      assert.match(shell.logs(), /Cannot export blueprint: Invalid JSON/u);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  function choose(shell, file) {
    const input = shell.$("#import-input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: file ? [file] : [],
    });
    change(input);
    return input;
  }

  it("restores an imported snapshot in place", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=e2" });
    shell.send({ kind: "error", detail: "x" });
    const first = shell.frame.getAttribute("src");
    choose(
      shell,
      new File(
        [
          JSON.stringify({
            version: 1,
            runtimeId: "php83-nc30",
            path: "/apps/x",
          }),
        ],
        "snap.json",
      ),
    );
    await until(
      () => shell.logs().includes("Imported configuration from snap.json"),
      "import",
    );
    assert.notEqual(shell.frame.getAttribute("src"), first);
    assert.equal(shell.frameUrl().searchParams.get("runtime"), "php83-nc30");
    assert.equal(shell.frameUrl().searchParams.get("path"), "/apps/x");
    assert.equal(shell.$("#address-input").value, "/apps/x");
    assert.equal(shell.$("#import-input").value, "");
    const state = JSON.parse(
      shell.window.sessionStorage.getItem("nextcloud-playground:e2:state"),
    );
    assert.ok(state.importedAt);

    choose(shell, new File([JSON.stringify({ version: 1 })], "bare.json"));
    await until(() => shell.logs().includes("bare.json"), "import 2");
    assert.equal(shell.$("#address-input").value, "/index.php/apps/files");
  });

  it("reloads with an imported blueprint encoded in the URL", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=e3&blueprint-url=http%3A%2F%2Fbp.test%2Fb.json",
      routes: { "http://bp.test/b.json": { landingPage: "/apps/old" } },
    });
    choose(
      shell,
      new File([JSON.stringify({ landingPage: "/apps/deck" })], "bp.json"),
    );
    await until(() => shell.location.navigations.length, "navigation");
    const url = new URL(shell.location.navigations[0]);
    assert.equal(url.searchParams.has("blueprint-url"), false);
    assert.equal(url.searchParams.has("blueprint-data"), false);
    const decoded = await decodeBlueprintParam(
      url.searchParams.get("blueprint"),
    );
    assert.equal(decoded.landingPage, "/apps/deck");
  });

  it("logs a broken import file and ignores an empty selection", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=e4" });
    choose(shell, new File(["{not json"], "broken.json"));
    await until(() => shell.$("#log-panel .error"), "import error");
    assert.match(shell.$("#log-panel .error").textContent, /JSON/u);
    assert.doesNotMatch(shell.logs(), /Imported configuration/u);
    const errors = shell.document.querySelectorAll("#log-panel .error").length;
    choose(shell, null);
    await tick();
    assert.equal(
      shell.document.querySelectorAll("#log-panel .error").length,
      errors,
    );
  });
});

describe("configuration panel", () => {
  it("marks a runtime switch dirty and resets onto the new runtime", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=c1" });
    shell.send({ kind: "ready", path: "/" });
    const select = shell.$("#info-runtime-version");
    const apply = shell.$("#config-apply");

    // Apply with nothing changed is a no-op.
    const before = shell.frame.getAttribute("src");
    apply.click();
    await tick();
    assert.equal(shell.frame.getAttribute("src"), before);

    select.value = "php83-nc30";
    change(select);
    assert.equal(shell.$("#config-status").className, "dirty-note");
    assert.match(shell.$("#config-status").innerHTML, /Unsaved/u);
    assert.equal(
      shell.$("#config-warning").classList.contains("is-hidden"),
      false,
    );
    assert.equal(
      shell.$("#config-reload-note").classList.contains("is-hidden"),
      true,
    );
    assert.equal(apply.classList.contains("is-hidden"), false);
    assert.equal(apply.classList.contains("danger"), true);
    assert.equal(apply.textContent, "Apply & Reset");

    // Reselecting the running version clears the dirty state.
    select.value = "php83-nc33";
    change(select);
    assert.equal(shell.$("#config-status").className, "status-pill");
    assert.match(shell.$("#config-status").innerHTML, /Running/u);
    assert.equal(apply.classList.contains("is-hidden"), true);

    select.value = "php83-nc30";
    change(select);
    apply.click();
    await until(
      () => shell.frame.getAttribute("src") !== before,
      "runtime switch",
    );
    assert.equal(shell.frameUrl().searchParams.get("runtime"), "php83-nc30");
    assert.equal(shell.frameUrl().searchParams.get("clean"), "1");
    assert.equal(shell.$("#runtime-id-value").textContent, "php83-nc30");
    assert.match(shell.logs(), /Switching runtime to php83-nc30/u);
    assert.equal(
      shell.posted.filter((p) => p.message.kind === "flush-persistence").length,
      0,
    );
    // Same script URL as the first registration: switching runtime must not
    // install a new Service Worker under the other open tabs.
    assert.equal(
      String(shell.registered.at(-1).url),
      String(shell.registered[0].url),
    );
  });

  it("flushes persistence before an OPcache-only restart", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=c2" });
    shell.send({ kind: "ready", path: "/" });
    const opcache = shell.$("#info-opcache");
    const apply = shell.$("#config-apply");
    opcache.checked = false;
    change(opcache);
    assert.equal(
      shell.$("#config-warning").classList.contains("is-hidden"),
      true,
    );
    assert.equal(
      shell.$("#config-reload-note").classList.contains("is-hidden"),
      false,
    );
    assert.equal(apply.textContent, "Apply & Reload");
    assert.equal(apply.classList.contains("danger"), false);

    const before = shell.frame.getAttribute("src");
    apply.click();
    await until(
      () => shell.posted.some((p) => p.message.kind === "flush-persistence"),
      "flush request",
    );
    assert.match(shell.logs(), /OPcache disabled; restarting PHP/u);
    assert.equal(
      new URL(shell.history.replaced.at(-1)).searchParams.get("opcache"),
      "0",
    );
    assert.equal(
      shell.frame.getAttribute("src"),
      before,
      "waits for the flush",
    );
    shell.send({ kind: "persistence-flushed" });
    await until(() => shell.frame.getAttribute("src") !== before, "restart");
    assert.equal(shell.frameUrl().searchParams.get("opcache"), "0");
    assert.equal(shell.frameUrl().searchParams.has("clean"), false);
    assert.match(
      shell.$("#phpinfo-frame").getAttribute("srcdoc"),
      /No PHP diagnostics/u,
    );

    // Turning it back on matches the config default, so the param is dropped.
    shell.send({ kind: "ready", path: "/" });
    opcache.checked = true;
    change(opcache);
    shell.setFrameWindow(false); // no frame: the flush resolves at once
    const second = shell.frame.getAttribute("src");
    apply.click();
    await until(() => shell.frame.getAttribute("src") !== second, "restart 2");
    assert.equal(
      new URL(shell.history.replaced.at(-1)).searchParams.has("opcache"),
      false,
    );
    assert.match(shell.logs(), /OPcache enabled/u);
  });

  it("restarts anyway when the persistence flush times out", async (t) => {
    const shell = await boot({ href: "http://localhost:8080/?scope=c3" });
    shell.send({ kind: "ready", path: "/" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    shell.$("#info-opcache").checked = false;
    shell.$("#config-apply").click();
    await until(
      () => shell.posted.some((p) => p.message.kind === "flush-persistence"),
      "flush request",
    );
    const before = shell.frame.getAttribute("src");
    t.mock.timers.tick(60_000);
    await until(() => shell.frame.getAttribute("src") !== before, "restart");
    assert.match(shell.logs(), /Persistence flush did not finish in time/u);
  });

  it("skips the flush when the remote host has not booted", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=c4" });
    shell.send({ kind: "ready", path: "/" });
    shell.send({ kind: "error", detail: "crash" });
    shell.$("#info-opcache").checked = false;
    const before = shell.frame.getAttribute("src");
    shell.$("#config-apply").click();
    await until(() => shell.frame.getAttribute("src") !== before, "restart");
    assert.equal(
      shell.posted.some((p) => p.message.kind === "flush-persistence"),
      false,
    );
  });

  it("works with a panel that lacks the optional configuration controls", async () => {
    const html = BODY.replace(
      /<select id="info-runtime-version"><\/select>/u,
      "",
    )
      .replace(/<input type="checkbox" id="info-opcache">/u, "")
      .replace(
        /id="(config-status|config-warning|config-reload-note|runtime-id-value|build-id-value|phpinfo-frame)"/gu,
        'data-removed="$1"',
      );
    const shell = await boot({ href: "http://localhost:8080/?scope=c5", html });
    assert.equal(shell.$("#info-runtime-version"), null);
    assert.match(shell.logs(), /Playground build/u);
    // Apply falls back to the running config: nothing to change.
    const before = shell.frame.getAttribute("src");
    shell.$("#config-apply").click();
    await tick();
    assert.equal(shell.frame.getAttribute("src"), before);
    shell.send({ kind: "phpinfo", html: "<head></head>" });
    assert.match(shell.logs(), /Captured PHP runtime diagnostics/u);
    // The ID chips still copy even without a label to flash.
    shell.click("#runtime-id-chip");
    shell.click("#build-id-chip");
    assert.deepEqual(shell.navigator.clipboard.writes.slice(-2), [
      "php83-nc33",
      BUILD_VERSION,
    ]);
  });
});

describe("reset", () => {
  it("clears the scope and boots clean on the default blueprint", async () => {
    const shell = await boot({ href: "http://localhost:8080/?scope=r1" });
    shell.send({ kind: "ready", path: "/" });
    shell.send({ kind: "navigate", path: "/index.php/apps/x" });
    shell.window.sessionStorage.setItem("nextcloud-playground:r1:extra", "1");
    shell.window.sessionStorage.setItem("other", "keep");
    const textarea = shell.$("#blueprint-textarea");
    textarea.value = "{}";
    textarea.dispatchEvent(new shell.win.Event("input"));
    const before = shell.frame.getAttribute("src");

    shell.click("#reset-button");
    await until(() => shell.frame.getAttribute("src") !== before, "reset");
    assert.equal(shell.frameUrl().searchParams.get("clean"), "1");
    assert.equal(
      shell.frameUrl().searchParams.get("path"),
      "/index.php/apps/files",
    );
    assert.equal(shell.$("#back-button").disabled, true);
    assert.equal(
      shell.window.sessionStorage.getItem("nextcloud-playground:r1:extra"),
      null,
    );
    assert.equal(shell.window.sessionStorage.getItem("other"), "keep");
    assert.equal(
      JSON.parse(textarea.value).landingPage,
      "/index.php/apps/files",
    );
  });

  it("keeps a URL-supplied blueprint across a reset", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=r2&blueprint-url=http%3A%2F%2Fbp.test%2Fb.json",
      routes: { "http://bp.test/b.json": { landingPage: "/apps/deck" } },
    });
    assert.equal(shell.frameUrl().searchParams.get("path"), "/apps/deck");
    shell.send({ kind: "ready", path: "/apps/deck" });
    const textarea = shell.$("#blueprint-textarea");
    const before = shell.frame.getAttribute("src");
    shell.click("#reset-button");
    await until(() => shell.frame.getAttribute("src") !== before, "reset");
    assert.equal(shell.frameUrl().searchParams.get("path"), "/apps/deck");
    assert.equal(JSON.parse(textarea.value).landingPage, "/apps/deck");
    assert.equal(
      JSON.parse(
        shell.window.sessionStorage.getItem(
          "nextcloud-playground:blueprint:r2",
        ),
      ).landingPage,
      "/apps/deck",
      "the URL blueprint stays the active one",
    );
  });
});

describe("boot variants", () => {
  it("reloads once so the Service Worker controls the page", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=v1",
      sw: { controller: null },
      waitForFrame: false,
    });
    await until(() => shell.location.reloads, "reload");
    assert.equal(shell.location.reloads, 1);
    assert.equal(
      shell.window.sessionStorage.getItem(
        "nextcloud-playground:v1:sw-controlled",
      ),
      "1",
    );
    await tick();
    assert.equal(
      shell.frame.getAttribute("src"),
      null,
      "boot waits for the reload",
    );
  });

  it("continues without control after the one reload", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=v2",
      sw: { controller: null },
      session: { "nextcloud-playground:v2:sw-controlled": "1" },
    });
    assert.equal(shell.location.reloads, 0);
    assert.equal(
      shell.window.sessionStorage.getItem(
        "nextcloud-playground:v2:sw-controlled",
      ),
      null,
    );
  });

  it("shows a blocking error when Service Workers are unavailable", async () => {
    sentry.length = 0;
    const shell = await boot({
      href: "http://localhost:8080/?scope=v3",
      sw: null,
      waitForFrame: false,
    });
    await until(() => shell.$("#blocking-error"), "blocking error");
    assert.match(
      shell.$("#blocking-error").textContent,
      /Service Workers are unavailable/u,
    );
    assert.equal(shell.$("#address-input").disabled, false);
    await until(() => sentry.length, "sentry");
    assert.match(sentry[0], /"level":"warning"/u);
    assert.match(sentry[0], /service-worker-unsupported/u);

    // Every later navigation re-shows it, but Sentry hears about it once.
    shell.click("#home-button");
    await tick();
    await tick();
    assert.equal(shell.document.querySelectorAll("#blocking-error").length, 1);
    assert.equal(shell.frame.getAttribute("src"), null);
    assert.equal(sentry.length, 1);
    assert.equal(
      (shell.logs().match(/Service Workers are unavailable/gu) || []).length,
      2,
    );
  });

  it("shows a non-Error registration rejection verbatim", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=v8",
      sw: {
        register: () => Promise.reject("blocked by policy"),
      },
      waitForFrame: false,
    });
    await until(() => shell.$("#blocking-error"), "blocking error");
    assert.equal(shell.$("#blocking-error").textContent, "blocked by policy");
  });

  it("reports a rejected Service Worker registration as an exception", async () => {
    sentry.length = 0;
    const shell = await boot({
      href: "http://localhost:8080/?scope=v4",
      sw: {
        register: async () => {
          throw new Error("SecurityError: bad scope");
        },
      },
      waitForFrame: false,
    });
    await until(() => shell.$("#blocking-error"), "blocking error");
    assert.equal(
      shell.$("#blocking-error").textContent,
      "SecurityError: bad scope",
    );
    await until(() => sentry.length, "sentry");
    assert.match(sentry[0], /"type":"event"/u);
    assert.match(sentry[0], /service-worker-registration/u);
    assert.match(sentry[0], /SecurityError: bad scope/u);
  });

  it("restores the saved runtime and path for the same blueprint", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=v5",
      session: {
        "blueprint-source:v5": "default",
        "nextcloud-playground:v5:state": JSON.stringify({
          runtimeId: "php83-nc30",
          path: "/index.php/apps/notes",
        }),
      },
    });
    assert.equal(shell.frameUrl().searchParams.get("runtime"), "php83-nc30");
    assert.equal(
      shell.frameUrl().searchParams.get("path"),
      "/index.php/apps/notes",
    );
    assert.equal(shell.frameUrl().searchParams.has("clean"), false);
  });

  it("skips a saved /login path when autologin is on", async () => {
    const shell = await boot({
      href: "http://localhost:8080/?scope=v6",
      session: {
        "nextcloud-playground:v6:state": JSON.stringify({ path: "/login" }),
      },
    });
    assert.equal(
      shell.frameUrl().searchParams.get("path"),
      "/index.php/apps/files",
    );
  });

  it("boots clean on the default runtime when the blueprint source changed", async () => {
    const config = await loadPlaygroundConfig();
    delete config.landingPath;
    try {
      const shell = await boot({
        href: "http://localhost:8080/?scope=v7",
        session: {
          "blueprint-source:v7": "url:https://old.test/bp.json",
          "nextcloud-playground:v7:state": JSON.stringify({
            runtimeId: "php83-nc30",
            path: "/index.php/apps/notes",
          }),
        },
      });
      const url = shell.frameUrl();
      assert.equal(url.searchParams.get("clean"), "1");
      assert.equal(url.searchParams.get("runtime"), "php83-nc33");
      assert.equal(url.searchParams.get("path"), "/index.php/login");
      assert.equal(
        shell.window.sessionStorage.getItem("blueprint-source:v7"),
        "default",
      );
    } finally {
      config.landingPath = CONFIG.landingPath;
    }
  });
});
