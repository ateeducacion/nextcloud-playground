import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
} from "../scripts/lib/tar-ustar.mjs";

const enc = (s) => new TextEncoder().encode(s);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("tar-ustar writer/reader round-trip", () => {
  it("createUstarTar → readUstarTar preserves names and bytes", () => {
    // Cover all three name-encoding paths the writer picks between:
    //  - short name (fits the 100-byte USTAR `name` field)
    //  - long name with a valid prefix/name split (>100 bytes, has a "/")
    //  - long single-segment name (>100 bytes, no "/") → GNU `././@LongLink`
    const prefixSplitName = `${"p".repeat(120)}/short.txt`;
    const longLinkName = `${"z".repeat(150)}.txt`;
    const fileMap = {
      "a.txt": enc("alpha"),
      "dir/b.bin": new Uint8Array([0, 1, 2, 3, 255]),
      [prefixSplitName]: enc("prefixed"),
      [longLinkName]: enc("gnu-longlink-body"),
    };

    const entries = normalizeEntries(fileMap);
    const tar = createUstarTar(entries, { mtime: 0 });
    const read = readUstarTar(tar);

    assert.equal(read.length, entries.length);
    const readByName = new Map(read.map((e) => [e.name, Buffer.from(e.data)]));
    for (const entry of entries) {
      assert.ok(readByName.has(entry.name), `missing entry ${entry.name}`);
      assert.deepEqual(readByName.get(entry.name), Buffer.from(entry.data));
    }
  });

  it("produces byte-identical output for identical input (deterministic)", () => {
    const fileMap = { "b.txt": enc("two"), "a.txt": enc("one") };
    const first = createUstarTar(normalizeEntries(fileMap), { mtime: 0 });
    const second = createUstarTar(normalizeEntries(fileMap), { mtime: 0 });
    assert.deepEqual(first, second);
  });
});

describe("tar-ustar empty directory preservation", () => {
  // A genuinely-empty directory in the source tree still ships as an explicit
  // trailing-slash member in the ZIP/stage listing. The files-only tar writer
  // used to drop every directory member, so such semantically-meaningful empty
  // directories vanished from the extracted filesystem — the streaming
  // extractor only recreates a directory from the parent path of each FILE it
  // writes, so a directory that holds no file was never created. They are now
  // preserved as typeflag-5 entries, while directories implied by a file (any
  // ancestor of a kept file) stay dropped to avoid redundant members.

  it("preserves an explicit empty directory (no file descendant)", () => {
    const entries = normalizeEntries({
      "emptydir/": enc(""),
      "mod/pkg/version.php": enc("<?php"),
    });
    const dir = entries.find((e) => e.name === "emptydir");
    assert.ok(dir, "empty directory must be preserved");
    assert.equal(dir.type, "dir");
    // Directories implied by a file are NOT emitted as redundant members —
    // the streaming extractor reconstructs them from each file's parent path.
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "mod"));
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "mod/pkg"));
  });

  it("drops populated directory members that a file recreates (real fflate shape)", () => {
    // fflate's unzipSync() yields an EXPLICIT trailing-slash member for EVERY
    // directory, including populated ones — this is the real input shape fed to
    // normalizeEntries. Only the truly empty `keepme/` must survive; `a/` and
    // `a/b/` are recreated by their file and MUST be dropped (invariant: no
    // redundant directory members, else dirCount and the sha256 drift). Guards
    // the impliedDirs dedup, which the empty-only maps above never exercise.
    const entries = normalizeEntries({
      "a/": enc(""),
      "a/b/": enc(""),
      "a/b/f.txt": enc("hello"),
      "keepme/": enc(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["keepme"]);
  });

  it("preserves a nested empty directory but not those implied by files", () => {
    const entries = normalizeEntries({
      "pkg/one/config.php": enc("<?php"),
      "pkg/one/lang/en/strings.php": enc("<?php"),
      "pkg/one/widgets/": enc(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["pkg/one/widgets"]);
  });

  it("emits a USTAR directory header (typeflag 5, size 0) that round-trips", () => {
    const tar = createUstarTar(
      normalizeEntries({ "emptydir/": enc(""), "a.txt": enc("a") }),
      { mtime: 0 },
    );
    const back = readUstarTar(tar);
    const dir = back.find((e) => e.name === "emptydir");
    assert.ok(dir, "directory entry should round-trip via the reader");
    assert.equal(dir.type, "dir");
    assert.equal(dir.data, undefined);
    // Files still round-trip alongside directories.
    const file = back.find((e) => e.name === "a.txt");
    assert.ok(file && Buffer.from(file.data).equals(Buffer.from(enc("a"))));
  });

  it("does not count directories as files", () => {
    const entries = normalizeEntries({
      "emptydir/": enc(""),
      "a.txt": enc("a"),
      "b.txt": enc("b"),
    });
    assert.equal(entries.filter((e) => e.type !== "dir").length, 2);
    assert.equal(entries.filter((e) => e.type === "dir").length, 1);
  });

  it("skips unsafe directory paths (path traversal)", () => {
    const entries = normalizeEntries({
      "../evil/": enc(""),
      "nested/../../evil/": enc(""),
      "ok/": enc(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["ok"]);
  });

  it("is deterministic with directory entries (stable sha256 across two builds)", () => {
    const map = {
      "emptydir/": enc(""),
      "admin/tool/": enc(""),
      "mod/pkg/version.php": enc("<?php"),
      "z.txt": enc("z"),
    };
    const a = createUstarTar(normalizeEntries(map), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(map), { mtime: 0 });
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    assert.equal(sha256(a), sha256(b));
    assert.equal(a.length % 512, 0);
  });
});
