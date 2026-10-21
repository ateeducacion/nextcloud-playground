import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BUILD_VERSION } from "../src/generated/build-version.js";

// Drives sw.js through fake Service Worker globals: the registration scope,
// Cache Storage, clients, fetch and the BroadcastChannel bridge to the PHP
// worker. Each env imports a fresh module instance, so module state (bridges,
// client contexts, config memo, base path) never leaks between tests.

const ORIGIN = "https://pg.test";
const DIST_CACHE = `fs-dist-${BUILD_VERSION}`;
const ASSET_CACHE = `fs-static-assets-${BUILD_VERSION}`;

const saved = {};
for (const key of ["self", "caches", "fetch", "BroadcastChannel"]) {
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

class FakeCacheStorage {
  constructor() {
    this.stores = new Map();
    this.deleted = [];
    this.failOpen = false;
  }
  async open(name) {
    if (this.failOpen) throw new Error("SecurityError");
    if (!this.stores.has(name)) {
      const entries = new Map();
      const key = (request) =>
        typeof request === "string" ? request : request.url;
      this.stores.set(name, {
        entries,
        async match(request) {
          return entries.get(key(request))?.clone();
        },
        async put(request, response) {
          entries.set(key(request), response);
        },
      });
    }
    return this.stores.get(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name) {
    this.deleted.push(name);
    return this.stores.delete(name);
  }
}

let run = 0;

async function loadSw({
  scope = `${ORIGIN}/`,
  config = { addonProxyUrl: "" },
  configOk = true,
  clients = {},
  phpHandler = () => ({
    body: "<html><head></head><body>ok</body></html>",
    headers: { "content-type": "text/html" },
  }),
  bridgeThrows = false,
  fastTimeout = false,
} = {}) {
  const listeners = {};
  const broadcasts = [];
  const channels = [];
  const forwarded = [];
  const fetchCalls = [];
  const network = new Map();
  let claimed = 0;
  let skipped = 0;

  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      channels.push(this);
    }
    addEventListener(_type, listener) {
      this.listeners.push(listener);
    }
    postMessage(message) {
      if (bridgeThrows) throw new Error("DataCloneError");
      forwarded.push(message);
      const reply = phpHandler(message.request, message);
      if (reply === undefined) return;
      queueMicrotask(() => {
        for (const listener of this.listeners) {
          listener({
            data: {
              id: message.id,
              ...("kind" in reply
                ? reply
                : {
                    kind: "http-response",
                    response: { status: 200, statusText: "OK", ...reply },
                  }),
            },
          });
        }
      });
    }
  }

  const cacheStorage = new FakeCacheStorage();
  setGlobal("caches", cacheStorage);
  setGlobal("BroadcastChannel", FakeBroadcastChannel);
  setGlobal("fetch", async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchCalls.push({ url, init, input });
    if (url === new URL("playground.config.json", scope).href) {
      return configOk
        ? Response.json(config)
        : new Response("missing", { status: 404 });
    }
    const handler = network.get(new URL(url).pathname);
    return handler ? handler(input, init) : new Response(`net:${url}`);
  });
  setGlobal("self", {
    registration: { scope },
    location: { origin: ORIGIN },
    clients: {
      async matchAll(options) {
        broadcasts.options = options;
        return [{ postMessage: (message) => broadcasts.push(message) }];
      },
      async get(id) {
        return clients[id] ?? null;
      },
      async claim() {
        claimed += 1;
      },
    },
    skipWaiting: async () => {
      skipped += 1;
    },
    setTimeout: fastTimeout
      ? (callback) => {
          queueMicrotask(callback);
          return 0;
        }
      : (callback, ms) => {
          // The bridge timeout is 3 minutes; never let it keep the test alive.
          const id = setTimeout(callback, ms);
          id.unref();
          return id;
        },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  });

  run += 1;
  await import(`../sw.js?run=${run}`);

  async function request(
    path,
    { method = "GET", headers, body, mode, referrer, clientId } = {},
  ) {
    const request = new Request(new URL(path, ORIGIN), {
      method,
      headers,
      body,
    });
    if (mode) Object.defineProperty(request, "mode", { value: mode });
    if (referrer)
      Object.defineProperty(request, "referrer", { value: referrer });
    let responded = null;
    listeners.fetch({
      request,
      clientId,
      respondWith(promise) {
        responded = promise;
      },
    });
    return responded ? await responded : null;
  }

  return {
    listeners,
    broadcasts,
    channels,
    forwarded,
    fetchCalls,
    network,
    cacheStorage,
    request,
    get claimed() {
      return claimed;
    },
    get skipped() {
      return skipped;
    },
    message(data, source) {
      listeners.message({ data, source });
    },
  };
}

test("install skips waiting and activate drops stale cache generations", async () => {
  const sw = await loadSw();
  let waited;
  sw.listeners.install({ waitUntil: (promise) => (waited = promise) });
  await waited;
  assert.equal(sw.skipped, 1);

  for (const name of [
    "fs-dist-old",
    DIST_CACHE,
    "fs-static-assets-old",
    ASSET_CACHE,
    "unrelated",
  ]) {
    await sw.cacheStorage.open(name);
  }
  sw.listeners.activate({ waitUntil: (promise) => (waited = promise) });
  await waited;
  assert.deepEqual(sw.cacheStorage.deleted.sort(), [
    "fs-dist-old",
    "fs-static-assets-old",
  ]);
  assert.deepEqual(
    [...sw.cacheStorage.stores.keys()].sort(),
    [ASSET_CACHE, DIST_CACHE, "unrelated"].sort(),
  );
  assert.equal(sw.claimed, 1);
});

test("cross-origin requests are left to the browser", async () => {
  const sw = await loadSw();
  assert.equal(
    await sw.request("https://raw.githubusercontent.com/x/y.json"),
    null,
  );
  assert.equal(sw.fetchCalls.length, 0);
});

test("runtime /dist assets are served cache-first and only complete responses are stored", async () => {
  const sw = await loadSw();
  sw.network.set("/dist/php.wasm", () => new Response("wasm-bytes"));
  sw.network.set("/dist/intl.so", () => new Response("part", { status: 206 }));

  assert.equal(await (await sw.request("/dist/php.wasm")).text(), "wasm-bytes");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await (await sw.request("/dist/php.wasm")).text(), "wasm-bytes");
  assert.equal(
    sw.fetchCalls.filter((call) => call.url.endsWith("/dist/php.wasm")).length,
    1,
  );

  assert.equal((await sw.request("/dist/intl.so")).status, 206);
  assert.equal(
    (await sw.cacheStorage.open(DIST_CACHE)).entries.has(
      `${ORIGIN}/dist/intl.so`,
    ),
    false,
  );

  // Range requests bypass the cache and go straight to the network.
  await sw.request("/dist/php.wasm", { headers: { range: "bytes=0-1" } });
  assert.equal(
    sw.fetchCalls.filter((call) => call.url.endsWith("/dist/php.wasm")).length,
    2,
  );

  // No Cache Storage (e.g. blocked): plain network fetch.
  sw.cacheStorage.failOpen = true;
  assert.equal(await (await sw.request("/dist/php.wasm")).text(), "wasm-bytes");
  assert.equal(
    sw.fetchCalls.filter((call) => call.url.endsWith("/dist/php.wasm")).length,
    3,
  );
});

test("the internal proxy forwards to the configured addon proxy", async () => {
  const sw = await loadSw({
    config: { addonProxyUrl: "https://proxy.test/fetch" },
  });
  sw.network.set(
    "/fetch",
    (_url, init) =>
      new Response(`proxied:${init.method}`, {
        status: 201,
        statusText: "Created",
        headers: {
          "content-length": "99",
          "x-up": "1",
          "cache-control": "max-age=60",
        },
      }),
  );

  const get = await sw.request(
    "/__playground_proxy__?url=https%3A%2F%2Fapps.test%2Fa.tgz",
    {
      headers: { "x-test": "1" },
    },
  );
  assert.equal(get.status, 201);
  assert.equal(get.statusText, "Created");
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(get.headers.get("content-length"), null);
  assert.equal(get.headers.get("x-up"), "1");
  assert.equal(await get.text(), "proxied:GET");
  const upstream = sw.fetchCalls.find((call) =>
    call.url.startsWith("https://proxy.test/"),
  );
  assert.equal(
    upstream.url,
    "https://proxy.test/fetch?url=https%3A%2F%2Fapps.test%2Fa.tgz",
  );
  assert.equal(upstream.init.redirect, "follow");
  assert.equal(upstream.init.headers.get("x-test"), "1");
  assert.equal(upstream.init.body, undefined);

  const post = await sw.request("/__playground_proxy__?x=1", {
    method: "POST",
    body: "payload",
  });
  assert.equal(await post.text(), "proxied:POST");
  const postCall = sw.fetchCalls.findLast((call) =>
    call.url.startsWith("https://proxy.test/"),
  );
  assert.equal(new TextDecoder().decode(postCall.init.body), "payload");

  // The config is fetched once per worker lifetime.
  assert.equal(
    sw.fetchCalls.filter((call) => call.url.endsWith("playground.config.json"))
      .length,
    1,
  );
});

test("the internal proxy fails with 502 when no proxy is configured", async () => {
  const sw = await loadSw({ configOk: false });
  const response = await sw.request("/__playground_proxy__?url=x");
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /No addon proxy configured\./u);
});

test("only the remote host page may reconfigure the worker", async () => {
  const sw = await loadSw({
    config: { addonProxyUrl: "https://proxy.test/config" },
  });
  sw.network.set("/config", () => new Response("config-proxy"));
  sw.network.set("/override", () => new Response("override-proxy"));

  sw.message(
    {
      kind: "configure-service-worker",
      addonProxyUrl: "https://proxy.test/override",
    },
    { url: `${ORIGIN}/playground/s1/php83/index.php` },
  );
  sw.message(
    {
      kind: "configure-service-worker",
      addonProxyUrl: "https://proxy.test/override",
    },
    {},
  );
  sw.message(
    {
      kind: "configure-service-worker",
      addonProxyUrl: "https://proxy.test/override",
    },
    null,
  );
  assert.equal(
    await (await sw.request("/__playground_proxy__")).text(),
    "config-proxy",
  );

  sw.message(
    {
      kind: "configure-service-worker",
      addonProxyUrl: "https://proxy.test/override",
    },
    { url: `${ORIGIN}/remote.html?scope=s1` },
  );
  assert.equal(
    await (await sw.request("/__playground_proxy__")).text(),
    "override-proxy",
  );

  sw.message(
    { kind: "configure-service-worker" },
    { url: `${ORIGIN}/remote.html` },
  );
  assert.equal(
    await (await sw.request("/__playground_proxy__")).text(),
    "config-proxy",
  );

  sw.message({ kind: "unknown" });
  sw.message(null);
  assert.deepEqual(sw.cacheStorage.deleted, []);
  sw.message({ kind: "clear-static-cache" });
  assert.deepEqual(sw.cacheStorage.deleted, [ASSET_CACHE]);
});

test("scoped requests are forwarded to the PHP worker and HTML is rewritten for the scope", async () => {
  const html = [
    '<html><head data-x="1"><meta name="csp-nonce" nonce="n0nce">',
    '<script nonce="n0nce">var _oc_webroot = "";</script>',
    '<a href="/index.php/apps/files">files</a>',
    "<a href='https://pg.test/core/img.png?v=1#h'>abs</a>",
    '<a href="/playground/s1/php83/already">scoped</a>',
    '<a href="#top">hash</a><a href="javascript:void(0)">js</a>',
    '<img src="data:image/png;base64,AA"><a href="mailto:a@b.c">m</a><a href="tel:1">t</a>',
    '<script src="//cdn.test/x.js"></script><script src="libs/app.js"></script>',
    '<a href="https://other.test/x">ext</a><a href="">empty</a>',
    '<form action="&#x2F;index.php&#47;login?a=1&amp;b=2"></form>',
    '<div data-url="&sol;apps&colon;x" data-href="&apos;/q&quot;"></div>',
    '<a href="http://[bad">bad</a>',
    "</head><body></body></html>",
  ].join("");
  const sw = await loadSw({
    phpHandler: () => ({
      body: html,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": "5",
      },
    }),
  });

  const response = await sw.request(
    "/playground/s1/php83/index.php/apps/files?dir=/",
    {
      headers: { "x-requested-with": "XMLHttpRequest" },
      clientId: "client-1",
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null);
  const body = await response.text();

  const [message] = sw.forwarded;
  assert.equal(message.kind, "http-request");
  assert.equal(sw.channels[0].name, "nextcloud-playground-php:s1");
  assert.equal(message.request.url, `${ORIGIN}/index.php/apps/files?dir=%2F`);
  assert.equal(message.request.method, "GET");
  assert.equal(message.request.headers["x-requested-with"], "XMLHttpRequest");
  assert.equal(message.request.body, null);
  assert.equal(sw.broadcasts[0].kind, "sw-debug");
  assert.match(
    sw.broadcasts[0].detail,
    /^Intercepting GET \/playground\/s1\/php83\/index\.php\/apps\/files$/u,
  );
  assert.deepEqual(sw.broadcasts.options, {
    type: "window",
    includeUncontrolled: true,
  });

  assert.match(
    body,
    /<head data-x="1"><script nonce="n0nce">\(function\(\)\{try\{var n=false/u,
  );
  assert.match(body, /var _oc_webroot="\/playground\/s1\/php83";/u);
  assert.match(
    body,
    /href="\/playground\/s1\/php83\/index\.php\/apps\/files"/u,
  );
  assert.match(body, /href='\/playground\/s1\/php83\/core\/img\.png\?v=1#h'/u);
  assert.match(body, /href="\/playground\/s1\/php83\/already"/u);
  assert.match(body, /href="#top"/u);
  assert.match(body, /href="javascript:void\(0\)"/u);
  assert.match(body, /src="data:image\/png;base64,AA"/u);
  assert.match(body, /href="mailto:a@b\.c"/u);
  assert.match(body, /href="tel:1"/u);
  assert.match(body, /src="\/\/cdn\.test\/x\.js"/u);
  assert.match(body, /src="libs\/app\.js"/u);
  assert.match(body, /href="https:\/\/other\.test\/x"/u);
  assert.match(body, /href=""/u);
  assert.match(
    body,
    /action="\/playground\/s1\/php83\/index\.php\/login\?a=1&amp;b=2"/u,
  );
  assert.match(body, /data-url="\/playground\/s1\/php83\/apps:x"/u);
  // Decoded quotes are re-escaped so the attribute cannot be closed early.
  assert.match(body, /data-href="&#39;\/q&quot;"/u);
  assert.match(body, /href="http:\/\/\[bad"/u);
});

test("HTML without a CSP nonce gets an un-nonced shim; a nonce'd script is the fallback source", async () => {
  let html = "<html><head></head><body></body></html>";
  const sw = await loadSw({
    phpHandler: () => ({
      body: html,
      headers: { "content-type": "application/xhtml+xml" },
    }),
  });
  assert.match(
    await (await sw.request("/playground/s1/php83/")).text(),
    /<head><script>\(function/u,
  );

  html = '<html><head><script nonce="abc&quot;"></script></head></html>';
  assert.match(
    await (await sw.request("/playground/s1/php83/")).text(),
    /<head><script nonce="abc&amp;quot;">/u,
  );
});

test("WebDAV multistatus hrefs are prefixed with the scoped base", async () => {
  const xml = [
    "<d:multistatus>",
    "<d:href>/remote.php/dav/files/admin/</d:href>",
    "<d:href>/playground/s1/php83/remote.php/dav/x</d:href>",
    "<d:href>/playground/s1/php83</d:href>",
    "<d:href>//cdn/x</d:href><d:href>relative</d:href><d:href></d:href>",
    "</d:multistatus>",
  ].join("");
  const sw = await loadSw({
    phpHandler: () => ({
      status: 207,
      statusText: "Multi-Status",
      body: xml,
      headers: { "content-type": "application/xml; charset=utf-8" },
    }),
  });
  const response = await sw.request(
    "/playground/s1/php83/remote.php/dav/files/admin/",
    {
      method: "PROPFIND",
      body: "<propfind/>",
      headers: { depth: "1" },
    },
  );
  assert.equal(response.status, 207);
  assert.equal(response.statusText, "Multi-Status");
  assert.equal(
    await response.text(),
    [
      "<d:multistatus>",
      "<d:href>/playground/s1/php83/remote.php/dav/files/admin/</d:href>",
      "<d:href>/playground/s1/php83/remote.php/dav/x</d:href>",
      "<d:href>/playground/s1/php83</d:href>",
      "<d:href>//cdn/x</d:href><d:href>relative</d:href><d:href></d:href>",
      "</d:multistatus>",
    ].join(""),
  );
  // The PROPFIND body is buffered before the handler yields and forwarded as bytes.
  const forwarded = sw.forwarded[0].request;
  assert.equal(forwarded.method, "PROPFIND");
  assert.equal(new TextDecoder().decode(forwarded.body), "<propfind/>");
  assert.equal(
    sw.broadcasts.at(-1).detail,
    "[sw-bridge] → worker: PROPFIND /remote.php/dav/files/admin/",
  );
});

test("same-origin redirects are kept inside the scope; others pass through untouched", async () => {
  let location = "/index.php/login?redirect_url=x#frag";
  const sw = await loadSw({
    phpHandler: () => ({
      status: 302,
      statusText: "Found",
      body: "",
      headers: location
        ? { location, "content-type": "text/plain" }
        : { "content-type": "text/plain" },
    }),
  });
  let response = await sw.request("/playground/s1/php83/index.php");
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/playground/s1/php83/index.php/login?redirect_url=x#frag",
  );

  location = "https://other.test/elsewhere";
  response = await sw.request("/playground/s1/php83/index.php");
  assert.equal(
    response.headers.get("location"),
    "https://other.test/elsewhere",
  );

  // A plain-text body is passed through without rewriting.
  location = "";
  response = await sw.request("/playground/s1/php83/status.php");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("content-type"), "text/plain");
});

test("sandboxed-iframe compatibility requests keep their marker and skip the shims", async () => {
  const html = '<html><head></head><body><a href="/x">x</a></body></html>';
  let reply = { body: html, headers: { "content-type": "text/html" } };
  const sw = await loadSw({ phpHandler: () => reply });

  // Opt this scope into the sandboxed-iframe shim from the remote host.
  sw.message(
    {
      kind: "configure-service-worker",
      scopeId: "s1",
      sandboxedIframeCompatibility: true,
    },
    { url: `${ORIGIN}/remote.html` },
  );
  let body = await (await sw.request("/playground/s1/php83/")).text();
  assert.match(body, /HTMLIFrameElement\.prototype/u);
  assert.match(body, /"\/playground\/s1\/php83"/u);

  body = await (
    await sw.request(
      "/playground/s1/php83/apps/x/embed?__playground_iframe=1&a=1",
    )
  ).text();
  assert.equal(sw.forwarded.at(-1).request.url, `${ORIGIN}/apps/x/embed?a=1`);
  assert.equal(
    body,
    '<html><head></head><body><a href="/playground/s1/php83/x">x</a></body></html>',
  );

  reply = { status: 303, body: "", headers: { location: "/apps/x/next" } };
  const redirect = await sw.request(
    "/playground/s1/php83/apps/x/embed?__playground_iframe=1",
  );
  assert.equal(
    redirect.headers.get("location"),
    "/playground/s1/php83/apps/x/next?__playground_iframe=1",
  );

  // Turning the flag off for the scope removes the shim again.
  reply = { body: html, headers: { "content-type": "text/html" } };
  sw.message(
    { kind: "configure-service-worker", scopeId: "s1" },
    { url: `${ORIGIN}/remote.html` },
  );
  body = await (await sw.request("/playground/s1/php83/")).text();
  assert.doesNotMatch(body, /HTMLIFrameElement\.prototype/u);
});

test("static assets served by PHP are cached by policy and re-validated on read", async () => {
  let reply = { body: "body{}", headers: { "content-type": "text/css" } };
  const sw = await loadSw({ phpHandler: () => reply });
  const cssUrl = `${ORIGIN}/playground/s1/php83/core/css/app.css?v=2`;

  assert.equal(
    await (
      await sw.request("/playground/s1/php83/core/css/app.css?v=2")
    ).text(),
    "body{}",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const store = await sw.cacheStorage.open(ASSET_CACHE);
  assert.equal(store.entries.has(cssUrl), true);
  assert.equal(
    sw.broadcasts.at(-1).detail,
    "[sw-bridge] cache miss → worker: /core/css/app.css?v=2",
  );

  reply = { body: "changed", headers: { "content-type": "text/css" } };
  assert.equal(
    await (
      await sw.request("/playground/s1/php83/core/css/app.css?v=2")
    ).text(),
    "body{}",
  );
  assert.equal(sw.forwarded.length, 1);

  // An entry stored under an older policy (no-store) is bypassed on read.
  await store.put(
    `${ORIGIN}/playground/s1/php83/core/js/old.js`,
    new Response("stale", { headers: { "cache-control": "no-store" } }),
  );
  reply = {
    body: "fresh",
    headers: { "content-type": "text/javascript", "cache-control": "no-store" },
  };
  assert.equal(
    await (await sw.request("/playground/s1/php83/core/js/old.js")).text(),
    "fresh",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await store.entries
      .get(`${ORIGIN}/playground/s1/php83/core/js/old.js`)
      .text(),
    "stale",
  );

  // A PHP-routed preview needs an explicit max-age to be cached.
  reply = { body: "png", headers: { "content-type": "image/png" } };
  await sw.request("/playground/s1/php83/index.php/core/preview.png");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    store.entries.has(
      `${ORIGIN}/playground/s1/php83/index.php/core/preview.png`,
    ),
    false,
  );
});

test("bridge failures become HTML error responses", async () => {
  let reply = { kind: "http-error", error: "Fatal: out of memory" };
  const sw = await loadSw({ phpHandler: () => reply });
  let response = await sw.request("/playground/s1/php83/index.php");
  assert.equal(response.status, 500);
  assert.equal(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assert.match(await response.text(), /<pre>Fatal: out of memory<\/pre>/u);

  reply = { kind: "http-error" };
  response = await sw.request("/playground/s1/php83/index.php");
  assert.match(await response.text(), /Unknown PHP worker error\./u);

  reply = { kind: "http-error", error: "<script>x</script>&'\"" };
  response = await sw.request("/playground/s1/php83/index.php");
  assert.match(
    await response.text(),
    /&lt;script&gt;x&lt;\/script&gt;&amp;&#39;&quot;/u,
  );

  // Stray bridge messages (no id, unknown id) are ignored.
  for (const listener of sw.channels[0].listeners) {
    listener({ data: null });
    listener({ data: { id: "nope", kind: "http-response" } });
  }
});

test("the bridge times out with 504 when the PHP worker never answers", async () => {
  const sw = await loadSw({ phpHandler: () => undefined, fastTimeout: true });
  const response = await sw.request("/playground/s1/php83/index.php");
  assert.equal(response.status, 504);
  assert.match(await response.text(), /PHP worker bridge timed out\./u);
  const css = await sw.request("/playground/s1/php83/core/a.css");
  assert.equal(css.status, 504);
});

test("a bridge that cannot post the request yields a 500 with the error", async () => {
  const sw = await loadSw({ bridgeThrows: true });
  const response = await sw.request("/playground/s1/php83/index.php");
  assert.equal(response.status, 500);
  assert.match(await response.text(), /DataCloneError/u);
  const css = await sw.request("/playground/s1/php83/core/a.css");
  assert.equal(css.status, 500);
});

test("unscoped requests are attributed via referrer, client context or client URL", async () => {
  const sw = await loadSw({
    clients: {
      scoped: { url: `${ORIGIN}/playground/s2/php82/index.php` },
      plain: { url: `${ORIGIN}/index.html` },
      foreign: { url: "https://other.test/playground/s2/php82/" },
    },
  });

  // App shell files are always passed through.
  for (const path of [
    "/assets/app.js",
    "/remote.html",
    "/index.html",
    "/sw.js",
  ]) {
    await sw.request(path, { referrer: `${ORIGIN}/playground/s1/php83/` });
  }
  assert.equal(sw.forwarded.length, 0);
  assert.deepEqual(
    sw.fetchCalls.map((call) => new URL(call.url).pathname),
    ["/assets/app.js", "/remote.html", "/index.html", "/sw.js"],
  );

  await sw.request("/core/img/a.svg?x=1", {
    referrer: `${ORIGIN}/playground/s1/php83/index.php`,
  });
  assert.equal(sw.forwarded.at(-1).request.url, `${ORIGIN}/core/img/a.svg?x=1`);

  // A cross-origin or unscoped referrer does not count.
  await sw.request("/ocs/v2.php", {
    referrer: "https://other.test/playground/s1/php83/",
  });
  await sw.request("/ocs/v2.php", { referrer: `${ORIGIN}/somewhere` });
  assert.equal(sw.forwarded.length, 1);

  await sw.request("/ocs/v2.php", { clientId: "scoped" });
  assert.equal(sw.forwarded.at(-1).request.url, `${ORIGIN}/ocs/v2.php`);
  assert.equal(sw.channels.at(-1).name, "nextcloud-playground-php:s2");

  // A client seen on a scoped request keeps that scope afterwards.
  await sw.request("/playground/s3/php83/index.php", { clientId: "plain" });
  await sw.request("/apps/x/api", { clientId: "plain" });
  assert.equal(sw.channels.at(-1).name, "nextcloud-playground-php:s3");
  assert.equal(sw.forwarded.length, 4);

  const before = sw.fetchCalls.length;
  await sw.request("/apps/x/api", { clientId: "foreign" });
  await sw.request("/apps/x/api", { clientId: "missing" });
  await sw.request("/apps/x/api");
  assert.equal(sw.forwarded.length, 4);
  assert.equal(sw.fetchCalls.length, before + 3);
});

test("unscoped top-level navigations are redirected into the scope", async () => {
  const sw = await loadSw();
  const response = await sw.request("/index.php/apps/files?dir=/a", {
    mode: "navigate",
    referrer: `${ORIGIN}/playground/s1/php83/index.php`,
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `${ORIGIN}/playground/s1/php83/index.php/apps/files?dir=/a`,
  );
  assert.equal(sw.forwarded.length, 0);
});

test("a subpath deployment keeps the app base in every rewritten URL", async () => {
  const html = [
    '<html><head><script nonce="z">var _oc_webroot = "";</script>',
    '<a href="/index.php/apps/files">a</a><a href="/app/remote.html">b</a><a href="/app">c</a>',
    "</head></html>",
  ].join("");
  let reply = { body: html, headers: { "content-type": "text/html" } };
  const sw = await loadSw({
    scope: `${ORIGIN}/app/`,
    config: { addonProxyUrl: "https://proxy.test/p" },
    phpHandler: () => reply,
  });

  const body = await (
    await sw.request("/app/playground/s1/php83/index.php")
  ).text();
  assert.equal(sw.forwarded[0].request.url, `${ORIGIN}/index.php`);
  assert.match(body, /var _oc_webroot="\/app\/playground\/s1\/php83";/u);
  assert.match(
    body,
    /href="\/app\/playground\/s1\/php83\/index\.php\/apps\/files"/u,
  );
  assert.match(body, /href="\/app\/remote\.html"/u);
  assert.match(body, /href="\/app"/u);

  reply = {
    status: 302,
    body: "",
    headers: { location: "/app/index.php/login" },
  };
  const redirect = await sw.request("/app/playground/s1/php83/index.php");
  assert.equal(
    redirect.headers.get("location"),
    "/app/playground/s1/php83/index.php/login",
  );

  // Shell files under the base pass through; the bare base is the webroot.
  await sw.request("/app/index.html", {
    referrer: `${ORIGIN}/app/playground/s1/php83/`,
  });
  assert.equal(sw.forwarded.length, 2);
  await sw.request("/app", { referrer: `${ORIGIN}/app/playground/s1/php83/` });
  assert.equal(sw.forwarded.at(-1).request.url, `${ORIGIN}/`);
  await sw.request("/other/x", {
    referrer: `${ORIGIN}/app/playground/s1/php83/`,
  });
  assert.equal(sw.forwarded.at(-1).request.url, `${ORIGIN}/other/x`);

  const nav = await sw.request("/app/index.php/apps/files", {
    mode: "navigate",
    referrer: `${ORIGIN}/app/playground/s1/php83/`,
  });
  assert.equal(
    nav.headers.get("location"),
    `${ORIGIN}/app/playground/s1/php83/index.php/apps/files`,
  );

  // The dist cache and the internal proxy also honour the base path.
  sw.network.set("/app/dist/php.wasm", () => new Response("w"));
  assert.equal(await (await sw.request("/app/dist/php.wasm")).text(), "w");
  sw.network.set("/p", () => new Response("proxied"));
  assert.equal(
    await (await sw.request("/app/__playground_proxy__")).text(),
    "proxied",
  );

  // A scoped Nextcloud page cannot reconfigure; /app/remote.html can.
  sw.message(
    { kind: "configure-service-worker", addonProxyUrl: "https://proxy.test/o" },
    { url: `${ORIGIN}/app/playground/s1/php83/remote.html` },
  );
  assert.equal(
    await (await sw.request("/app/__playground_proxy__")).text(),
    "proxied",
  );
  sw.network.set("/o", () => new Response("override"));
  sw.message(
    { kind: "configure-service-worker", addonProxyUrl: "https://proxy.test/o" },
    { url: `${ORIGIN}/app/remote.html` },
  );
  assert.equal(
    await (await sw.request("/app/__playground_proxy__")).text(),
    "override",
  );
});

test("a scope without a trailing slash is the app base path", async () => {
  const sw = await loadSw({ scope: `${ORIGIN}/app` });
  await sw.request("/app/playground/s1/php83/index.php");
  assert.equal(sw.forwarded[0].request.url, `${ORIGIN}/index.php`);
});
