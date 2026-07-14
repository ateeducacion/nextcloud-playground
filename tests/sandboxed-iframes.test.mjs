import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSandboxedIframeCompatibilityScript,
  consumeSandboxCompatibility,
  preserveSandboxCompatibilityRedirect,
  SANDBOX_COMPATIBILITY_PARAM,
} from "../src/shared/sandboxed-iframes.js";

describe("sandboxed iframe compatibility", () => {
  it("consumes the internal query parameter before forwarding to PHP", () => {
    const encoded = new URLSearchParams({
      channel: "abc",
      [SANDBOX_COMPATIBILITY_PARAM]: "1",
    });
    const result = consumeSandboxCompatibility(
      `/index.php/apps/viewer/frame?${encoded}`,
    );

    assert.equal(
      result.requestPath,
      "/index.php/apps/viewer/frame?channel=abc",
    );
    assert.equal(result.compatible, true);
  });

  it("distinguishes a compatibility request from a normal request", () => {
    assert.deepEqual(consumeSandboxCompatibility("/frame"), {
      requestPath: "/frame",
      compatible: false,
    });
  });

  it("preserves compatibility across same-origin redirects", () => {
    const response = preserveSandboxCompatibilityRedirect(
      Response.redirect("https://playground.test/scoped/login?next=files", 302),
      true,
      "https://playground.test",
    );
    const location = new URL(response.headers.get("location"));

    assert.equal(location.pathname, "/scoped/login");
    assert.equal(location.searchParams.get("next"), "files");
    assert.equal(location.searchParams.get(SANDBOX_COMPATIBILITY_PARAM), "1");
  });

  it("does not leak compatibility state to cross-origin redirects", () => {
    const original = Response.redirect("https://external.test/login", 302);
    const response = preserveSandboxCompatibilityRedirect(
      original,
      true,
      "https://playground.test",
    );

    assert.equal(
      response.headers.get("location"),
      "https://external.test/login",
    );
  });

  it("builds a scoped shim that only handles frames already granting same-origin", () => {
    const script = buildSandboxedIframeCompatibilityScript(
      "/playground/scope/php83-nc33",
    );

    assert.match(script, /MutationObserver/u);
    assert.match(script, /credentialless/u);
    assert.match(script, /allow-same-origin/u);
    assert.doesNotMatch(script, /setAttribute\("sandbox"/u);
    assert.match(script, /__playground_iframe/u);
    assert.match(script, /\/playground\/scope\/php83-nc33/u);
  });
});
