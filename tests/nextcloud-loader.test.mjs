import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import {
  detectArchiveKind,
  extractTarGzEntries,
  sanitizeArchivePath,
} from "../lib/nextcloud-loader.js";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";

describe("sanitizeArchivePath", () => {
  it("rejects ZIP-slip entries containing '..'", () => {
    assert.equal(sanitizeArchivePath("../evil.php"), null);
    assert.equal(sanitizeArchivePath("a/../../evil"), null);
  });

  it("strips leading slashes and '.' segments, normalizes backslashes", () => {
    assert.equal(sanitizeArchivePath("/index.php"), "index.php");
    assert.equal(
      sanitizeArchivePath("./nextcloud/lib/base.php"),
      "nextcloud/lib/base.php",
    );
    assert.equal(
      sanitizeArchivePath("nextcloud\\lib\\base.php"),
      "nextcloud/lib/base.php",
    );
  });

  it("returns null for empty / root-only paths", () => {
    assert.equal(sanitizeArchivePath(""), null);
    assert.equal(sanitizeArchivePath("/"), null);
  });
});

describe("detectArchiveKind", () => {
  it("detects ZIP magic bytes (local file header and empty-archive EOCD)", () => {
    assert.equal(
      detectArchiveKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
      "zip",
    );
    assert.equal(
      detectArchiveKind(new Uint8Array([0x50, 0x4b, 0x05, 0x06])),
      "zip",
    );
  });

  it("detects gzip magic bytes", () => {
    assert.equal(
      detectArchiveKind(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])),
      "gzip",
    );
  });

  it("returns unknown for anything else", () => {
    assert.equal(detectArchiveKind(new Uint8Array([0, 1, 2, 3])), "unknown");
    assert.equal(detectArchiveKind(new Uint8Array()), "unknown");
  });
});

describe("extractTarGzEntries", () => {
  const enc = (s) => new TextEncoder().encode(s);

  function gzipTar(fileMap) {
    const tar = createUstarTar(normalizeEntries(fileMap));
    return new Uint8Array(zlib.gzipSync(Buffer.from(tar)));
  }

  it("extracts files from a Nextcloud-style tar.gz (single wrapper folder stripped)", async () => {
    const bytes = gzipTar({
      "epubviewer/appinfo/info.xml": enc("<info/>"),
      "epubviewer/js/main.js": enc("console.log(1)"),
    });
    const entries = await extractTarGzEntries(bytes);
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ["appinfo/info.xml", "js/main.js"]);
    const info = entries.find((e) => e.path === "appinfo/info.xml");
    assert.equal(Buffer.from(info.data).toString(), "<info/>");
  });

  it("keeps full paths when there is no single common leading folder", async () => {
    const bytes = gzipTar({
      "foo/a.txt": enc("a"),
      "bar/b.txt": enc("b"),
    });
    const entries = await extractTarGzEntries(bytes);
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ["bar/b.txt", "foo/a.txt"]);
  });
});
