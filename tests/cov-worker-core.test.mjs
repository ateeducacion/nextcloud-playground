import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import { buildManifestState, fetchManifest } from "../src/runtime/manifest.js";
import { createPlaygroundSpawnHandler } from "../src/runtime/spawn-handler.js";
import { mountReadonlyCore } from "../src/runtime/vfs.js";

const enc = (text) => new TextEncoder().encode(text);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function gzippedCore() {
  return new Uint8Array(
    gzipSync(
      createUstarTar(
        normalizeEntries({
          "index.php": enc("<?php echo 1;"),
          "lib/base.php": enc("<?php"),
        }),
      ),
    ),
  );
}

function fakePhp() {
  const writes = new Map();
  return {
    writes,
    _php: {
      mkdirTree() {},
      writeFile(path, data) {
        writes.set(path, new TextDecoder().decode(data));
      },
    },
  };
}

describe("mountReadonlyCore", () => {
  it("extracts prefetched core bytes under the root", async () => {
    const php = fakePhp();
    const published = [];
    const manifest = { bundle: { codec: "gzip", fileCount: 2 } };
    const result = await mountReadonlyCore(php, manifest, {
      root: "/www/nc",
      bytes: gzippedCore(),
      publish: (...args) => published.push(args),
    });
    assert.deepEqual(result, { manifest, entries: 2 });
    assert.equal(php.writes.get("/www/nc/index.php"), "<?php echo 1;");
    assert.equal(php.writes.get("/www/nc/lib/base.php"), "<?php");
    assert.deepEqual(published, [["Extracting Nextcloud core…", 0.45]]);
  });

  it("downloads the bundle with progress when no bytes were prefetched", async () => {
    const bytes = gzippedCore();
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return new Response(bytes);
    };
    const php = fakePhp();
    const published = [];
    const result = await mountReadonlyCore(
      php,
      {
        _manifestUrl: "https://example.test/assets/manifests/latest.json",
        bundle: { path: "../nextcloud/core.tar.gz", codec: "gzip" },
      },
      { publish: (...args) => published.push(args) },
    );
    assert.equal(result.entries, 2);
    assert.deepEqual(fetched, [
      "https://example.test/assets/nextcloud/core.tar.gz",
    ]);
    assert.ok(php.writes.has("/www/nextcloud/index.php"));
    assert.deepEqual(
      published.map(([detail]) => detail),
      ["Downloading Nextcloud bundle: 100%", "Extracting Nextcloud core…"],
    );
    assert.ok(Math.abs(published[0][1] - 0.45) < 1e-9);
  });

  it("downloads without a publisher", async () => {
    const bytes = gzippedCore();
    globalThis.fetch = async () => new Response(bytes);
    const result = await mountReadonlyCore(fakePhp(), {
      _manifestUrl: "https://example.test/m.json",
      bundle: { path: "core.tar.gz", codec: "gzip" },
    });
    assert.equal(result.entries, 2);
  });

  it("rejects a core whose file count does not match the manifest", async () => {
    await assert.rejects(
      mountReadonlyCore(
        fakePhp(),
        { bundle: { codec: "gzip", fileCount: 3 } },
        { bytes: gzippedCore() },
      ),
      /core tar file-count parity mismatch: 2 != 3/,
    );
  });
});

describe("fetchManifest", () => {
  it("loads the named manifest without the HTTP cache and records its URL", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ release: "33.0.0" });
    };
    const manifest = await fetchManifest("php83.json");
    assert.equal(manifest.release, "33.0.0");
    assert.match(calls[0].url, /\/assets\/manifests\/php83\.json$/);
    assert.deepEqual(calls[0].init, { cache: "no-cache" });
    assert.equal(manifest._manifestUrl, calls[0].url);

    await fetchManifest();
    assert.match(calls[1].url, /\/assets\/manifests\/latest\.json$/);
  });

  it("reports HTTP and network failures", async () => {
    globalThis.fetch = async () => new Response("", { status: 404 });
    await assert.rejects(
      fetchManifest(),
      /Unable to load Nextcloud manifest: 404/,
    );
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };
    await assert.rejects(
      fetchManifest(),
      /Network error while fetching manifest .*latest\.json\): Load failed/,
    );
  });

  it("builds the persisted manifest state", () => {
    const manifest = {
      release: "33.0.0",
      generatedAt: "2026-10-01",
      bundle: { sha256: "abc" },
    };
    assert.deepEqual(buildManifestState(manifest, "php83", "v1"), {
      runtimeId: "php83",
      bundleVersion: "v1",
      release: "33.0.0",
      sha256: "abc",
      generatedAt: "2026-10-01",
    });
    assert.equal(buildManifestState({}, "php83", "v1").sha256, null);
  });
});

describe("createPlaygroundSpawnHandler", () => {
  it("reports every command as unavailable with exit code 127", async () => {
    const spawn = createPlaygroundSpawnHandler();
    const child = spawn("which ffmpeg");
    const stdout = [];
    const stderr = [];
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 127);
    assert.equal(spawned, true);
    assert.equal(Buffer.concat(stdout).toString(), "");
    assert.equal(
      Buffer.concat(stderr).toString(),
      "command not available in the WebAssembly playground\n",
    );
  });

  it("still exits 127 when PHP-side stream listeners throw", async () => {
    const child = createPlaygroundSpawnHandler()(["convert", "a.png"]);
    const boom = () => {
      throw new Error("listener failed");
    };
    // Only our notifySpawn() emit may throw: createSpawnHandler emits "spawn"
    // again itself and would turn that into an exit(1).
    let spawnEmits = 0;
    child.on("spawn", () => {
      spawnEmits += 1;
      if (spawnEmits === 1) boom();
    });
    child.stdout.on("data", boom);
    child.stderr.on("data", boom);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 127);
  });
});
