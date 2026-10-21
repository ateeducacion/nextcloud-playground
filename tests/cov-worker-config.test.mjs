import assert from "node:assert/strict";
import { it } from "node:test";
import { makePhp, startWorker } from "./fixtures/cov-worker/harness.mjs";

// One worker instance shared by the tests below, in order (module state).
globalThis.__APP_ROOT__ = "https://cdn.test/app/";
const php = makePhp();
const env = await startWorker({
  query: "scope=old&runtime=old",
  configure: {
    kind: "configure-blueprint",
    blueprint: { landingPage: "/apps/files" },
    runtimeParams: {
      scopeId: "s2",
      runtimeId: "unknown",
      instanceId: null,
      opcacheParam: "1",
    },
  },
  stubs: {
    php: () => php,
    bootstrap: async (_options, calls) => {
      if (calls.length === 1) throw new Error("install failed");
      return {};
    },
  },
});

it("retries the boot after a bootstrap failure", async () => {
  const failed = await env.fetch({ url: "http://localhost/apps/files?t=1" });
  assert.equal(failed.status, 500);
  assert.match(failed.text, /install failed/);
  assert.equal(env.message("error", "install failed").path, "/apps/files");

  const ok = await env.fetch({ url: "http://localhost/" });
  assert.equal(ok.status, 200);
  assert.equal(env.createCalls.length, 2);
});

it("uses runtime params, the default runtime and the blueprint landing page", () => {
  assert.deepEqual(env.posted.at(-1), {
    kind: "worker-ready",
    scopeId: "s2",
    runtimeId: "unknown",
  });
  const { runtime, options } = env.createCalls[1];
  assert.equal(runtime.id, "php82");
  assert.equal(options.phpVersion, "8.2");
  assert.equal(options.appBaseUrl, "https://cdn.test/app/");
  assert.equal(options.opcache, true);
  assert.equal(options.forceCleanBoot, false);
  assert.equal(env.message("ready").path, "/apps/files");
  assert.equal(env.shell[0].channel, "nextcloud-playground-shell:s2");
});

it("reports PHP info and flush failures with escaped details", async () => {
  php.run = async () => {
    throw new Error("<b>no phpinfo</b>");
  };
  php.flushPersistence = async () => {
    throw new Error("journal locked");
  };

  env.selfMessage({ kind: "capture-phpinfo" });
  const info = await env.waitShell("phpinfo", "Failed to capture PHP info");
  assert.match(info.html, /&lt;b>no phpinfo&lt;\/b>/);
  assert.doesNotMatch(info.html, /<b>/);

  env.selfMessage({ kind: "flush-persistence" });
  const flushed = await env.waitShell("persistence-flushed");
  assert.match(flushed.detail, /^Persistence flush failed: .*journal locked/);
});

it("closes the previous bridge channel when reconfigured", () => {
  env.selfMessage({
    kind: "configure-blueprint",
    runtimeParams: { scopeId: "s3", runtimeId: "php82", instanceId: "x" },
  });
  assert.equal(env.channels[0].closed, true);
  assert.equal(env.channels[1].name, "nextcloud-playground-php:s3");
  assert.equal(env.posted.at(-1).scopeId, "s3");
});
