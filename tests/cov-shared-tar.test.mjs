import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createDecodedTarStream,
  extractTarStreamToPhp,
  StreamingTarParser,
} from "../lib/streaming-tar-extract.js";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
  sanitizeArchivePath,
} from "../scripts/lib/tar-ustar.mjs";

const BLOCK = 512;
const enc = (s) => new TextEncoder().encode(s);

// zstd frame of createUstarTar([{ name: "a/hello.php", data: "<?php echo 1;" }]),
// embedded because Node 20 has no zstd compressor.
const ZSTD_TAR_B64 =
  "KLUv/WAAB7UCALQDYS9oZWxsby5waHAAMDAwMDY0NDAwMDAwMTUAADAwNzc3NQAgMAB1c3RhcgAwPD9waHAgZWNobyAxOwAJAO+BXyFAAfGG1ACQHGAArQY4Vi5TE0gC";

const originalDS = Object.getOwnPropertyDescriptor(
  globalThis,
  "DecompressionStream",
);
afterEach(() => {
  Object.defineProperty(globalThis, "DecompressionStream", originalDS);
});

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakePhp() {
  const mkdirs = [];
  const writes = new Map();
  return {
    mkdirs,
    writes,
    php: {
      _php: {
        mkdirTree: (d) => mkdirs.push(d),
        writeFile: (p, data) => writes.set(p, Buffer.from(data).toString()),
      },
    },
  };
}

describe("createDecodedTarStream", () => {
  it("decodes zstd through the bundled streaming decoder", async () => {
    const stream = await createDecodedTarStream(
      Buffer.from(ZSTD_TAR_B64, "base64"),
      "zstd",
    );
    const entries = readUstarTar(await readAll(stream));
    assert.deepEqual(
      entries.map((e) => [e.name, Buffer.from(e.data).toString()]),
      [["a/hello.php", "<?php echo 1;"]],
    );
  });

  it("uses zstddec when DecompressionStream is absent", async () => {
    Object.defineProperty(globalThis, "DecompressionStream", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const stream = await createDecodedTarStream(
      Buffer.from(ZSTD_TAR_B64, "base64"),
      "zstd",
    );
    assert.equal(readUstarTar(await readAll(stream)).length, 1);
  });

  it("maps br to the native brotli format name", async () => {
    const formats = [];
    Object.defineProperty(globalThis, "DecompressionStream", {
      // A native-shaped stub: records the format, passes bytes through.
      value: function FakeDecompressionStream(format) {
        formats.push(format);
        return new TransformStream();
      },
      configurable: true,
      writable: true,
    });
    const stream = await createDecodedTarStream(enc("raw"), "br");
    assert.deepEqual(formats, ["brotli"]);
    assert.equal((await readAll(stream)).toString(), "raw");
  });

  it("throws for a codec no decoder supports", async () => {
    await assert.rejects(
      createDecodedTarStream(enc("x"), "lzma"),
      /No streaming decoder available for codec "lzma"/,
    );
  });
});

describe("StreamingTarParser edge entries", () => {
  function header(name, { size = 0, type = "0", sizeField } = {}) {
    const h = Buffer.alloc(BLOCK);
    h.write(name, 0, 100, "utf8");
    h.write(sizeField ?? `${size.toString(8).padStart(11, "0")}\0`, 124, 12);
    h.write(type, 156, 1, "ascii");
    return h;
  }

  it("reads a space-padded octal size and skips non-regular entries", () => {
    const body = Buffer.alloc(BLOCK);
    body.write("hello");
    const tar = Buffer.concat([
      header("./", { type: "5" }), // empty after sanitization → skipped
      header("link", { type: "2" }), // symlink → ignored
      header("f.txt", { sizeField: "   5 \0\0\0\0\0\0\0" }),
      body,
      Buffer.alloc(BLOCK * 2),
    ]);
    const entries = [];
    const parser = new StreamingTarParser({ onEntry: (e) => entries.push(e) });
    parser.push(tar);
    const stats = parser.end();
    assert.deepEqual(
      entries.map((e) => [e.type, e.path, Buffer.from(e.data).toString()]),
      [["file", "f.txt", "hello"]],
    );
    assert.equal(stats.fileCount, 1);
    assert.equal(stats.dirCount, 0);
  });

  it("treats an all-space size field as an empty entry", () => {
    const entries = [];
    const parser = new StreamingTarParser({ onEntry: (e) => entries.push(e) });
    parser.push(
      Buffer.concat([
        header("empty.txt", { sizeField: "           \0" }),
        Buffer.alloc(BLOCK * 2),
      ]),
    );
    parser.end();
    assert.deepEqual(
      entries.map((e) => [e.path, e.data.length]),
      [["empty.txt", 0]],
    );
  });

  it("works without an onEntry callback and ignores empty pushes", () => {
    const parser = new StreamingTarParser();
    parser.push(undefined);
    parser.push(createUstarTar([{ type: "file", name: "x", data: "1" }]));
    assert.equal(parser.end().fileCount, 1);
  });
});

describe("extractTarStreamToPhp progress", () => {
  it("reports progress every 1000 files and writes under the root", async () => {
    const map = {};
    for (let i = 0; i < 1000; i += 1) map[`d/f${i}.txt`] = enc(String(i));
    const tar = createUstarTar(normalizeEntries(map));
    const { php, mkdirs, writes } = fakePhp();
    const progress = [];
    const stats = await extractTarStreamToPhp(streamOf(tar), php, "/www/", {
      onProgress: (p) => progress.push(p),
    });
    assert.equal(stats.fileCount, 1000);
    assert.deepEqual(progress, [
      { fileCount: 1000, bytes: stats.bytesWritten },
    ]);
    assert.equal(writes.get("/www/d/f999.txt"), "999");
    // The root and "/www/d" are created once each, not per file.
    assert.deepEqual(mkdirs, ["/www", "/www/d"]);
  });

  it("extracts top-level files into a filesystem-root target", async () => {
    const tar = createUstarTar([{ type: "file", name: "top.txt", data: "t" }]);
    const { php, mkdirs, writes } = fakePhp();
    await extractTarStreamToPhp(streamOf(tar), php, "/");
    assert.deepEqual(mkdirs, []);
    assert.equal(writes.get("/top.txt"), "t");
  });
});

describe("tar-ustar writer/reader edge cases", () => {
  it("returns null for a path with no segments", () => {
    assert.equal(sanitizeArchivePath("/./"), null);
  });

  it("drops empty names, encodes string data, and keeps duplicates stable", () => {
    const entries = normalizeEntries({ "/": enc(""), a: enc("1"), "./a": "2" });
    assert.deepEqual(
      entries.map((e) => e.name),
      ["a", "a"],
    );
    const read = readUstarTar(new Uint8Array(createUstarTar(entries)));
    assert.deepEqual(
      read.map((e) => Buffer.from(e.data).toString()),
      ["1", "2"],
    );
  });

  it("reads an empty size field as 0 and ignores exotic typeflags", () => {
    const tar = Buffer.from(
      createUstarTar([
        { type: "file", name: "sym", data: "" },
        { type: "file", name: "keep", data: "" },
      ]),
    );
    tar.fill(0, 124, 136); // blank the size field of the first header
    tar.write("2", 156, 1, "ascii"); // turn the first entry into a symlink
    assert.deepEqual(
      readUstarTar(tar).map((e) => e.name),
      ["keep"],
    );
  });
});
