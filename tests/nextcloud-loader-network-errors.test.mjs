import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchManifest, fetchWithProgress } from "../lib/nextcloud-loader.js";
import { fetchManifest as fetchRuntimeManifest } from "../src/runtime/manifest.js";

// WebKit reports a network-level fetch rejection as a bare "Load failed" and
// Firefox as "NetworkError when attempting to fetch resource" — no stack, no
// URL, no boot phase. The loader must re-throw something actionable.
const WEBKIT_MESSAGE = "Load failed";
const FIREFOX_MESSAGE = "NetworkError when attempting to fetch resource.";

let originalFetch;

function rejectFetchWith(message) {
  globalThis.fetch = async () => {
    throw new TypeError(message);
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("boot fetch failures are labelled", () => {
  it("names the phase and the query-less URL (WebKit 'Load failed')", async () => {
    rejectFetchWith(WEBKIT_MESSAGE);

    await assert.rejects(
      () =>
        fetchWithProgress(
          "https://example.test/assets/core.tar.zst?v=abc123",
          undefined,
          "core bundle",
        ),
      (error) => {
        assert.match(error.message, /core bundle/);
        assert.match(
          error.message,
          /https:\/\/example\.test\/assets\/core\.tar\.zst/,
        );
        // The cache-busting query string is stripped so Sentry groups the
        // report by asset instead of by build.
        assert.ok(!error.message.includes("v=abc123"), error.message);
        assert.match(error.message, /Load failed/);
        return true;
      },
    );
  });

  it("keeps the original failure as the cause (Firefox wording)", async () => {
    rejectFetchWith(FIREFOX_MESSAGE);

    await assert.rejects(
      () => fetchWithProgress("https://example.test/app.zip", undefined),
      (error) => {
        assert.equal(error.cause?.message, FIREFOX_MESSAGE);
        // Callers that pass no phase still get a stable label.
        assert.match(error.message, /asset/);
        return true;
      },
    );
  });

  it("labels a manifest fetch failure with the manifest phase", async () => {
    rejectFetchWith(WEBKIT_MESSAGE);

    await assert.rejects(
      () => fetchManifest("https://example.test/assets/manifests/latest.json"),
      (error) => {
        assert.match(error.message, /Network error while fetching manifest/);
        assert.match(error.message, /manifests\/latest\.json/);
        return true;
      },
    );
  });

  it("leaves HTTP-status failures alone (they already read well)", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });

    await assert.rejects(
      () => fetchManifest("https://example.test/assets/manifests/latest.json"),
      /Unable to load manifest: 503/,
    );
  });
});

// src/runtime/manifest.js is the manifest fetch the PHP worker actually performs
// at boot; the loader's own fetchManifest is the fallback path. Both must label
// the failure, or the bare "Load failed" is back for the path that matters most.
describe("runtime manifest fetch failures are labelled", () => {
  it("names the manifest phase and the asset URL", async () => {
    rejectFetchWith(WEBKIT_MESSAGE);

    await assert.rejects(
      () => fetchRuntimeManifest("nextcloud-33.json"),
      (error) => {
        assert.match(error.message, /Network error while fetching manifest/);
        assert.match(error.message, /assets\/manifests\/nextcloud-33\.json/);
        assert.match(error.message, /Load failed/);
        return true;
      },
    );
  });

  it("keeps the original network failure as the cause", async () => {
    rejectFetchWith(FIREFOX_MESSAGE);

    await assert.rejects(
      () => fetchRuntimeManifest(),
      (error) => {
        assert.equal(error.cause?.message, FIREFOX_MESSAGE);
        assert.match(error.message, /latest\.json/);
        return true;
      },
    );
  });

  it("leaves HTTP-status failures alone", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 404 });

    await assert.rejects(
      () => fetchRuntimeManifest(),
      /Unable to load Nextcloud manifest: 404/,
    );
  });
});
