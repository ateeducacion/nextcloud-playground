import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import worker from "../scripts/zip-proxy-worker.js";

// Edge cases on top of the suites ported from moodle-playground's canonical
// github-proxy-worker tests (cov-zip-proxy-generic / cov-zip-proxy-routes).

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const proxy = (target) =>
  worker.fetch(
    new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
    {},
  );

describe("zip-proxy-worker IPv6 and Drive edge cases", () => {
  it("rejects public IPv6 literals that are not allowlisted hosts", async () => {
    global.fetch = async () => {
      throw new Error("must not fetch");
    };

    // Plain public IPv6: not private, not IPv4-mapped, not allowlisted.
    const plain = await proxy("https://[2001:db8::1]/file.zip");
    assert.equal(plain.status, 400);
    assert.match((await plain.json()).error, /not a supported direct/);

    // ::ffff: prefix followed by more than two groups is not IPv4-mapped.
    const odd = await proxy("https://[::ffff:1:2:3]/file.zip");
    assert.equal(odd.status, 400);
  });

  it("proxies a Drive /uc link with an empty id unchanged", async () => {
    let upstream;
    global.fetch = async (url) => {
      upstream = String(url);
      return new Response(new Uint8Array([1]), { status: 200 });
    };

    const response = await proxy("https://drive.google.com/uc?id=");
    assert.equal(response.status, 200);
    // No file id to extract, so the URL is not rewritten to ?export=download.
    assert.equal(upstream, "https://drive.google.com/uc?id=");
    assert.equal(
      response.headers.get("Content-Type"),
      "application/octet-stream",
    );
  });
});
