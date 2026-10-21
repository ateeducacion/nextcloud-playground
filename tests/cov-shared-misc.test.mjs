import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
} from "../src/shared/blueprint.js";
import {
  getDefaultRuntime,
  buildEffectivePlaygroundConfig as wrappedEffective,
  normalizeBlueprint as wrappedNormalize,
} from "../src/shared/config.js";
import {
  buildScopedSitePath,
  getBasePathFromPathname,
  hasBlueprintUrlOverride,
  resolveAppUrl,
  resolveRemoteUrl,
} from "../src/shared/paths.js";
import {
  createShellChannel,
  createWorkerRequestId,
  formatErrorDetail,
} from "../src/shared/protocol.js";
import {
  buildSandboxedIframeCompatibilityScript,
  consumeSandboxCompatibility,
  preserveSandboxCompatibilityRedirect,
} from "../src/shared/sandboxed-iframes.js";
import { acquireScopeOwnership } from "../src/shared/scope-ownership.js";
import { loadSessionState } from "../src/shared/storage.js";
import { isCacheableAssetResponse } from "../src/shared/sw-asset-cache.js";
import {
  createBlueprintValidationResult,
  highlightJson,
} from "../src/shell/blueprint-editor-core.js";

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

describe("config helpers", () => {
  it("picks the default runtime, else the first one", () => {
    const a = { id: "a" };
    const b = { id: "b", default: true };
    assert.equal(getDefaultRuntime({ runtimes: [a, b] }), b);
    assert.equal(getDefaultRuntime({ runtimes: [a, { id: "c" }] }), a);
  });

  it("re-exports the blueprint normalizers unchanged", () => {
    const config = { runtimes: [{ id: "r", default: true }] };
    const input = { steps: [{ step: "login" }] };
    assert.deepEqual(
      wrappedNormalize(input, config),
      normalizeBlueprint(input, config),
    );
    const blueprint = normalizeBlueprint(input, config);
    assert.deepEqual(
      wrappedEffective(config, blueprint),
      buildEffectivePlaygroundConfig(config, blueprint),
    );
  });
});

describe("paths in a window context", () => {
  it("builds the remote URL next to the current page", () => {
    setGlobal("window", {
      location: { href: "https://x.test/sub/index.html", pathname: "/sub/" },
    });
    const url = resolveRemoteUrl("s1", "r1", "/apps/files");
    assert.equal(url.origin + url.pathname, "https://x.test/sub/remote.html");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      scope: "s1",
      runtime: "r1",
      path: "/apps/files",
    });
    assert.equal(resolveRemoteUrl("s", "r").searchParams.get("path"), "/");
    assert.equal(
      buildScopedSitePath("s", "r", "index.php"),
      "/playground/s/r/index.php",
    );
  });

  it("reads blueprint overrides from strings and the current window URL", () => {
    setGlobal("window", {
      location: { href: "https://x.test/?blueprint-data=e30" },
    });
    assert.equal(hasBlueprintUrlOverride(), true);
    assert.equal(hasBlueprintUrlOverride("?blueprint-url=x"), true);
    assert.equal(hasBlueprintUrlOverride(""), true); // falls back to window URL
    assert.equal(hasBlueprintUrlOverride("/plain"), false);
  });

  it("resolves app URLs against the current location", () => {
    setGlobal("location", { href: "https://x.test/app/index.html" });
    assert.equal(resolveAppUrl("").href, "https://x.test/app/index.html");
    assert.equal(resolveAppUrl("/a/b").href, "https://x.test/app/a/b");
    assert.equal(
      resolveAppUrl("https://other.test/z").href,
      "https://other.test/z",
    );
    assert.equal(
      resolveAppUrl("c", new URL("https://y.test/root/page")).href,
      "https://y.test/root/c",
    );
  });

  it("defaults to localhost when no location exists", () => {
    setGlobal("location", undefined);
    assert.equal(resolveAppUrl(null).href, "http://localhost/");
    assert.equal(getBasePathFromPathname(), "/");
    assert.equal(getBasePathFromPathname(""), "/");
  });
});

describe("protocol helpers", () => {
  it("names the shell channel with and without an instance", () => {
    assert.equal(createShellChannel("s"), "nextcloud-playground-shell:s");
    assert.equal(
      createShellChannel("s", "i"),
      "nextcloud-playground-shell:s:i",
    );
  });

  it("creates unique UUID request ids", () => {
    const a = createWorkerRequestId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, createWorkerRequestId());
  });

  it("falls back to String() for values JSON cannot serialize", () => {
    const circular = {};
    circular.self = circular;
    assert.equal(formatErrorDetail(circular), "[object Object]");
  });
});

describe("sandboxed iframe helpers", () => {
  it("treats a missing request path as the root", () => {
    assert.deepEqual(consumeSandboxCompatibility(undefined), {
      requestPath: "/",
      compatible: false,
    });
  });

  it("keeps the response when not compatible or redirected cross-origin", () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "/x" },
    });
    assert.equal(
      preserveSandboxCompatibilityRedirect(redirect, false, "https://a.test"),
      redirect,
    );
    const away = new Response(null, {
      status: 302,
      headers: { location: "https://evil.test/x" },
    });
    assert.equal(
      preserveSandboxCompatibilityRedirect(away, true, "https://a.test"),
      away,
    );
  });

  it("marks absolute same-origin redirects, defaulting the origin", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: "https://playground.invalid/p?q=1#h" },
    });
    const out = preserveSandboxCompatibilityRedirect(response, true);
    assert.equal(
      out.headers.get("location"),
      "https://playground.invalid/p?q=1&__playground_iframe=1#h",
    );
    assert.equal(out.status, 302);
  });

  it("keeps relative same-origin redirects relative", () => {
    const response = new Response(null, {
      status: 303,
      headers: { location: "/next?x=1" },
    });
    const out = preserveSandboxCompatibilityRedirect(
      response,
      true,
      "https://a.test",
    );
    assert.equal(
      out.headers.get("location"),
      "/next?x=1&__playground_iframe=1",
    );
  });

  it("embeds the root base path when none is given", () => {
    assert.match(buildSandboxedIframeCompatibilityScript(), /var b="\/"/);
  });
});

describe("scope ownership without Web Locks", () => {
  it("rejects when navigator.locks is unavailable", async () => {
    setGlobal("navigator", {});
    await assert.rejects(acquireScopeOwnership("s"), /Web Locks are required/);
  });
});

describe("session state", () => {
  it("returns null when nothing is stored", () => {
    setGlobal("window", { sessionStorage: { getItem: () => null } });
    assert.equal(loadSessionState("s"), null);
  });
});

describe("asset cache headers", () => {
  it("caches a typeless static response and rejects no-cache", () => {
    assert.equal(
      isCacheableAssetResponse(
        "/a.js",
        new Response(new Uint8Array([1]), { status: 200 }),
      ),
      true,
    );
    assert.equal(
      isCacheableAssetResponse(
        "/a.js",
        new Response("x", { headers: { "cache-control": "No-Cache" } }),
      ),
      false,
    );
  });
});

describe("blueprint editor core edge cases", () => {
  it("highlights nothing for non-string input", () => {
    assert.equal(highlightJson(undefined), "");
  });

  it("rejects non-string input as empty", () => {
    const result = createBlueprintValidationResult(null, {
      normalizeBlueprint: () => ({}),
    });
    assert.equal(result.valid, false);
    assert.equal(result.message, "Blueprint cannot be empty.");
  });

  it("pluralizes the step count", () => {
    const message = (blueprint) =>
      createBlueprintValidationResult("{}", {
        normalizeBlueprint: () => blueprint,
      }).message;
    assert.equal(message({ steps: [{}] }), "✓ Valid blueprint · 1 step");
    assert.equal(message({}), "✓ Valid blueprint · 0 steps");
    assert.equal(message(null), "✓ Valid blueprint · 0 steps");
  });
});
