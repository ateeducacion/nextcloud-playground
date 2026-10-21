import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import {
  detectArchiveKind,
  extractTarGzEntries,
  extractZipEntries,
  fetchBundleWithCache,
  fetchManifest,
  fetchWithProgress,
  resolveBootstrapArchive,
  sanitizeArchivePath,
  writeEntriesToPhp,
} from "../lib/nextcloud-loader.js";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MANIFEST_URL = "https://example.test/assets/manifests/latest.json";
const BUNDLE_URL = "https://example.test/assets/nextcloud/core.tar.zst";

let originalFetch;
let originalCaches;
let fetched;
let responses;
let store;
let cacheOps;

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function installCache({ failPut = false } = {}) {
  store = new Map();
  cacheOps = [];
  globalThis.caches = {
    open: async () => ({
      async match(url) {
        cacheOps.push(["match", url]);
        const bytes = store.get(url);
        return bytes ? new Response(bytes) : undefined;
      },
      async put(url, response) {
        cacheOps.push(["put", url]);
        if (failPut) throw new Error("quota");
        store.set(url, new Uint8Array(await response.arrayBuffer()));
      },
      async delete(url) {
        cacheOps.push(["delete", url]);
        return store.delete(url);
      },
    }),
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCaches = globalThis.caches;
  fetched = [];
  responses = new Map();
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), init });
    const make = responses.get(String(url));
    return make ? make() : new Response("missing", { status: 404 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCaches === undefined) delete globalThis.caches;
  else globalThis.caches = originalCaches;
});

describe("fetchWithProgress", () => {
  it("streams chunks and reports monotonic progress against content-length", async () => {
    const url = "https://example.test/a.bin";
    responses.set(
      url,
      () =>
        new Response(streamOf([enc("abc"), enc("defg")]), {
          headers: { "content-length": "7" },
        }),
    );
    const events = [];
    const bytes = await fetchWithProgress(url, (e) => events.push(e));
    assert.equal(dec(bytes), "abcdefg");
    assert.deepEqual(
      events.map((e) => [e.loaded, e.total]),
      [
        [3, 7],
        [7, 7],
      ],
    );
    assert.equal(events.at(-1).ratio, 1);
  });

  it("caps the ratio at 1 when the body exceeds content-length", async () => {
    const url = "https://example.test/b.bin";
    responses.set(
      url,
      () =>
        new Response(streamOf([enc("12345")]), {
          headers: { "content-length": "2" },
        }),
    );
    const events = [];
    await fetchWithProgress(url, (e) => events.push(e));
    assert.equal(events[0].ratio, 1);
  });

  it("buffers the whole body when no content-length is sent", async () => {
    const url = "https://example.test/c.bin";
    responses.set(url, () => new Response(enc("hello")));
    const events = [];
    const bytes = await fetchWithProgress(url, (e) => events.push(e));
    assert.equal(dec(bytes), "hello");
    assert.deepEqual(events, [{ loaded: 5, total: 5, ratio: 1 }]);
  });

  it("works without a progress callback", async () => {
    const url = "https://example.test/d.bin";
    responses.set(
      url,
      () =>
        new Response(streamOf([enc("xy")]), {
          headers: { "content-length": "2" },
        }),
    );
    assert.equal(dec(await fetchWithProgress(url)), "xy");
    responses.set(url, () => new Response(enc("z")));
    assert.equal(dec(await fetchWithProgress(url)), "z");
  });

  it("rejects non-OK responses with the URL and status", async () => {
    await assert.rejects(
      () => fetchWithProgress("https://example.test/none"),
      /Failed to fetch https:\/\/example\.test\/none: 404/,
    );
  });
});

describe("fetchManifest", () => {
  it("parses the JSON, records its URL and bypasses the HTTP cache", async () => {
    responses.set(MANIFEST_URL, () => Response.json({ release: "33.0.0" }));
    const manifest = await fetchManifest(MANIFEST_URL);
    assert.equal(manifest.release, "33.0.0");
    assert.equal(manifest._manifestUrl, MANIFEST_URL);
    assert.deepEqual(fetched[0].init, { cache: "no-cache" });
  });

  it("defaults to assets/manifests/latest.json", async () => {
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return Response.json({});
    };
    const manifest = await fetchManifest();
    assert.match(fetched[0], /assets\/manifests\/latest\.json$/);
    assert.equal(manifest._manifestUrl, fetched[0]);
  });
});

describe("fetchBundleWithCache (single bundle)", () => {
  const body = enc("core-bundle-bytes");
  const manifest = (extra = {}) => ({
    _manifestUrl: MANIFEST_URL,
    bundle: { path: "../nextcloud/core.tar.zst", ...extra },
  });

  it("throws when the manifest has no bundle path", async () => {
    installCache();
    await assert.rejects(
      () => fetchBundleWithCache({ _manifestUrl: MANIFEST_URL, bundle: {} }),
      /does not describe a bundle/,
    );
  });

  it("downloads, verifies and caches the bundle, then serves it from cache", async () => {
    installCache();
    responses.set(BUNDLE_URL, () => new Response(body));
    const first = await fetchBundleWithCache(
      manifest({ sha256: sha256Hex(body) }),
    );
    assert.equal(dec(first), dec(body));
    assert.equal(fetched.length, 1);
    assert.ok(store.has(BUNDLE_URL));

    const events = [];
    const second = await fetchBundleWithCache(
      manifest({ sha256: sha256Hex(body) }),
      (e) => events.push(e),
    );
    assert.equal(dec(second), dec(body));
    assert.equal(fetched.length, 1, "second call must not hit the network");
    assert.deepEqual(events, [
      { loaded: body.length, total: body.length, ratio: 1 },
    ]);
  });

  it("serves an unverified cached bundle when the manifest has no sha256", async () => {
    installCache();
    store.set(BUNDLE_URL, enc("cached"));
    const events = [];
    const bytes = await fetchBundleWithCache(manifest(), (e) => events.push(e));
    assert.equal(dec(bytes), "cached");
    assert.equal(fetched.length, 0);
    assert.equal(events[0].ratio, 1);
  });

  it("discards a stale cached bundle whose hash no longer matches", async () => {
    installCache();
    store.set(BUNDLE_URL, enc("stale"));
    responses.set(BUNDLE_URL, () => new Response(body));
    const bytes = await fetchBundleWithCache(
      manifest({ sha256: sha256Hex(body) }),
    );
    assert.equal(dec(bytes), dec(body));
    assert.ok(cacheOps.some(([op]) => op === "delete"));
    assert.equal(dec(store.get(BUNDLE_URL)), dec(body));
  });

  it("rejects a downloaded bundle with the wrong hash and does not cache it", async () => {
    installCache();
    responses.set(BUNDLE_URL, () => new Response(body));
    await assert.rejects(
      () => fetchBundleWithCache(manifest({ sha256: "00".repeat(32) })),
      /Bundle SHA-256 mismatch/,
    );
    assert.equal(store.has(BUNDLE_URL), false);
  });

  it("falls back to the network when the Cache API is unavailable", async () => {
    globalThis.caches = {
      open: async () => {
        throw new Error("opaque origin");
      },
    };
    responses.set(BUNDLE_URL, () => new Response(body));
    assert.equal(dec(await fetchBundleWithCache(manifest())), dec(body));
  });

  it("treats a failing cache.put as best-effort", async () => {
    installCache({ failPut: true });
    responses.set(BUNDLE_URL, () => new Response(body));
    assert.equal(dec(await fetchBundleWithCache(manifest())), dec(body));
    assert.ok(cacheOps.some(([op]) => op === "put"));
  });
});

describe("fetchBundleWithCache (parts edge cases)", () => {
  const partUrl = (i) => `https://example.test/assets/core.part-${i}`;
  const makeManifest = (parts, sha256) => ({
    _manifestUrl: MANIFEST_URL,
    bundle: {
      sha256,
      parts: parts.map((bytes, i) => ({
        path: `../core.part-${i}`,
        size: bytes.length,
        sha256: sha256Hex(bytes),
      })),
    },
  });

  it("reassembles bodiless part responses without the Cache API", async () => {
    globalThis.caches = {
      open: async () => {
        throw new Error("no cache");
      },
    };
    const parts = [enc("aaa"), enc("bb")];
    // A Response whose body getter is null forces the arrayBuffer() path.
    parts.forEach((bytes, i) => {
      responses.set(partUrl(i), () => ({
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => bytes.slice().buffer,
      }));
    });
    const events = [];
    const full = await fetchBundleWithCache(makeManifest(parts), (e) =>
      events.push(e),
    );
    assert.equal(dec(full), "aaabb");
    assert.equal(events.at(-1).ratio, 1);
    assert.equal(events.at(-1).loaded, 5);
  });

  it("re-downloads a cached part with a bad hash and replaces it", async () => {
    installCache();
    const parts = [enc("one"), enc("two")];
    store.set(partUrl(0), enc("bad"));
    parts.forEach((bytes, i) => {
      responses.set(partUrl(i), () => new Response(bytes));
    });
    const full = await fetchBundleWithCache(makeManifest(parts));
    assert.equal(dec(full), "onetwo");
    assert.ok(
      cacheOps.some(([op, url]) => op === "delete" && url === partUrl(0)),
    );
    assert.equal(dec(store.get(partUrl(0))), "one");
  });

  it("accepts a cached part with no recorded hash", async () => {
    installCache();
    store.set(partUrl(0), enc("xyz"));
    const manifest = {
      _manifestUrl: MANIFEST_URL,
      bundle: { parts: [{ path: "../core.part-0", size: 3 }] },
    };
    assert.equal(dec(await fetchBundleWithCache(manifest)), "xyz");
    assert.equal(fetched.length, 0);
  });

  it("rejects a part whose size differs from the manifest", async () => {
    installCache();
    responses.set(partUrl(0), () => new Response(enc("short")));
    const manifest = {
      _manifestUrl: MANIFEST_URL,
      bundle: { parts: [{ path: "../core.part-0", size: 99 }] },
    };
    await assert.rejects(
      () => fetchBundleWithCache(manifest),
      /Bundle part size mismatch .*expected 99, got 5/,
    );
  });

  it("rejects a failed part download", async () => {
    installCache();
    const manifest = {
      _manifestUrl: MANIFEST_URL,
      bundle: { parts: [{ path: "../core.part-0", size: 1 }] },
    };
    await assert.rejects(() => fetchBundleWithCache(manifest), /: 404/);
  });

  it("rejects when the reassembled bundle hash mismatches", async () => {
    installCache({ failPut: true });
    const parts = [enc("p0")];
    responses.set(partUrl(0), () => new Response(parts[0]));
    await assert.rejects(
      () => fetchBundleWithCache(makeManifest(parts, "ff".repeat(32))),
      /^Error: Bundle SHA-256 mismatch/,
    );
  });

  it("cannot reassemble parts that omit their size (zero-length buffer)", async () => {
    installCache();
    responses.set(partUrl(0), () => new Response(enc("q")));
    const manifest = {
      _manifestUrl: MANIFEST_URL,
      bundle: { parts: [{ path: "../core.part-0" }] },
    };
    const events = [];
    // Missing size → total 0 → the preallocated buffer is empty and the
    // first write overflows it.
    await assert.rejects(
      () => fetchBundleWithCache(manifest, (e) => events.push(e)),
      RangeError,
    );
    assert.ok(events.every((e) => e.ratio === 0));
  });
});

describe("resolveBootstrapArchive", () => {
  it("reuses a provided manifest without refetching it", async () => {
    installCache();
    store.set(BUNDLE_URL, enc("b"));
    const manifest = {
      _manifestUrl: MANIFEST_URL,
      bundle: { path: "../nextcloud/core.tar.zst" },
    };
    const result = await resolveBootstrapArchive({ manifest });
    assert.equal(result.manifest, manifest);
    assert.equal(dec(result.bytes), "b");
    assert.equal(fetched.length, 0);
  });

  it("fetches the manifest when none is provided", async () => {
    installCache();
    responses.set(MANIFEST_URL, () =>
      Response.json({ bundle: { path: "../nextcloud/core.tar.zst" } }),
    );
    responses.set(BUNDLE_URL, () => new Response(enc("net")));
    const result = await resolveBootstrapArchive({ manifestUrl: MANIFEST_URL });
    assert.equal(result.manifest._manifestUrl, MANIFEST_URL);
    assert.equal(dec(result.bytes), "net");
  });
});

describe("sanitizeArchivePath", () => {
  it("normalizes separators and rejects traversal or empty paths", () => {
    assert.equal(sanitizeArchivePath("\\a\\.\\b//c"), "a/b/c");
    assert.equal(sanitizeArchivePath("a/../../evil"), null);
    assert.equal(sanitizeArchivePath("/./"), null);
  });
});

describe("extractZipEntries", () => {
  it("strips a common leading folder and skips directories and traversal", () => {
    const zip = zipSync({
      "app/": new Uint8Array(0),
      "app/appinfo/info.xml": enc("<info/>"),
      "app/lib/../../evil.php": enc("x"),
      "app/lib/A.php": enc("<?php"),
    });
    const entries = extractZipEntries(zip);
    assert.deepEqual(entries.map((e) => e.path).sort(), [
      "appinfo/info.xml",
      "lib/A.php",
    ]);
    const info = entries.find((e) => e.path === "appinfo/info.xml");
    assert.equal(dec(info.data), "<info/>");
  });

  it("keeps paths intact when entries do not share a folder", () => {
    const zip = zipSync({ "a/x.txt": enc("1"), "b.txt": enc("2") });
    assert.deepEqual(
      extractZipEntries(zip)
        .map((e) => e.path)
        .sort(),
      ["a/x.txt", "b.txt"],
    );
    const flat = zipSync({ "only.txt": enc("1") });
    assert.deepEqual(
      extractZipEntries(flat).map((e) => e.path),
      ["only.txt"],
    );
  });

  it("returns nothing for an empty archive", () => {
    assert.deepEqual(extractZipEntries(zipSync({})), []);
  });
});

describe("detectArchiveKind", () => {
  it("recognises zip, gzip and unknown magic bytes", () => {
    assert.equal(detectArchiveKind(new Uint8Array([0x50, 0x4b, 3, 4])), "zip");
    assert.equal(detectArchiveKind(new Uint8Array([0x50, 0x4b, 5, 6])), "zip");
    assert.equal(detectArchiveKind(new Uint8Array([0x50, 0x4b, 7, 8])), "zip");
    assert.equal(
      detectArchiveKind(new Uint8Array([0x50, 0x4b, 9, 9])),
      "unknown",
    );
    assert.equal(detectArchiveKind(new Uint8Array([0x1f, 0x8b])), "gzip");
    assert.equal(detectArchiveKind(new Uint8Array([0x1f])), "unknown");
    assert.equal(detectArchiveKind(new Uint8Array([])), "unknown");
  });
});

describe("extractTarGzEntries", () => {
  it("returns files with the shared leading folder stripped", async () => {
    const tar = createUstarTar(
      normalizeEntries({
        "myapp/appinfo/info.xml": enc("<info/>"),
        "myapp/lib/A.php": enc("<?php"),
      }),
    );
    const entries = await extractTarGzEntries(gzipSync(tar));
    assert.deepEqual(entries.map((e) => e.path).sort(), [
      "appinfo/info.xml",
      "lib/A.php",
    ]);
    assert.equal(
      dec(entries.find((e) => e.path === "lib/A.php").data),
      "<?php",
    );
  });

  it("keeps paths when there is no shared folder", async () => {
    const tar = createUstarTar(
      normalizeEntries({ "a/x.txt": enc("1"), "b.txt": enc("2") }),
    );
    const paths = (await extractTarGzEntries(gzipSync(tar)))
      .map((e) => e.path)
      .sort();
    assert.deepEqual(paths, ["a/x.txt", "b.txt"]);
    const flat = createUstarTar(normalizeEntries({ "c.txt": enc("3") }));
    assert.deepEqual(
      (await extractTarGzEntries(gzipSync(flat))).map((e) => e.path),
      ["c.txt"],
    );
  });

  it("returns nothing for an empty tar", async () => {
    assert.deepEqual(
      await extractTarGzEntries(gzipSync(new Uint8Array(1024))),
      [],
    );
  });
});

function fakeFs({ failWrite } = {}) {
  const dirs = new Set(["/"]);
  const files = new Map();
  return {
    dirs,
    files,
    analyzePath: (p) => ({ exists: dirs.has(p) || files.has(p) }),
    mkdir(p) {
      if (p === "/boom") throw new Error("EEXIST");
      dirs.add(p);
    },
    writeFile(p, data) {
      if (failWrite?.(p)) throw new Error("ENOMEM");
      files.set(p, data);
    },
  };
}

describe("writeEntriesToPhp", () => {
  it("creates parent directories, writes files and reports progress", () => {
    const FS = fakeFs();
    const events = [];
    writeEntriesToPhp(
      { FS },
      [
        { path: "a/b.txt", data: enc("1") },
        { path: "c.txt", data: enc("2") },
      ],
      "/www/apps/x/",
      (e) => events.push(e),
    );
    assert.ok(FS.dirs.has("/www/apps/x/a"));
    assert.equal(dec(FS.files.get("/www/apps/x/a/b.txt")), "1");
    assert.equal(dec(FS.files.get("/www/apps/x/c.txt")), "2");
    assert.deepEqual(
      events.map((e) => [e.index, e.ratio]),
      [
        [0, 0.5],
        [1, 1],
      ],
    );
  });

  it("uses php.binary.FS and tolerates mkdir races", () => {
    const FS = fakeFs();
    writeEntriesToPhp(
      { binary: { FS } },
      [{ path: "f", data: enc("") }],
      "/boom",
    );
    assert.ok(FS.files.has("/boom/f"));
  });

  it("aggregates write failures into one error", () => {
    const FS = fakeFs({ failWrite: (p) => p.endsWith(".bad") });
    assert.throws(
      () =>
        writeEntriesToPhp(
          { FS },
          [
            { path: "ok.txt", data: enc("") },
            { path: "x.bad", data: enc("") },
          ],
          "/t",
        ),
      /Failed to write 1 of 2 entries to \/t .*x\.bad: ENOMEM/,
    );
    assert.ok(FS.files.has("/t/ok.txt"));
  });

  it("caps the failure list at ten and marks it with a plus", () => {
    const FS = fakeFs({ failWrite: () => true });
    const entries = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}`,
      data: enc(""),
    }));
    assert.throws(
      () => writeEntriesToPhp({ FS }, entries, "/t"),
      /Failed to write 10\+ of 12 entries/,
    );
  });
});
