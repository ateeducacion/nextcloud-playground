import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { BUILD_VERSION } from "../src/generated/build-version.js";

// Boots src/remote/main.js inside a happy-dom window built from remote.html,
// with fake Service Worker, Web Locks, Worker and BroadcastChannel boundaries.
// Each boot imports a fresh module instance (query string) on a fresh window.

const REMOTE_HTML = readFileSync(
  new URL("../remote.html", import.meta.url),
  "utf8",
);
const ORIGIN = "https://pg.test";
const CONFIG = {
  runtimes: [
    { id: "php82", label: "PHP 8.2" },
    { id: "php83", label: "PHP 8.3", default: true },
  ],
  addonProxyUrl: "https://addons.test/proxy",
};

const saved = {};
for (const key of [
  "window",
  "document",
  "navigator",
  "fetch",
  "BroadcastChannel",
  "Worker",
]) {
  saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
}
after(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

function setGlobal(key, value) {
  Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function until(predicate, label) {
  for (let i = 0; i < 2000; i += 1) {
    const value = predicate();
    if (value) return value;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

let run = 0;

async function bootRemote({
  search = "?scope=s1&runtime=php82&path=/apps/files",
  blueprint,
  serviceWorker = "fresh",
  register,
  lockGranted = true,
  readyMessages,
  fastTimeout = false,
  beforeImport,
} = {}) {
  const window = new Window({
    url: `${ORIGIN}/app/remote.html${search}`,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  window.document.write(REMOTE_HTML);
  const document = window.document;

  const channels = [];
  const posted = [];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      this.closed = false;
      channels.push(this);
    }
    postMessage(message) {
      posted.push({ channel: this.name, message });
    }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    close() {
      this.closed = true;
    }
  }

  const workers = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = new URL(url);
      this.options = options;
      this.messages = [];
      this.terminated = false;
      this.target = new EventTarget();
      workers.push(this);
    }
    addEventListener(...args) {
      this.target.addEventListener(...args);
    }
    removeEventListener(...args) {
      this.target.removeEventListener(...args);
    }
    dispatch(type, init = {}) {
      const event = new Event(type);
      Object.assign(event, init);
      this.target.dispatchEvent(event);
    }
    postMessage(message) {
      this.messages.push(message);
      if (message.kind !== "configure-blueprint") return;
      const params = message.runtimeParams;
      const ready = readyMessages ?? [
        { kind: "progress" },
        { kind: "worker-ready", scopeId: "other", runtimeId: params.runtimeId },
        {
          kind: "worker-ready",
          scopeId: params.scopeId,
          runtimeId: params.runtimeId,
        },
      ];
      queueMicrotask(() => {
        for (const data of ready) this.dispatch("message", { data });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }

  const swPosted = [];
  const swTarget = new EventTarget();
  const registerCalls = [];
  const controller = {
    postMessage: (message) => swPosted.push(message),
  };
  let sw;
  if (serviceWorker !== "none") {
    sw = {
      controller: serviceWorker === "controlled" ? controller : null,
      ready: Promise.resolve({ active: true }),
      addEventListener: (type, listener, options) =>
        swTarget.addEventListener(type, listener, options),
      async register(url, options) {
        registerCalls.push({ url: new URL(url), options });
        if (register) return register(url, options);
        // Take control right after registration, as a fresh install does.
        setTimeout(() => {
          sw.controller = controller;
          swTarget.dispatchEvent(new Event("controllerchange"));
        }, 0);
        return { update: async () => {} };
      },
    };
  }

  const lockReleased = { value: false };
  const lockRequests = [];
  const navigator = {
    serviceWorker: sw,
    locks: {
      request(name, options, callback) {
        lockRequests.push({ name, options });
        return Promise.resolve(callback(lockGranted ? { name } : null)).then(
          () => {
            lockReleased.value = true;
          },
        );
      },
    },
  };
  if (serviceWorker === "none") delete navigator.serviceWorker;

  const fetchCalls = [];
  setGlobal("window", window);
  setGlobal("document", document);
  setGlobal("navigator", navigator);
  setGlobal("BroadcastChannel", FakeBroadcastChannel);
  setGlobal("Worker", FakeWorker);
  setGlobal("fetch", async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify(CONFIG), {
      headers: { "content-type": "application/json" },
    });
  });

  if (blueprint) {
    window.sessionStorage.setItem(
      "nextcloud-playground:blueprint:s1",
      JSON.stringify(blueprint),
    );
  }
  if (fastTimeout) {
    window.setTimeout = (callback) => {
      queueMicrotask(callback);
      return 1;
    };
  }
  const reloads = [];
  Object.defineProperty(window.location, "reload", {
    value: () => reloads.push(true),
    configurable: true,
  });
  beforeImport?.({ window, navigator });

  run += 1;
  await import(`../src/remote/main.js?run=${run}`);

  const frame = document.querySelector("#remote-frame");
  const text = (selector) => document.querySelector(selector).textContent;
  return {
    window,
    document,
    frame,
    channels,
    posted,
    workers,
    swPosted,
    swTarget,
    registerCalls,
    lockRequests,
    lockReleased,
    fetchCalls,
    reloads,
    status: () => text("#remote-status"),
    percent: () => text("#progress-percent"),
    fillWidth: () => document.querySelector("#progress-fill").style.width,
    overlayHidden: () =>
      document
        .querySelector(".remote-boot__card")
        .classList.contains("is-hidden"),
    messages: (kind) => posted.filter((entry) => entry.message?.kind === kind),
  };
}

function shellMessage(remote, data) {
  remote.window.dispatchEvent(
    new remote.window.MessageEvent("message", {
      data,
      origin: ORIGIN,
    }),
  );
}

test("remote host registers the Service Worker, boots the PHP worker and loads the scoped site", async () => {
  const remote = await bootRemote({
    search:
      "?scope=s1&runtime=php82&path=/apps/files&instance=inst-1&clean=1&opcache=0",
    blueprint: {
      browserCompatibility: { sandboxedIframes: "service-worker" },
      steps: [],
    },
  });
  await until(() => remote.percent() === "18%", "boot");
  assert.equal(remote.status(), "The embedded Nextcloud iframe is loading.");

  assert.equal(remote.lockRequests[0].name, "nextcloud-playground-owner:s1");
  assert.equal(remote.registerCalls.length, 1);
  const swUrl = remote.registerCalls[0].url;
  assert.equal(swUrl.pathname.endsWith("/sw.bundle.js"), true);
  assert.equal(swUrl.searchParams.get("v"), BUILD_VERSION);
  assert.equal(swUrl.searchParams.get("scope"), "s1");
  assert.equal(swUrl.searchParams.get("runtime"), "php82");
  assert.deepEqual(remote.registerCalls[0].options, {
    scope: "./",
    updateViaCache: "none",
  });

  assert.deepEqual(remote.swPosted, [
    {
      kind: "configure-service-worker",
      scopeId: "s1",
      addonProxyUrl: "https://addons.test/proxy",
      sandboxedIframeCompatibility: true,
    },
    { kind: "clear-static-cache" },
  ]);

  const [worker] = remote.workers;
  assert.equal(worker.options.type, "module");
  assert.equal(
    worker.url.pathname.endsWith("/dist/php-worker.bundle.js"),
    true,
  );
  assert.equal(worker.url.searchParams.get("scope"), "s1");
  assert.equal(worker.url.searchParams.get("instance"), "inst-1");
  assert.equal(worker.url.searchParams.get("runtime"), "php82");
  assert.equal(worker.url.searchParams.get("opcache"), "0");
  assert.equal(worker.url.searchParams.get("v"), BUILD_VERSION);
  assert.deepEqual(worker.messages[0], {
    kind: "configure-blueprint",
    runtimeParams: {
      scopeId: "s1",
      runtimeId: "php82",
      instanceId: "inst-1",
      opcacheParam: "0",
    },
    blueprint: {
      browserCompatibility: { sandboxedIframes: "service-worker" },
      steps: [],
    },
    clean: true,
  });

  assert.deepEqual(
    JSON.parse(
      remote.window.sessionStorage.getItem("nextcloud-playground:s1:state"),
    ),
    { runtimeId: "php82", path: "/apps/files" },
  );
  assert.equal(
    remote.frame.src,
    `${ORIGIN}/app/playground/s1/php82/apps/files`,
  );
  assert.equal(remote.percent(), "18%");
  assert.equal(remote.fillWidth(), "18%");
  assert.equal(remote.overlayHidden(), false);

  const progress = remote.messages("progress");
  assert.equal(progress[0].channel, "nextcloud-playground-shell:s1:inst-1");
  assert.equal(
    progress[0].message.detail,
    "Registering service worker for PHP 8.2.",
  );
  assert.equal(progress.at(-1).message.title, "Runtime host ready");
  assert.equal(
    remote.channels
      .filter((channel) => channel.listeners.length === 0)
      .every((channel) => channel.closed),
    true,
  );
});

test("remote host mirrors worker bootstrap progress and asset loading on the overlay", async () => {
  const remote = await bootRemote({ search: "?scope=s1&instance=i2" });
  await until(() => remote.percent() === "18%", "boot");
  const shell = remote.channels.find((channel) => channel.listeners.length);

  // sw-debug before bootstrap finishes does not touch the overlay.
  remote.swTarget.dispatchEvent(
    Object.assign(new Event("message"), { data: { kind: "sw-debug" } }),
  );
  assert.equal(remote.percent(), "18%");

  for (const listener of shell.listeners) {
    listener({
      data: { kind: "progress", detail: "Installing apps", progress: 0.5 },
    });
    listener({ data: { kind: "log", detail: "ignored" } });
  }
  assert.equal(remote.status(), "Installing apps");
  assert.equal(remote.percent(), "50%");

  for (const listener of shell.listeners) {
    listener({
      data: { kind: "progress", detail: "Nextcloud is ready", progress: 1.4 },
    });
  }
  assert.equal(remote.percent(), "100%");

  remote.swTarget.dispatchEvent(
    Object.assign(new Event("message"), { data: { kind: "other" } }),
  );
  assert.equal(remote.status(), "Nextcloud is ready");
  remote.swTarget.dispatchEvent(
    Object.assign(new Event("message"), { data: { kind: "sw-debug" } }),
  );
  assert.equal(remote.status(), "Loading page assets…");
  assert.equal(remote.percent(), "97%");

  // Default runtime is the config entry flagged `default`.
  assert.equal(remote.workers[0].url.searchParams.get("runtime"), "php83");
  assert.equal(remote.workers[0].url.searchParams.has("opcache"), false);
  assert.equal(remote.swPosted.length, 1);
  assert.equal(remote.swPosted[0].sandboxedIframeCompatibility, false);
});

test("remote host answers shell commands from its own origin only", async () => {
  const remote = await bootRemote();
  await until(() => remote.percent() === "18%", "boot");
  const [worker] = remote.workers;
  const contentWindow = {
    location: {
      href: "",
      reloaded: 0,
      reload() {
        this.reloaded += 1;
      },
    },
  };
  Object.defineProperty(remote.frame, "contentWindow", {
    get: () => contentWindow,
    configurable: true,
  });

  remote.window.dispatchEvent(
    new remote.window.MessageEvent("message", {
      data: { kind: "navigate-site", path: "/evil" },
      origin: "https://evil.test",
    }),
  );
  assert.equal(
    remote.frame.src,
    `${ORIGIN}/app/playground/s1/php82/apps/files`,
  );

  shellMessage(remote, { kind: "navigate-site", path: "/settings" });
  assert.equal(remote.frame.src, `${ORIGIN}/app/playground/s1/php82/settings`);

  // Same URL again: navigate the live document instead of re-setting src.
  shellMessage(remote, { kind: "navigate-site", path: "/settings" });
  assert.equal(
    contentWindow.location.href,
    `${ORIGIN}/app/playground/s1/php82/settings`,
  );

  shellMessage(remote, { kind: "navigate-site" });
  assert.equal(remote.frame.src, `${ORIGIN}/app/playground/s1/php82/`);

  // refresh-site is gone: a reload could resubmit a page rendered from a POST.
  shellMessage(remote, { kind: "refresh-site" });
  assert.equal(contentWindow.location.reloaded, 0);

  shellMessage(remote, { kind: "capture-phpinfo" });
  shellMessage(remote, { kind: "flush-persistence" });
  shellMessage(remote, { kind: "unknown" });
  shellMessage(remote, null);
  assert.deepEqual(
    worker.messages.slice(1).map((message) => message.kind),
    ["capture-phpinfo", "flush-persistence"],
  );
});

test("remote host reports iframe loads as ready + navigation, unscoping the path", async () => {
  const remote = await bootRemote();
  await until(() => remote.percent() === "18%", "boot");
  let href = `${ORIGIN}/app/playground/s1/php82/apps/dashboard?x=1#top`;
  Object.defineProperty(remote.frame, "contentWindow", {
    get: () => ({ location: { href } }),
    configurable: true,
  });

  remote.frame.dispatchEvent(new remote.window.Event("load"));
  assert.equal(remote.overlayHidden(), true);
  assert.deepEqual(remote.messages("ready").at(-1).message, {
    kind: "ready",
    detail: "Iframe loaded for php82.",
    path: "/apps/dashboard?x=1#top",
  });
  assert.equal(
    remote.messages("navigate").at(-1).message.path,
    "/apps/dashboard?x=1#top",
  );

  // A URL outside this scope is reported verbatim.
  href = `${ORIGIN}/app/playground/other/php82/x`;
  remote.frame.dispatchEvent(new remote.window.Event("load"));
  assert.equal(
    remote.messages("navigate").at(-1).message.path,
    "/app/playground/other/php82/x",
  );

  // Scope root without a trailing path maps to "/".
  href = `${ORIGIN}/app/playground/s1/php82`;
  remote.frame.dispatchEvent(new remote.window.Event("load"));
  assert.equal(remote.messages("navigate").at(-1).message.path, "/");

  // A cross-context access error keeps the last known path, for the ready
  // message and for the navigate message that follows it (#126).
  href = `${ORIGIN}/app/playground/s1/php82/apps/files`;
  remote.frame.dispatchEvent(new remote.window.Event("load"));
  Object.defineProperty(remote.frame, "contentWindow", {
    get: () => ({
      get location() {
        throw new Error("SecurityError");
      },
    }),
    configurable: true,
  });
  const navigations = remote.messages("navigate").length;
  const readies = remote.messages("ready").length;
  const listenerErrors = [];
  remote.window.console.error = (...args) => listenerErrors.push(args);
  remote.frame.dispatchEvent(new remote.window.Event("load"));
  assert.deepEqual(listenerErrors, []);
  assert.equal(remote.messages("ready").length, readies + 1);
  assert.equal(remote.messages("ready").at(-1).message.path, "/apps/files");
  assert.equal(remote.messages("navigate").length, navigations + 1);
  assert.equal(remote.messages("navigate").at(-1).message.path, "/apps/files");

  // No content window: fall back to the scoped entry URL.
  Object.defineProperty(remote.frame, "contentWindow", {
    get: () => null,
    configurable: true,
  });
  remote.frame.dispatchEvent(new remote.window.Event("load"));
  assert.equal(remote.messages("ready").at(-1).message.path, "/apps/files");
  assert.equal(remote.messages("navigate").at(-1).message.path, "/apps/files");
});

test("remote host surfaces PHP worker error events", async () => {
  const remote = await bootRemote();
  await until(() => remote.percent() === "18%", "boot");
  const [worker] = remote.workers;

  worker.dispatch("error", { message: "boom in worker" });
  assert.equal(remote.status(), "boom in worker");
  assert.equal(
    remote.messages("error").at(-1).message.detail,
    "boom in worker",
  );

  worker.dispatch("error");
  assert.equal(
    remote.status(),
    "php-worker failed before signalling readiness.",
  );

  worker.dispatch("messageerror");
  assert.equal(remote.status(), "php-worker posted a malformed message.");
  assert.equal(remote.messages("error").length, 3);
});

test("remote host terminates the worker and releases the scope on pagehide", async () => {
  const remote = await bootRemote();
  await until(() => remote.percent() === "18%", "boot");
  remote.window.dispatchEvent(new remote.window.Event("pagehide"));
  assert.equal(remote.workers[0].terminated, true);
  await until(() => remote.lockReleased.value, "lock release");

  const pageshow = new remote.window.Event("pageshow");
  remote.window.dispatchEvent(pageshow);
  assert.equal(remote.reloads.length, 0);
  const restored = new remote.window.Event("pageshow");
  Object.defineProperty(restored, "persisted", { value: true });
  remote.window.dispatchEvent(restored);
  assert.equal(remote.reloads.length, 1);
});

test("remote host gives the scope back when the page hides before ownership resolves", async () => {
  const remote = await bootRemote({
    beforeImport: ({ navigator, window }) => {
      const request = navigator.locks.request;
      navigator.locks.request = (...args) => {
        // The tab is hidden while the lock request is in flight.
        window.dispatchEvent(new window.Event("pagehide"));
        return request(...args);
      };
    },
  });
  await until(() => remote.lockReleased.value, "lock release");
  assert.equal(remote.workers.length, 0);
  assert.equal(remote.registerCalls.length, 0);
});

test("remote host stops before spawning a worker when hidden during Service Worker setup", async () => {
  const remote = await bootRemote({
    serviceWorker: "controlled",
    beforeImport: ({ navigator, window }) => {
      const controller = {
        postMessage: () => window.dispatchEvent(new window.Event("pagehide")),
      };
      navigator.serviceWorker.controller = controller;
    },
  });
  await until(() => remote.lockReleased.value, "lock release");
  assert.equal(remote.workers.length, 0);
  assert.equal(remote.registerCalls.length, 0);
});

test("remote host reuses an already-controlling Service Worker", async () => {
  const remote = await bootRemote({ serviceWorker: "controlled" });
  await until(() => remote.percent() === "18%", "boot");
  assert.equal(remote.registerCalls.length, 0);
  assert.equal(remote.swPosted[0].kind, "configure-service-worker");
  assert.equal(remote.swPosted[0].addonProxyUrl, "https://addons.test/proxy");
});

test("remote host reports an unsupported browser as a warning", async () => {
  const remote = await bootRemote({ serviceWorker: "none" });
  const error = await until(() => remote.messages("error")[0], "error");
  assert.match(remote.status(), /Service Workers are unavailable/u);
  assert.equal(remote.overlayHidden(), false);
  assert.deepEqual(error.message.monitoring, {
    level: "warning",
    source: "service-worker-unsupported",
  });
  assert.match(error.message.summary, /Service Workers are unavailable/u);
  assert.match(error.message.detail, /ServiceWorkerUnsupportedError/u);
});

test("remote host tags a rejected Service Worker registration", async () => {
  const remote = await bootRemote({
    register: async () => {
      throw new Error("SecurityError: bad scope");
    },
  });
  const error = await until(() => remote.messages("error")[0], "error");
  // The boot card shows the message; the stack only goes to the shell log (#126).
  assert.equal(remote.status(), "SecurityError: bad scope");
  assert.match(error.message.detail, /^SecurityError: bad scope\n.*\n\s+at /u);
  assert.deepEqual(error.message.monitoring, {
    level: "error",
    source: "service-worker-registration",
  });
});

test("remote host refuses a scope already open in another tab", async () => {
  const remote = await bootRemote({ lockGranted: false });
  const error = await until(() => remote.messages("error")[0], "error");
  assert.match(remote.status(), /already open in another tab/u);
  assert.equal(error.message.monitoring, null);
  assert.equal(
    error.channel.startsWith("nextcloud-playground-shell:s1:"),
    true,
  );
});

test("remote host fails boot when the PHP worker never signals readiness", async () => {
  const remote = await bootRemote({ readyMessages: [], fastTimeout: true });
  await until(() => remote.messages("error")[0], "error");
  assert.match(
    remote.status(),
    /^Timed out while waiting for php-worker readiness for php82\./u,
  );
});

test("remote host fails boot when the Service Worker API disappears before control", async () => {
  const remote = await bootRemote({
    register: async () => {
      delete navigator.serviceWorker.register;
      return {};
    },
  });
  await until(() => remote.messages("error")[0], "error");
  assert.match(remote.status(), /Service Workers are unavailable/u);
});

test("remote host shows non-Error rejections verbatim", async () => {
  const remote = await bootRemote({
    beforeImport: ({ navigator }) => {
      navigator.locks.request = () => Promise.reject("plain failure");
    },
  });
  const error = await until(() => remote.messages("error")[0], "error");
  assert.equal(remote.status(), "plain failure");
  assert.equal(error.message.detail, "plain failure");
});
