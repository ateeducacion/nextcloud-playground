import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEXTCLOUD_DATA_DIR,
  PLAYGROUND_DB_PATH,
} from "../src/runtime/bootstrap-paths.js";
import { createSnapshotManager } from "../src/runtime/crash-recovery.js";

const DEFAULT_MAX_CRASH_DATA_DIR_BYTES = 16 * 1024 * 1024;

function createFs(entries = {}) {
  const files = new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      value instanceof Uint8Array ? value : new Uint8Array(value),
    ]),
  );
  const dirs = new Set(["/", NEXTCLOUD_DATA_DIR]);

  for (const path of files.keys()) {
    let current = path.slice(0, path.lastIndexOf("/")) || "/";
    while (current) {
      dirs.add(current);
      if (current === "/") break;
      current = current.slice(0, current.lastIndexOf("/")) || "/";
    }
  }

  const listFiles = (dirPath, { prependPath } = {}) => {
    const children = new Set();
    for (const dir of dirs) {
      if (dir === dirPath || !dir.startsWith(`${dirPath}/`)) continue;
      const remainder = dir.slice(dirPath.length + 1);
      if (!remainder || remainder.includes("/")) continue;
      children.add(prependPath ? `${dirPath}/${remainder}` : remainder);
    }
    for (const path of files.keys()) {
      if (!path.startsWith(`${dirPath}/`)) continue;
      const remainder = path.slice(dirPath.length + 1);
      if (!remainder || remainder.includes("/")) continue;
      children.add(prependPath ? `${dirPath}/${remainder}` : remainder);
    }
    return [...children];
  };

  return {
    fileExists(path) {
      return files.has(path) || dirs.has(path);
    },
    isDir(path) {
      return dirs.has(path);
    },
    listFiles,
    readFileAsBuffer(path) {
      const file = files.get(path);
      if (!file) {
        throw new Error(`missing file: ${path}`);
      }
      return file;
    },
  };
}

test("snapshot manager checkpoints pending data-dir ops before reading the DB", async () => {
  const messages = [];
  const flushCalls = [];
  const manager = createSnapshotManager({
    postShell: (message) => messages.push(message),
  });
  const php = {
    flushPersistence: async (options) => {
      flushCalls.push(options);
      return {
        enabled: true,
        ok: true,
        flushedOps: 2,
        hydratedBytes: 64,
        estimatedBytes: 64,
      };
    },
    _php: {
      readFileAsBuffer(path) {
        assert.equal(path, PLAYGROUND_DB_PATH);
        return new Uint8Array([1, 2, 3]);
      },
      fileExists() {
        return false;
      },
      isDir() {
        return false;
      },
    },
  };

  const result = await manager.hydrate(php, PLAYGROUND_DB_PATH);

  assert.equal(result.captured, true);
  assert.deepEqual(flushCalls, [
    {
      pathPrefix: NEXTCLOUD_DATA_DIR,
      maxBytes: DEFAULT_MAX_CRASH_DATA_DIR_BYTES,
    },
  ]);
  assert.equal(
    messages.some((message) =>
      String(message.detail || "").includes(
        "checkpointed 2 pending data-dir ops",
      ),
    ),
    true,
  );
});

test("snapshot manager does not capture a newer DB when the data-dir checkpoint fails", async () => {
  let dbReads = 0;
  const manager = createSnapshotManager({
    postShell() {},
  });
  const php = {
    flushPersistence: async () => ({
      enabled: true,
      ok: false,
      reason: "size-limit",
      estimatedBytes: DEFAULT_MAX_CRASH_DATA_DIR_BYTES + 1,
    }),
    _php: {
      readFileAsBuffer() {
        dbReads += 1;
        return new Uint8Array([1]);
      },
    },
  };

  const result = await manager.hydrate(php, PLAYGROUND_DB_PATH);

  assert.equal(result.captured, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(dbReads, 0);
  assert.equal(manager.hasPendingRestore, false);
});

test("snapshot manager uses a bounded in-memory data-dir fallback when persistence is unavailable", async () => {
  const writes = [];
  const manager = createSnapshotManager({
    postShell() {},
  });
  const php = {
    _php: createFs({
      [PLAYGROUND_DB_PATH]: [1, 2, 3],
      "/www/nextcloud/data/admin/files/doc.txt": [9, 8, 7],
    }),
  };

  const hydrateResult = await manager.hydrate(php, PLAYGROUND_DB_PATH);
  assert.equal(hydrateResult.captured, true);
  assert.equal(manager.hasPendingRestore, true);

  const restoreResult = await manager.restore({
    _php: {
      mkdirTree() {},
      writeFile(path, data) {
        writes.push([path, [...data]]);
      },
    },
  });

  assert.equal(restoreResult.restored, true);
  assert.deepEqual(writes, [
    [PLAYGROUND_DB_PATH, [1, 2, 3]],
    ["/www/nextcloud/data/admin/files/doc.txt", [9, 8, 7]],
  ]);
  assert.equal(manager.hasPendingRestore, false);
});

test("snapshot manager rejects oversized in-memory data-dir fallbacks", async () => {
  let dbReads = 0;
  const manager = createSnapshotManager({
    postShell() {},
    maxCrashDataDirBytes: 8,
  });
  const rawPhp = createFs({
    [PLAYGROUND_DB_PATH]: [1, 2, 3],
    "/www/nextcloud/data/admin/files/big.bin": new Uint8Array(16),
  });
  const originalReadFileAsBuffer = rawPhp.readFileAsBuffer.bind(rawPhp);
  rawPhp.readFileAsBuffer = (path) => {
    if (path === PLAYGROUND_DB_PATH) {
      dbReads += 1;
    }
    return originalReadFileAsBuffer(path);
  };
  const php = {
    _php: rawPhp,
  };

  const result = await manager.hydrate(php, PLAYGROUND_DB_PATH);

  assert.equal(result.captured, false);
  assert.equal(result.reason, "size-limit");
  assert.equal(dbReads, 0);
});
