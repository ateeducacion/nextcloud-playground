import assert from "node:assert/strict";
import { it } from "node:test";
import {
  defaultConfig,
  fatal,
  startWorker,
  warmUp,
} from "./fixtures/cov-worker/harness.mjs";

// One worker instance shared by the tests below, in order (module state).
let configFailures = 1;
let crashNext = false;

const env = await startWorker({
  stubs: {
    loadConfig: async () => {
      if (configFailures > 0) {
        configFailures -= 1;
        throw new Error("config fetch failed");
      }
      return defaultConfig();
    },
    php: () => {
      const php = {
        refresh: async () => {},
        serveStatic: () => null,
        async request(request) {
          if (crashNext && request.url.includes("/crash")) {
            crashNext = false;
            throw fatal();
          }
          return new Response("ok");
        },
      };
      return php;
    },
  },
});

it("retries the boot after a step before bootstrapNextcloud() fails", async () => {
  const failed = await env.fetch({ url: "http://localhost/index.php" });
  assert.equal(failed.status, 500);
  assert.match(failed.text, /config fetch failed/);

  const booted = await env.fetch({ url: "http://localhost/index.php" });
  assert.equal(booted.status, 200);
  assert.equal(booted.text, "ok");
  assert.equal(env.createCalls.length, 1);
});

it("says the crash came too early, not that the restart limit was reached", async () => {
  crashNext = true;
  const response = await env.fetch({ url: "http://localhost/crash/early" });
  assert.equal(response.status, 500);
  assert.match(response.text, /Runtime crashed too early to restart/);
  assert.doesNotMatch(response.text, /restart limit reached/);
});

it("says the restart limit was reached once it really is", async () => {
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    await warmUp(env);
    crashNext = true;
    const replayed = await env.fetch({
      url: `http://localhost/crash/${cycle}`,
    });
    assert.equal(replayed.status, 200);
  }
  await warmUp(env);
  crashNext = true;
  const limited = await env.fetch({ url: "http://localhost/crash/limit" });
  assert.equal(limited.status, 500);
  assert.match(limited.text, /Runtime restart limit reached\./);
});
