import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
} from "../scripts/lib/tar-ustar.mjs";

const enc = (s) => new TextEncoder().encode(s);

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
