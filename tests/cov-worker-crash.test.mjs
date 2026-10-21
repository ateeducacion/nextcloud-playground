import assert from "node:assert/strict";
import { it } from "node:test";
import {
  fatal,
  makePhp,
  startWorker,
  warmUp,
} from "./fixtures/cov-worker/harness.mjs";

// One worker instance shared by the tests below, in order: the restart
// counters are module state, so each step builds on the previous one.
let handler = async () => new Response("ok");
let hydrateThrows = false;
let failNextBoot = false;

const env = await startWorker({
  stubs: {
    php: (index) => {
      const php = makePhp((request) => handler(request, index));
      const raw = php._php;
      Object.defineProperty(php, "_php", {
        get() {
          if (hydrateThrows) throw new Error("heap gone");
          return raw;
        },
      });
      return php;
    },
    bootstrap: async () => {
      if (failNextBoot) {
        failNextBoot = false;
        throw new Error("recovery boot failed");
      }
      return {};
    },
  },
});

const restarts = () =>
  env.shell.filter((entry) => entry.title === "Runtime rotation").length;

it("does not restart a runtime that crashes before the minimum request count", async () => {
  handler = async () => {
    throw Object.assign(new Error("connect failed"), { errno: 23 });
  };
  const response = await env.fetch({
    url: "http://localhost/apps/weather?token=secret",
  });
  assert.equal(response.status, 500);
  assert.match(response.text, /Runtime crashed too early to restart/);

  const network = env.message("wasm-network-error");
  assert.equal(network.path, "/apps/weather");
  assert.doesNotMatch(network.detail, /secret/);
  assert.ok(env.message("trace", "[snapshot] saved DB (3 bytes)"));
  assert.ok(env.message("error", "crash after only 1 requests"));
  assert.equal(env.createCalls.length, 1);
  // Without a blueprint the ready path is the configured landing path.
  assert.equal(env.message("ready").path, "/index.php/apps/files");
});

it("reports a snapshot hydration failure and keeps handling the crash", async () => {
  hydrateThrows = true;
  handler = async () => {
    throw fatal("memory access out of bounds");
  };
  const response = await env.fetch({ url: "http://localhost/" });
  hydrateThrows = false;
  assert.equal(response.status, 500);
  assert.ok(
    env.message("error", "[runtime] snapshot hydration failed: heap gone"),
  );
  assert.equal(restarts(), 0);
});

it("replays an idempotent request on a fresh runtime and restores the snapshot", async () => {
  let crashed = false;
  handler = async (request, index) => {
    if (request.url.endsWith("/crash") && !crashed) {
      crashed = true;
      throw fatal();
    }
    return new Response(`runtime-${index}`);
  };
  await warmUp(env);
  const replayed = await env.fetch({ url: "http://localhost/crash" });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.text, "runtime-1");

  assert.equal(env.createCalls.length, 2);
  assert.ok(env.message("progress", "[runtime] restart (1/20)"));
  assert.ok(env.message("progress", "replaying request on fresh runtime"));
  assert.ok(
    env.message("trace", "[snapshot] restored state onto fresh runtime"),
  );
  assert.deepEqual(env.createCalls[1].php.restoredWrites, [
    "/www/nextcloud/data/owncloud.db",
  ]);
});

it("does not replay a non-idempotent request but boots a fresh runtime", async () => {
  let crashed = false;
  handler = async (request) => {
    if (request.method === "POST" && !crashed) {
      crashed = true;
      throw fatal();
    }
    return new Response("ok");
  };
  await warmUp(env);
  failNextBoot = true;
  const response = await env.fetch({
    url: "http://localhost/apps/files/upload",
    method: "POST",
    body: "file",
  });
  assert.equal(response.status, 503);
  assert.match(response.text, /Non-idempotent request was not retried/);
  const recovery = await env.waitShell("error", "Runtime recovery failed");
  assert.match(recovery.detail, /recovery boot failed/);
  assert.equal(env.createCalls.length, 3);

  // The failed recovery boot is retried by the next request.
  const next = await env.fetch({ url: "http://localhost/" });
  assert.equal(next.status, 200);
  assert.equal(env.createCalls.length, 4);
  assert.equal(restarts(), 2);
});

it("gives up when the replay crashes the fresh runtime again", async () => {
  handler = async () => new Response("ok");
  await warmUp(env);
  handler = async (request) => {
    if (request.url.endsWith("/crash")) throw fatal("unreachable again");
    return new Response("ok");
  };
  const response = await env.fetch({ url: "http://localhost/crash" });
  assert.equal(response.status, 503);
  assert.match(response.text, /Runtime crashed again on retry/);
  assert.match(response.text, /unreachable again/);
  assert.ok(env.message("error", "crash after only 0 requests"));
  assert.equal(restarts(), 3);
});

it("answers 503 when a non-fatal error interrupts the replay", async () => {
  handler = async () => new Response("ok");
  await warmUp(env);
  let crashed = false;
  handler = async (request) => {
    if (request.url.endsWith("/plain")) {
      if (crashed) throw new Error("plain failure");
      crashed = true;
      throw fatal();
    }
    return new Response("ok");
  };
  const errorsBefore = env.shell.filter((e) => e.kind === "error").length;
  const response = await env.fetch({ url: "http://localhost/plain" });
  assert.equal(response.status, 503);
  assert.match(response.text, /plain failure/);
  assert.equal(
    env.shell.filter((e) => e.kind === "error").length,
    errorsBefore,
  );
  assert.equal(restarts(), 4);
});

it("does not replay a request that already is a retry", async () => {
  handler = async (request) => {
    if (request.url.endsWith("/crash")) throw fatal();
    return new Response("ok");
  };
  await warmUp(env);
  const replays = env.shell.filter((e) => e.title === "Crash recovery").length;
  const response = await env.fetch(
    { url: "http://localhost/crash" },
    { _retried: true },
  );
  assert.equal(response.status, 503);
  assert.match(response.text, /Runtime crashed again on retry/);
  assert.equal(
    env.shell.filter((e) => e.title === "Crash recovery").length,
    replays,
  );
  assert.equal(restarts(), 5);
});

it("stops rotating the runtime after the reactive restart limit", async () => {
  const crashedUrls = new Set();
  handler = async (request) => {
    if (request.url.includes("/crash/") && !crashedUrls.has(request.url)) {
      crashedUrls.add(request.url);
      throw fatal();
    }
    return new Response("ok");
  };
  for (let cycle = restarts() + 1; cycle <= 20; cycle += 1) {
    await warmUp(env);
    const replayed = await env.fetch({
      url: `http://localhost/crash/${cycle}`,
    });
    assert.equal(replayed.status, 200);
  }
  assert.ok(env.message("progress", "[runtime] restart (20/20)"));

  await warmUp(env);
  const created = env.createCalls.length;
  const limited = await env.fetch({ url: "http://localhost/crash/21" });
  assert.equal(limited.status, 500);
  assert.match(limited.text, /Runtime restart limit reached\./);
  assert.ok(env.message("error", "restart limit reached (20/20)"));
  assert.equal(env.createCalls.length, created);
});
