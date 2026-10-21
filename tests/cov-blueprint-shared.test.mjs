import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildDefaultBlueprint,
  clearActiveBlueprint,
  decodeBlueprintParam,
  encodeBlueprintParam,
  exportBlueprintPayload,
  loadActiveBlueprint,
  normalizeBlueprint,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
  saveActiveBlueprint,
} from "../src/shared/blueprint.js";
import { SNAPSHOT_VERSION } from "../src/shared/protocol.js";

const config = { siteTitle: "T", landingPath: "/index.php/login" };
const KEY = "nextcloud-playground:blueprint:s1";

function base64Url(text) {
  return Buffer.from(text).toString("base64url");
}

describe("blueprint storage without a window", () => {
  it("is a no-op and resolves to the default blueprint", async () => {
    saveActiveBlueprint("s1", { x: 1 });
    clearActiveBlueprint("s1");
    assert.equal(loadActiveBlueprint("s1"), null);
    assert.deepEqual(
      await resolveBlueprintForShell("s1", config),
      buildDefaultBlueprint(config),
    );
  });
});

describe("blueprint param codec fallbacks", () => {
  it("emits plain base64url when CompressionStream throws", async () => {
    const original = globalThis.CompressionStream;
    globalThis.CompressionStream = function Broken() {
      throw new Error("unsupported");
    };
    try {
      const big = {
        steps: Array.from({ length: 50 }, () => ({ step: "runOcc" })),
      };
      const encoded = await encodeBlueprintParam(big);
      assert.deepEqual(
        JSON.parse(Buffer.from(encoded, "base64url").toString()),
        big,
      );
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it("rejects gzip payloads when DecompressionStream is unavailable", async () => {
    const encoded = await encodeBlueprintParam({
      steps: Array.from({ length: 50 }, () => ({ step: "runOcc" })),
    });
    const original = globalThis.DecompressionStream;
    globalThis.DecompressionStream = undefined;
    try {
      await assert.rejects(decodeBlueprintParam(encoded), /not valid UTF-8/);
    } finally {
      globalThis.DecompressionStream = original;
    }
  });

  it("accepts whitespace and standard base64 padding", async () => {
    const b64 = Buffer.from('{"a":1}').toString("base64");
    assert.deepEqual(
      await decodeBlueprintParam(` ${b64.slice(0, 4)}\n${b64.slice(4)} `),
      {
        a: 1,
      },
    );
  });
});

describe("normalizeBlueprint field fallbacks", () => {
  it("keeps explicit values and normalizes the landing page", () => {
    const bp = normalizeBlueprint(
      {
        $schema: "https://x/schema.json",
        meta: { title: "M", author: "A", description: "D" },
        debug: { enabled: true },
        landingPath: "apps/files",
        siteOptions: { title: "S", locale: "es", timezone: "Atlantic/Canary" },
        admin: { username: "root", password: "pw", email: "r@x" },
        apps: ["text", "", null],
        steps: "not-an-array",
      },
      {},
    );
    assert.equal(bp.$schema, "https://x/schema.json");
    assert.deepEqual(bp.meta, { title: "M", author: "A", description: "D" });
    assert.equal(bp.debug.enabled, true);
    assert.equal(bp.landingPage, "/apps/files");
    assert.deepEqual(bp.siteOptions, {
      title: "S",
      locale: "es",
      timezone: "Atlantic/Canary",
    });
    assert.deepEqual(bp.admin, {
      username: "root",
      password: "pw",
      email: "r@x",
    });
    assert.deepEqual(bp.steps, [{ step: "enableApp", app: "text" }]);
  });

  it("falls back for arrays, non-string landing pages and nameless steps", () => {
    const bp = normalizeBlueprint(
      {
        landingPage: 42,
        steps: [{ step: "  " }, { type: "login", username: "a" }],
      },
      { landingPath: "" },
    );
    assert.equal(bp.landingPage, "/index.php/login");
    assert.deepEqual(bp.steps, [{ step: "login", username: "a" }]);
    assert.equal(
      normalizeBlueprint([], {}).meta.title,
      "Nextcloud Playground Blueprint",
    );
  });

  it("exports the normalized payload", () => {
    assert.deepEqual(
      exportBlueprintPayload(config, {}),
      normalizeBlueprint({}, config),
    );
  });
});

describe("parseImportedBlueprintPayload", () => {
  it("recognizes snapshot payloads and normalizes their path", () => {
    assert.deepEqual(
      parseImportedBlueprintPayload(
        { version: SNAPSHOT_VERSION, runtimeId: "r1", path: "apps/files" },
        config,
      ),
      { type: "snapshot", runtimeId: "r1", path: "/apps/files" },
    );
    assert.equal(
      parseImportedBlueprintPayload({ version: SNAPSHOT_VERSION }, {}).path,
      "/",
    );
  });

  it("treats anything else as a blueprint", () => {
    const result = parseImportedBlueprintPayload({ apps: ["text"] }, config);
    assert.equal(result.type, "blueprint");
    assert.deepEqual(result.blueprint.steps, [
      { step: "enableApp", app: "text" },
    ]);
  });
});

describe("resolveBlueprintForShell in a browser", () => {
  let store;
  let fetchCalls;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  let warnings;

  function setUrl(href) {
    globalThis.window.location.href = href;
  }
  function respondWith(body, status = 200) {
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    };
  }

  beforeEach(() => {
    store = new Map();
    fetchCalls = [];
    warnings = [];
    console.warn = (msg) => warnings.push(msg);
    globalThis.window = {
      location: { href: "https://play.example/" },
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
    };
  });
  afterEach(() => {
    delete globalThis.window;
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });

  it("saves, loads and clears the active blueprint in sessionStorage", () => {
    assert.equal(loadActiveBlueprint("s1"), null);
    saveActiveBlueprint("s1", { a: 1 });
    assert.equal(store.get(KEY), '{"a":1}');
    assert.deepEqual(loadActiveBlueprint("s1"), { a: 1 });
    clearActiveBlueprint("s1");
    assert.equal(store.has(KEY), false);
  });

  it("decodes an inline ?blueprint= payload and stores it", async () => {
    setUrl(`https://play.example/?blueprint=${base64Url('{"apps":["text"]}')}`);
    const bp = await resolveBlueprintForShell("s1", config);
    assert.deepEqual(bp.steps, [{ step: "enableApp", app: "text" }]);
    assert.deepEqual(JSON.parse(store.get(KEY)), bp);
    assert.equal(fetchCalls.length, 0);
  });

  it("fetches a ?blueprint= URL with no-store", async () => {
    respondWith({ siteOptions: { title: "Remote" } });
    setUrl("https://play.example/?blueprint=https://cdn.example/bp.json");
    const bp = await resolveBlueprintForShell("s1", config);
    assert.equal(bp.siteOptions.title, "Remote");
    assert.deepEqual(fetchCalls, [
      { url: "https://cdn.example/bp.json", init: { cache: "no-store" } },
    ]);
    assert.ok(store.has(KEY));
  });

  it("reports the HTTP status when a ?blueprint= URL fails", async () => {
    respondWith({}, 404);
    setUrl("https://play.example/?blueprint=http://cdn.example/bp.json");
    await assert.rejects(
      resolveBlueprintForShell("s1", config),
      /Unable to load blueprint from http:\/\/cdn\.example\/bp\.json: 404/,
    );
  });

  it("resolves ?blueprint-url= relative to the page", async () => {
    respondWith({ landingPage: "/apps/files" });
    setUrl("https://play.example/app/?blueprint-url=bps/demo.json");
    const bp = await resolveBlueprintForShell("s1", config);
    assert.equal(bp.landingPage, "/apps/files");
    assert.equal(fetchCalls[0].url, "https://play.example/app/bps/demo.json");
  });

  it("reports the HTTP status when ?blueprint-url= fails", async () => {
    respondWith({}, 500);
    setUrl("https://play.example/?blueprint-url=x.json");
    await assert.rejects(
      resolveBlueprintForShell("s1", config),
      /Unable to load blueprint from x\.json: 500/,
    );
  });

  it("accepts the deprecated ?blueprint-data= alias with a warning", async () => {
    setUrl(
      `https://play.example/?blueprint-data=${base64Url('{"apps":["a"]}')}`,
    );
    const bp = await resolveBlueprintForShell("s1", config);
    assert.deepEqual(bp.steps, [{ step: "enableApp", app: "a" }]);
    assert.match(warnings[0], /deprecated/);
  });

  it("loads config.defaultBlueprintUrl, or builds the default", async () => {
    respondWith({ siteOptions: { title: "Default remote" } });
    const remote = await resolveBlueprintForShell("s1", {
      ...config,
      defaultBlueprintUrl: "default.json",
    });
    assert.equal(remote.siteOptions.title, "Default remote");
    assert.equal(fetchCalls[0].url, "https://play.example/default.json");

    respondWith({}, 503);
    await assert.rejects(
      resolveBlueprintForShell("s1", {
        ...config,
        defaultBlueprintUrl: "d.json",
      }),
      /Unable to load default blueprint: 503/,
    );

    store.clear();
    const local = await resolveBlueprintForShell("s1", config);
    assert.deepEqual(local, buildDefaultBlueprint(config));
    assert.deepEqual(JSON.parse(store.get(KEY)), local);
  });
});
