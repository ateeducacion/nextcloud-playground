import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildEvent,
  captureException,
  captureMessage,
  createMonitoringClient,
  initMonitoring,
  parseStackFrames,
} from "../src/shared/monitoring.js";

const DSN = "https://abc123@o111.ingest.de.sentry.io/222";

// Temporarily replace a global (location, navigator, crypto) for one test.
const restorers = [];
function setGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  restorers.push(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  });
}
afterEach(() => {
  while (restorers.length) restorers.pop()();
});

function recordingClient(options = {}) {
  const bodies = [];
  const client = initMonitoring({
    dsn: DSN,
    environment: "test",
    fetchImpl: (_url, init) => {
      bodies.push(JSON.parse(init.body.trimEnd().split("\n")[2]));
      return Promise.resolve();
    },
    scope: { addEventListener() {} },
    ...options,
  });
  return { client, bodies };
}

describe("parseStackFrames limits", () => {
  it("keeps at most 50 frames", () => {
    const stack = Array.from(
      { length: 80 },
      (_, i) => `at fn${i} (https://x.test/a.js:${i + 1}:1)`,
    ).join("\n");
    const frames = parseStackFrames(stack);
    assert.equal(frames.length, 50);
    // Reversed: newest parsed frame (fn49) comes last.
    assert.equal(frames[0].function, "fn49");
    assert.equal(frames[49].function, "fn0");
  });
});

describe("buildEvent context", () => {
  it("generates a 32-hex event id without crypto.randomUUID", () => {
    setGlobal("crypto", {});
    const event = buildEvent({ message: "hi", environment: "x" });
    assert.match(event.event_id, /^[0-9a-f]{32}$/);
  });

  it("detects development hosts and attaches the page URL and user agent", () => {
    for (const hostname of ["localhost", "127.0.0.1", "box.local"]) {
      setGlobal("location", {
        hostname,
        href: `http://${hostname}/index.html`,
      });
      setGlobal("navigator", { userAgent: "UA/1" });
      const event = buildEvent({ message: "m" });
      assert.equal(event.environment, "development", hostname);
      assert.deepEqual(event.request, {
        url: `http://${hostname}/index.html`,
        headers: { "User-Agent": "UA/1" },
      });
    }
  });

  it("treats other hosts as production and omits a missing user agent", () => {
    setGlobal("location", {
      hostname: "playground.example.org",
      href: "https://playground.example.org/",
    });
    setGlobal("navigator", {});
    const event = buildEvent({ message: "m" });
    assert.equal(event.environment, "production");
    assert.deepEqual(event.request, { url: "https://playground.example.org/" });
  });

  it("falls back to Error type and String(error) for bare objects", () => {
    const event = buildEvent({ error: { toString: () => "boom" } });
    assert.equal(event.exception.values[0].type, "Error");
    assert.equal(event.exception.values[0].value, "boom");
    assert.equal(event.exception.values[0].stacktrace, undefined);
  });
});

describe("monitoring client resilience", () => {
  it("is disabled when no fetch implementation exists", () => {
    const client = createMonitoringClient({ dsn: DSN, fetchImpl: null });
    assert.equal(client.enabled, false);
  });

  it("swallows a synchronous fetch throw and a non-promise result", () => {
    let calls = 0;
    const client = createMonitoringClient({
      dsn: DSN,
      fetchImpl: () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return undefined;
      },
    });
    client.captureMessage("first");
    client.captureMessage("second");
    assert.equal(calls, 2);
  });

  it("never throws when the captured value cannot be stringified", () => {
    const sent = [];
    const client = createMonitoringClient({
      dsn: DSN,
      fetchImpl: (...args) => sent.push(args),
    });
    const hostile = {
      toString() {
        throw new Error("no string");
      },
    };
    assert.doesNotThrow(() => client.captureException(hostile));
    assert.doesNotThrow(() => client.captureMessage(hostile));
    assert.equal(sent.length, 0);
  });
});

describe("module-level capture helpers", () => {
  it("route through the active client and the window error handlers", () => {
    const listeners = {};
    const { bodies } = recordingClient({
      scope: {
        addEventListener: (type, fn) => {
          listeners[type] = fn;
        },
      },
    });

    captureException(new Error("explicit"), { where: "test" });
    captureMessage("note", "warning");
    listeners.error({ message: "Script error." });
    listeners.error({});
    listeners.unhandledrejection({});

    assert.deepEqual(
      bodies.map((e) => [
        e.level,
        e.exception?.values[0].value ?? e.message.formatted,
      ]),
      [
        ["error", "explicit"],
        ["warning", "note"],
        ["error", "Script error."],
        ["error", "Unhandled rejection"],
      ],
    );
    assert.deepEqual(bodies[0].extra, { where: "test" });
    assert.deepEqual(bodies[2].extra, { source: "window.onerror" });
    assert.deepEqual(bodies[3].extra, { source: "unhandledrejection" });
  });

  it("defaults captureMessage to info level", () => {
    const { bodies } = recordingClient();
    captureMessage("plain");
    assert.equal(bodies[0].level, "info");
  });

  it("deduplicates empty messages under one signature", () => {
    const { bodies } = recordingClient();
    captureMessage("");
    captureMessage("");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].message.formatted, "");
  });

  it("defaults the listener scope to globalThis", () => {
    const added = [];
    setGlobal("addEventListener", (type) => added.push(type));
    initMonitoring({ dsn: DSN, fetchImpl: () => Promise.resolve() });
    assert.deepEqual(added, ["error", "unhandledrejection"]);
  });

  it("installs no handlers when the scope cannot listen", () => {
    const client = initMonitoring({
      dsn: DSN,
      fetchImpl: () => Promise.resolve(),
      scope: {},
    });
    assert.equal(client.enabled, true);
  });
});
