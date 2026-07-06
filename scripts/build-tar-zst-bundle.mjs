#!/usr/bin/env node
//
// build-tar-zst-bundle.mjs — pack a staged app tree into a deterministic,
// zstd-compressed tar (`.tar.zst`) that the browser runtime extracts by streaming
// (see lib/streaming-tar-extract.js). Replaces the old `zip -qr` bundle step.
//
// Deterministic USTAR + GNU longlink (never PAX — the streaming parser and PHP
// readers do not honor PAX 'path' headers). zstd level 19 + long-distance matching
// (windowLog 24) for strong cross-file dedup. Requires Node >= 22.15 (native
// node:zlib zstd); CI must run Node 24 LTS.
//
// Usage: node scripts/build-tar-zst-bundle.mjs <stageDir> <out.tar.zst>
// Prints JSON: { fileCount, dirCount, bytes, sha256, uncompressedBytes }

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import zlib from "node:zlib";
import { createUstarTar, normalizeEntries } from "./lib/tar-ustar.mjs";

if (typeof zlib.zstdCompressSync !== "function") {
  console.error(
    "Node >= 22.15 (native node:zlib zstd) is required to build tar.zst bundles.",
  );
  process.exit(1);
}

const [stageDir, outFile] = process.argv.slice(2);
if (!stageDir || !outFile) {
  console.error("Usage: build-tar-zst-bundle.mjs <stageDir> <out.tar.zst>");
  process.exit(1);
}

function walk(dir, base, map) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, map);
    else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join("/");
      map[rel] = readFileSync(abs);
    }
  }
}

const fileMap = {};
walk(stageDir, stageDir, fileMap);
const entries = normalizeEntries(fileMap);
// fileCount stays files-only for parity with the runtime tripwire
// (extractStats.fileCount in src/runtime/vfs.js), which counts files only and
// sends directory entries to dirCount. Preserved empty directories are reported
// separately as dirCount so the manifest file count is never inflated by them.
const fileCount = entries.reduce((n, e) => n + (e.type === "dir" ? 0 : 1), 0);
const dirCount = entries.length - fileCount;
const uncompressedBytes = entries.reduce(
  (n, e) => n + (e.type === "dir" ? 0 : e.data.length),
  0,
);
const tar = createUstarTar(entries, { mtime: 0 });
const compressed = zlib.zstdCompressSync(tar, {
  params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 19,
    [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
    // windowLog 24 (16 MiB), not 27 (128 MiB): measured on the moodle tree,
    // wlog 24 costs only +0.9% compressed size but shrinks the zstd decode
    // window 8× (128 → 16 MiB) that the zstddec WASM decoder allocates per
    // client at extraction time — the memory that matters most for a large
    // core like Nextcloud's.
    [zlib.constants.ZSTD_c_windowLog]: 24,
  },
});
writeFileSync(outFile, compressed);
console.log(
  JSON.stringify({
    fileCount,
    dirCount,
    bytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    uncompressedBytes,
  }),
);
