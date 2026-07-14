import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collapseAndHydrate,
  flushPendingOps,
  operationTouchesPathPrefix,
} from "../src/runtime/fs-persistence.js";

// Regression guard for the journal-flush OOM: a heavy install rewrites the same
// (multi-MB) SQLite DB hundreds of times within one debounce window. Hydrating
// the raw, un-collapsed op list read every write's content into memory at once →
// `RangeError: Array buffer allocation failed`. collapseAndHydrate must normalize
// FIRST (collapsing same-path writes) so each changed file is read exactly once.
test("collapseAndHydrate reads each changed file once, not once per write", async () => {
  const path = "/persist/data.sq3";
  const ops = Array.from({ length: 500 }, () => ({
    operation: "WRITE",
    path,
    nodeType: "file",
  }));

  const reads = new Map();
  const fakePhp = {
    readFileAsBuffer(p) {
      reads.set(p, (reads.get(p) || 0) + 1);
      return new Uint8Array(8);
    },
  };

  const hydrated = await collapseAndHydrate(fakePhp, ops);

  // 500 writes to one path collapse to a single WRITE op...
  const writes = hydrated.filter(
    (op) => op.operation === "WRITE" && op.path === path,
  );
  assert.equal(writes.length, 1);
  // ...and the file is read exactly once (the OOM guard), not 500 times.
  assert.equal(reads.get(path), 1);
});

test("operationTouchesPathPrefix matches direct paths and rename targets", () => {
  assert.equal(
    operationTouchesPathPrefix(
      { operation: "WRITE", path: "/www/nextcloud/data/a.txt" },
      "/www/nextcloud/data",
    ),
    true,
  );
  assert.equal(
    operationTouchesPathPrefix(
      {
        operation: "RENAME",
        path: "/tmp/a.txt",
        toPath: "/www/nextcloud/data/a.txt",
      },
      "/www/nextcloud/data",
    ),
    true,
  );
  assert.equal(
    operationTouchesPathPrefix(
      { operation: "WRITE", path: "/persist/mutable/session/sess_1" },
      "/www/nextcloud/data",
    ),
    false,
  );
});

test("flushPendingOps selectively flushes matching paths and leaves others queued", async () => {
  const pendingOps = [
    { operation: "WRITE", path: "/www/nextcloud/data/a.txt", nodeType: "file" },
    {
      operation: "WRITE",
      path: "/persist/mutable/session/sess_1",
      nodeType: "file",
    },
  ];
  let replaced = null;
  const fakePhp = {
    readFileAsBuffer(path) {
      return new TextEncoder().encode(path);
    },
  };

  const result = await flushPendingOps({
    rawPhp: fakePhp,
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async (ops) => {
      replaced = ops;
    },
    shouldFlush: (op) => operationTouchesPathPrefix(op, "/www/nextcloud/data"),
    getFileSize: () => 8,
  });

  assert.equal(result.ok, true);
  assert.equal(result.flushedOps, 1);
  assert.equal(pendingOps.length, 1);
  assert.equal(pendingOps[0].path, "/persist/mutable/session/sess_1");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].path, "/www/nextcloud/data/a.txt");
});

test("flushPendingOps rejects oversized checkpoints before reading files", async () => {
  const pendingOps = [
    {
      operation: "WRITE",
      path: "/www/nextcloud/data/big.bin",
      nodeType: "file",
    },
  ];
  let reads = 0;
  const fakePhp = {
    readFileAsBuffer() {
      reads += 1;
      return new Uint8Array(32);
    },
  };

  const result = await flushPendingOps({
    rawPhp: fakePhp,
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async () => {},
    maxBytes: 16,
    getFileSize: () => 32,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(result.estimatedBytes, 32);
  assert.equal(reads, 0);
  assert.equal(pendingOps.length, 1);
  assert.equal(pendingOps[0].path, "/www/nextcloud/data/big.bin");
});

test("flushPendingOps restores selected operations when persistence write fails", async () => {
  const pendingOps = [
    { operation: "WRITE", path: "/www/nextcloud/data/a.txt", nodeType: "file" },
    {
      operation: "WRITE",
      path: "/persist/mutable/session/sess_1",
      nodeType: "file",
    },
  ];
  const fakePhp = {
    readFileAsBuffer() {
      return new Uint8Array([1, 2, 3]);
    },
  };

  const result = await flushPendingOps({
    rawPhp: fakePhp,
    pendingOps,
    loadPersistedOps: async () => [],
    replacePersistedOps: async () => {
      throw new Error("indexeddb unavailable");
    },
    shouldFlush: (op) => operationTouchesPathPrefix(op, "/www/nextcloud/data"),
    getFileSize: () => 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "flush-failed");
  assert.equal(pendingOps.length, 2);
  assert.deepEqual(
    pendingOps.map((op) => op.path),
    ["/www/nextcloud/data/a.txt", "/persist/mutable/session/sess_1"],
  );
});
