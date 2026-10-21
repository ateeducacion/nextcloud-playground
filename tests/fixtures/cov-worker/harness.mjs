import assert from "node:assert/strict";
import { register } from "node:module";

// Shared harness for tests/cov-worker-*.test.mjs. php-worker.js gets stubbed
// config/bootstrap/php-loader modules (see hooks.mjs) driven through
// globalThis.__workerStubs, so its request queue, static fast-path and crash
// recovery run for real without PHP WASM.
register("./hooks.mjs", import.meta.url);

const decoder = new TextDecoder();

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function until(predicate, label) {
  for (let i = 0; i < 20000; i += 1) {
    const value = predicate();
    if (value) return value;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function defaultConfig() {
  return {
    runtimes: [
      { id: "php82", label: "PHP 8.2", phpVersion: "8.2" },
      { id: "php83", label: "PHP 8.3", phpVersionLabel: "8.3" },
    ],
    landingPath: "/index.php/apps/files",
    phpCorsProxyUrl: "https://proxy.test/",
    opcache: true,
  };
}

export function fatal(message = "RuntimeError: unreachable") {
  return new Error(message);
}

/**
 * Fake booted PHP runtime. `handle(request, php)` answers queued requests.
 */
export function makePhp(handle = async () => new Response("ok")) {
  const php = {
    requests: [],
    restoredWrites: [],
    refresh: async () => {},
    async request(request) {
      php.requests.push(request);
      return handle(request, php);
    },
    serveStatic: () => null,
    run: async () => ({ text: "<h1>info</h1>" }),
    flushPersistence: async () => ({
      enabled: true,
      ok: true,
      flushedOps: 1,
      hydratedBytes: 2048,
    }),
    _php: {
      readFileAsBuffer: () => new Uint8Array([1, 2, 3]),
      writeFile: (path) => php.restoredWrites.push(path),
    },
  };
  return php;
}

export async function startWorker({
  query = "scope=s1&runtime=php83",
  stubs = {},
  configure = { kind: "configure-blueprint" },
} = {}) {
  const shell = [];
  const responses = new Map();
  const posted = [];
  const channels = [];
  const createCalls = [];
  const bootstrapCalls = [];
  const bridgeFailures = { count: 0 };
  let bridge = null;
  let phpFactory = stubs.php || (() => makePhp());

  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      this.closed = false;
      if (name.startsWith("nextcloud-playground-php:")) {
        bridge = this;
        channels.push(this);
      }
    }
    postMessage(message) {
      if (this.name.startsWith("nextcloud-playground-php:")) {
        if (bridgeFailures.count > 0) {
          bridgeFailures.count -= 1;
          throw new Error("bridge down");
        }
        responses.set(message.id, message);
        return;
      }
      shell.push({ channel: this.name, ...message });
    }
    close() {
      this.closed = true;
    }
  };

  globalThis.__workerStubs = {
    loadConfig: stubs.loadConfig || (async () => defaultConfig()),
    prefetch:
      stubs.prefetch ||
      ((options) => {
        options.onProgress({ ratio: 0.5 });
        options.onProgress({});
        return Promise.resolve({ bytes: "core" });
      }),
    bootstrap: async (options) => {
      bootstrapCalls.push(options);
      if (stubs.bootstrap) return stubs.bootstrap(options, bootstrapCalls);
      return { readyPath: "/index.php/apps/dashboard" };
    },
    createPhp: (runtime, options) => {
      const php = phpFactory(createCalls.length);
      createCalls.push({ runtime, options, php });
      return php;
    },
  };

  const self = new EventTarget();
  self.location = new URL(`https://example.test/php-worker.js?${query}`);
  self.postMessage = (message) => posted.push(message);
  if (stubs.selfAddEventListener) {
    self.addEventListener = stubs.selfAddEventListener;
  }
  globalThis.self = self;

  // One worker instance per test process: a query-string import would give
  // each instance its own coverage entry instead of merging into php-worker.js.
  const imported = import("../../../php-worker.js");
  if (stubs.selfAddEventListener) {
    return { imported, posted };
  }
  await imported;
  if (configure) {
    self.dispatchEvent(new MessageEvent("message", { data: configure }));
  }

  let requestSeq = 0;
  const env = {
    self,
    shell,
    posted,
    channels,
    createCalls,
    bootstrapCalls,
    bridgeFailures,
    setPhpFactory(factory) {
      phpFactory = factory;
    },
    dispatch(data) {
      bridge.dispatchEvent(new MessageEvent("message", { data }));
    },
    send(request, extra = {}) {
      requestSeq += 1;
      const id = `req-${requestSeq}`;
      env.dispatch({
        kind: "http-request",
        id,
        request: { method: "GET", headers: {}, ...request },
        ...extra,
      });
      return id;
    },
    async response(id) {
      const message = await until(() => responses.get(id), id);
      return {
        ...message.response,
        text: decoder.decode(message.response.body),
      };
    },
    async fetch(request, extra) {
      return env.response(env.send(request, extra));
    },
    hasResponse: (id) => responses.has(id),
    message(kind, includes = "") {
      return shell.find(
        (entry) =>
          entry.kind === kind &&
          String(entry.detail ?? entry.message ?? "").includes(includes),
      );
    },
    waitShell(kind, includes) {
      return until(() => env.message(kind, includes), `${kind} ${includes}`);
    },
    selfMessage(data) {
      self.dispatchEvent(new MessageEvent("message", { data }));
    },
  };
  return env;
}

export async function warmUp(env, count = 10) {
  for (let i = 0; i < count; i += 1) {
    const response = await env.fetch({ url: `http://localhost/warm/${i}` });
    assert.equal(response.status, 200);
  }
}
