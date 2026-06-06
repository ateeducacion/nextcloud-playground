import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScopedSitePath,
  getBasePathFromPathname,
  hasBlueprintUrlOverride,
  joinBasePath,
  resolveAppUrl,
  resolveConfiguredProxyUrl,
} from "../src/shared/paths.js";

function withWindow(windowLike, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: windowLike,
    configurable: true,
    writable: true,
  });

  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "window", original);
    } else {
      delete globalThis.window;
    }
  }
}

describe("shared path helpers", () => {
  it("derives the base path from a pathname", () => {
    assert.equal(getBasePathFromPathname("/"), "/");
    assert.equal(getBasePathFromPathname("/index.html"), "/");
    assert.equal(getBasePathFromPathname("/foo/index.html"), "/foo/");
    assert.equal(getBasePathFromPathname("/foo/bar/page.html"), "/foo/bar/");
  });

  it("joins base paths without duplicate slashes", () => {
    assert.equal(joinBasePath("/", "foo"), "/foo");
    assert.equal(joinBasePath("/playground/", "foo"), "/playground/foo");
    assert.equal(joinBasePath("/playground", "/foo"), "/playground/foo");
  });

  it("resolves app-relative urls against the current location", () => {
    const current = new URL("https://example.com/playground/index.html");
    const resolved = resolveAppUrl("dashboard", current);

    assert.equal(
      resolved.toString(),
      "https://example.com/playground/dashboard",
    );
  });

  it("resolves configured proxy urls on localhost", () => {
    const current = new URL("http://localhost:8085/playground/index.html");
    const resolved = resolveConfiguredProxyUrl(
      { proxyPath: "/proxy" },
      current,
    );

    assert.ok(resolved);
    assert.equal(resolved.toString(), "http://localhost:8085/playground/proxy");
  });

  it("prefers explicit proxy urls when present", () => {
    const current = new URL("https://example.com/playground/index.html");
    const resolved = resolveConfiguredProxyUrl(
      { proxyUrl: "https://proxy.example.com/service" },
      current,
    );

    assert.ok(resolved);
    assert.equal(resolved.toString(), "https://proxy.example.com/service");
  });

  it("detects blueprint overrides in the query string", () => {
    // ?blueprint= (inline base64/JSON or URL for backward compat)
    assert.equal(
      hasBlueprintUrlOverride(
        new URL("https://example.com/?blueprint=eyJmb28iOiJiYXIifQ"),
      ),
      true,
    );
    assert.equal(
      hasBlueprintUrlOverride(
        new URL("https://example.com/?blueprint=https%3A%2F%2Fexample.com%2Fa"),
      ),
      true,
    );
    // ?blueprint-url= (remote URL — explicit)
    assert.equal(
      hasBlueprintUrlOverride(
        new URL(
          "https://example.com/?blueprint-url=https%3A%2F%2Fexample.com%2Fb.json",
        ),
      ),
      true,
    );
    // ?blueprint-data= (legacy alias)
    assert.equal(
      hasBlueprintUrlOverride(
        new URL("https://example.com/?blueprint-data=eyJmb28iOiJiYXIifQ"),
      ),
      true,
    );
    // bare URL — no override
    assert.equal(
      hasBlueprintUrlOverride(new URL("https://example.com/")),
      false,
    );
  });

  it("builds scoped site paths from the app root", () => {
    withWindow({ location: { pathname: "/" } }, () => {
      assert.equal(
        buildScopedSitePath("scope-1", "php83", "/dashboard"),
        "/playground/scope-1/php83/dashboard",
      );
    });
  });
});
