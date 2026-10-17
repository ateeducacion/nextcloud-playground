import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  isOpcacheEnabled,
  loadPlaygroundConfig,
  opcacheUrlParam,
} from "../src/shared/config.js";

const originalFetch = globalThis.fetch;

describe("isOpcacheEnabled", () => {
  it("defaults to the config flag when no URL parameter is present", () => {
    assert.equal(isOpcacheEnabled(null, {}), false);
    assert.equal(isOpcacheEnabled(null, { opcache: false }), false);
    assert.equal(isOpcacheEnabled(undefined, { opcache: true }), true);
    assert.equal(isOpcacheEnabled("", { opcache: true }), true);
    // Only a boolean true enables it from config.
    assert.equal(isOpcacheEnabled(null, { opcache: "1" }), false);
  });

  it("lets the URL parameter override the config", () => {
    for (const on of ["1", "true", "on", "yes", "anything"]) {
      assert.equal(isOpcacheEnabled(on, { opcache: false }), true, on);
    }
    for (const off of ["0", "false", "off", "no", "FALSE", "Off"]) {
      assert.equal(isOpcacheEnabled(off, { opcache: true }), false, off);
    }
  });
});

describe("opcacheUrlParam", () => {
  it("round-trips through isOpcacheEnabled and omits the parameter at the config default", () => {
    for (const config of [{}, { opcache: false }, { opcache: true }]) {
      for (const enabled of [true, false]) {
        const param = opcacheUrlParam(enabled, config);
        assert.equal(isOpcacheEnabled(param, config), enabled);
        assert.equal(param === null, enabled === (config.opcache === true));
      }
    }
  });
});

describe("loadPlaygroundConfig", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 503 });
      }
      return Response.json({ runtimes: [] });
    };

    await assert.rejects(loadPlaygroundConfig(), /503/u);
    assert.deepStrictEqual(await loadPlaygroundConfig(), { runtimes: [] });
    assert.deepStrictEqual(await loadPlaygroundConfig(), { runtimes: [] });
    assert.strictEqual(calls, 2);
  });
});
