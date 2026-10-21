import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import {
  clearJournal,
  dropLegacyOpcacheJournals,
  flushPendingOps,
  initFsPersistence,
  SQLITE_TEMP_FILE_RE,
} from "../src/runtime/fs-persistence.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// Minimal async IndexedDB: one object store per database, values kept in arrays
// so tests can seed and inspect what the journal persisted.
function installFakeIndexedDb({ failOpen = false, failTx = false } = {}) {
  const databases = new Map();
  const fire = (fn, arg) => queueMicrotask(() => fn?.(arg));
  globalThis.indexedDB = {
    databases,
    open(name) {
      const req = {};
      setTimeout(() => {
        if (failOpen) {
          req.error = new Error("open blocked");
          req.onerror?.();
          return;
        }
        let stores = databases.get(name);
        const fresh = !stores;
        if (fresh) {
          stores = new Map();
          databases.set(name, stores);
        }
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => stores.set(s, []),
          close() {},
          transaction(storeName) {
            const tx = {};
            const rows = () => stores.get(storeName);
            tx.objectStore = () => ({
              getAll() {
                const r = {};
                fire(() => {
                  r.result = rows().slice();
                  r.onsuccess?.();
                });
                return r;
              },
              clear() {
                rows().length = 0;
              },
              add(value) {
                rows().push(value);
              },
            });
            setTimeout(() => {
              if (failTx) {
                tx.error = new Error("tx aborted");
                tx.onerror?.();
              } else {
                tx.oncomplete?.();
              }
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.({ target: { result: db } });
        if (fresh && !stores.has("ops")) stores.set("ops", []);
        req.onsuccess?.();
      });
      return req;
    },
  };
  return databases;
}

// Fake raw PHP exposing the Emscripten FS hooks fs-journal wraps plus the
// replay/hydrate helpers it calls.
function fakePhp({ failReplay = () => false } = {}) {
  const files = new Map();
  const dirs = new Set();
  const replayed = [];
  const FS = {
    write: () => {},
    truncate: () => {},
    unlink: () => {},
    mknod: () => {},
    mkdir: () => {},
    rmdir: () => {},
    rename: () => {},
    isFile: () => true,
    stat(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return { size: files.get(path).byteLength };
    },
  };
  const check = (op) => {
    if (failReplay(op)) throw new Error(`cannot replay ${op}`);
  };
  return {
    files,
    dirs,
    replayed,
    [__private__dont__use]: { FS },
    addEventListener() {},
    removeEventListener() {},
    writeFile(path, data) {
      check(path);
      replayed.push(["write", path]);
      files.set(path, typeof data === "string" ? enc(data) : data);
    },
    mkdir(path) {
      check(path);
      replayed.push(["mkdir", path]);
      dirs.add(path);
    },
    unlink(path) {
      check(path);
      replayed.push(["unlink", path]);
      files.delete(path);
    },
    rmdir(path) {
      check(path);
      dirs.delete(path);
    },
    mv(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async readFileAsBuffer(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
  };
}

const ops = (databases, scope = "s1") =>
  databases.get(`nextcloud-fs-journal:${scope}`).get("ops");

let originalIdb;
beforeEach(() => {
  originalIdb = globalThis.indexedDB;
});
afterEach(() => {
  if (originalIdb === undefined) delete globalThis.indexedDB;
  else globalThis.indexedDB = originalIdb;
});

describe("initFsPersistence", () => {
  it("journals writes under the mutable roots and persists them on flushNow", async () => {
    const databases = installFakeIndexedDb();
    const php = fakePhp();
    const { flushNow } = await initFsPersistence(php, "s1");
    const FS = php[__private__dont__use].FS;

    php.files.set("/www/nextcloud/config/config.php", enc("<?php $CONFIG=[];"));
    php.files.set("/www/nextcloud/data/owncloud.db-journal", enc("j"));
    FS.write({ path: "/www/nextcloud/config/config.php" });
    FS.write({ path: "/www/nextcloud/data/owncloud.db-journal" });
    FS.write({ path: "/www/nextcloud/data/owncloud.db.sqlite-journal" });
    FS.write({ path: "/www/nextcloud/lib/base.php" });

    const result = await flushNow();
    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 2);
    const stored = ops(databases);
    assert.deepEqual(
      stored.map((op) => op.path).sort(),
      [
        "/www/nextcloud/config/config.php",
        "/www/nextcloud/data/owncloud.db-journal",
      ],
      "core files and SQLite temp files are never journaled",
    );
    const config = stored.find((op) => op.path.endsWith("config.php"));
    assert.equal(dec(config.data), "<?php $CONFIG=[];");

    assert.deepEqual(await flushNow(), {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
  });

  it("replays the saved journal onto a fresh instance", async () => {
    const databases = installFakeIndexedDb();
    const first = fakePhp();
    const a = await initFsPersistence(first, "s1");
    first.files.set("/persist/x.txt", enc("kept"));
    first[__private__dont__use].FS.write({ path: "/persist/x.txt" });
    await a.flushNow();
    assert.equal(ops(databases).length, 1);

    const second = fakePhp();
    await initFsPersistence(second, "s1");
    assert.equal(dec(second.files.get("/persist/x.txt")), "kept");
  });

  it("skips ops that cannot be replayed instead of failing boot", async () => {
    const databases = installFakeIndexedDb();
    // Seed the store before init opens it (version upgrade already happened).
    databases.set(
      "nextcloud-fs-journal:s1",
      new Map([
        [
          "ops",
          [
            { operation: "DELETE", path: "/persist/gone", nodeType: "file" },
            {
              operation: "WRITE",
              path: "/persist/ok",
              nodeType: "file",
              data: enc("ok"),
            },
          ],
        ],
      ]),
    );
    const php = fakePhp({ failReplay: (p) => p === "/persist/gone" });
    await initFsPersistence(php, "s1");
    assert.equal(dec(php.files.get("/persist/ok")), "ok");
  });

  it("flushes on the debounce timer without an explicit flushNow", async () => {
    const databases = installFakeIndexedDb();
    const php = fakePhp();
    await initFsPersistence(php, "s1");
    php.files.set("/persist/t.txt", enc("t"));
    php[__private__dont__use].FS.write({ path: "/persist/t.txt" });
    php[__private__dont__use].FS.write({ path: "/persist/t.txt" });
    assert.equal(ops(databases).length, 0);
    await new Promise((r) => setTimeout(r, 1700));
    assert.deepEqual(
      ops(databases).map((op) => op.path),
      ["/persist/t.txt"],
    );
  });

  it("flushNow only drains the requested prefix and cancels the pending timer", async () => {
    const databases = installFakeIndexedDb();
    const php = fakePhp();
    const { flushNow } = await initFsPersistence(php, "s1");
    const FS = php[__private__dont__use].FS;
    php.files.set("/persist/a", enc("a"));
    php.files.set("/www/nextcloud/data/b", enc("b"));
    FS.write({ path: "/persist/a" });
    FS.write({ path: "/www/nextcloud/data/b" });

    const result = await flushNow({ pathPrefix: "/www/nextcloud/data/" });
    assert.equal(result.flushedOps, 1);
    assert.deepEqual(
      ops(databases).map((op) => op.path),
      ["/www/nextcloud/data/b"],
    );
    // The timer was cancelled: /persist/a stays pending past the debounce.
    await new Promise((r) => setTimeout(r, 1600));
    assert.equal(ops(databases).length, 1);
    await flushNow();
    assert.equal(ops(databases).length, 2);
  });

  it("reports a size-limit failure using FS.stat sizes and keeps ops pending", async () => {
    const databases = installFakeIndexedDb();
    const php = fakePhp();
    const { flushNow } = await initFsPersistence(php, "s1");
    php.files.set("/persist/big", new Uint8Array(64));
    php[__private__dont__use].FS.write({ path: "/persist/big" });

    const limited = await flushNow({ maxBytes: 10 });
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, "size-limit");
    assert.equal(limited.estimatedBytes, 64);
    assert.equal(ops(databases).length, 0);

    const full = await flushNow({ maxBytes: 1000 });
    assert.equal(full.ok, true);
    assert.equal(full.hydratedBytes, 64);
  });

  it("reports flush-failed when a file vanished before its size could be read", async () => {
    installFakeIndexedDb();
    const php = fakePhp();
    const { flushNow } = await initFsPersistence(php, "s1");
    php[__private__dont__use].FS.write({ path: "/persist/missing" });
    const result = await flushNow({ maxBytes: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "flush-failed");
    assert.match(
      result.error.message,
      /Unable to estimate persisted size for \/persist\/missing/,
    );
  });

  it("surfaces IndexedDB transaction errors as flush-failed", async () => {
    installFakeIndexedDb({ failTx: true });
    const php = fakePhp();
    const { flushNow } = await initFsPersistence(php, "s1");
    php.files.set("/persist/a", enc("a"));
    php[__private__dont__use].FS.write({ path: "/persist/a" });
    const result = await flushNow();
    assert.equal(result.reason, "flush-failed");
    assert.match(result.error.message, /tx aborted/);
  });

  it("rejects when the database cannot be opened", async () => {
    installFakeIndexedDb({ failOpen: true });
    await assert.rejects(
      () => initFsPersistence(fakePhp(), "s1"),
      /open blocked/,
    );
  });
});

describe("clearJournal", () => {
  it("empties the scope's journal store", async () => {
    const databases = installFakeIndexedDb();
    databases.set(
      "nextcloud-fs-journal:s2",
      new Map([["ops", [{ operation: "WRITE", path: "/persist/a" }]]]),
    );
    await clearJournal("s2");
    assert.deepEqual(ops(databases, "s2"), []);
  });

  it("propagates transaction errors", async () => {
    installFakeIndexedDb({ failTx: true });
    await assert.rejects(() => clearJournal("s3"), /tx aborted/);
  });
});

describe("flushPendingOps details", () => {
  it("returns a no-op result when nothing is selected", async () => {
    const pendingOps = [{ operation: "WRITE", path: "/a" }];
    const result = await flushPendingOps({
      rawPhp: fakePhp(),
      pendingOps,
      loadPersistedOps: async () => assert.fail("must not load"),
      replacePersistedOps: async () => assert.fail("must not write"),
      shouldFlush: () => false,
    });
    assert.deepEqual(result, {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(pendingOps.length, 1);
  });

  it("counts only WRITE bytes and treats non-numeric sizes as zero", async () => {
    const php = fakePhp();
    php.files.set("/a", enc("abcd"));
    let persisted;
    const result = await flushPendingOps({
      rawPhp: php,
      pendingOps: [
        { operation: "CREATE", path: "/d", nodeType: "directory" },
        { operation: "WRITE", path: "/a", nodeType: "file" },
      ],
      loadPersistedOps: async () => [
        { operation: "WRITE", path: "/old", nodeType: "file", data: enc("o") },
      ],
      replacePersistedOps: async (o) => {
        persisted = o;
      },
      maxBytes: 100,
      getFileSize: () => "n/a",
    });
    assert.equal(result.ok, true);
    assert.equal(result.estimatedBytes, 0);
    assert.equal(result.hydratedBytes, 4);
    assert.deepEqual(
      persisted.map((op) => op.path),
      ["/old", "/d", "/a"],
    );
  });
});

describe("dropLegacyOpcacheJournals edge cases", () => {
  it("swallows deleteDatabase and databases() failures", async () => {
    const idb = {
      deleteDatabase() {
        throw new Error("blocked");
      },
      databases: async () => {
        throw new Error("unsupported");
      },
    };
    assert.deepEqual(await dropLegacyOpcacheJournals("8.4", idb), [
      "nextcloud-opcache:8.4",
    ]);
  });

  it("tolerates a null database list and nameless entries", async () => {
    const deleted = [];
    const idb = {
      deleteDatabase: (n) => deleted.push(n),
      databases: async () => null,
    };
    await dropLegacyOpcacheJournals("8.4", idb);
    const idb2 = {
      deleteDatabase: (n) => deleted.push(n),
      databases: async () => [{}, null, { name: "nextcloud-opcache:8.4" }],
    };
    await dropLegacyOpcacheJournals("8.4", idb2);
    assert.deepEqual(deleted, [
      "nextcloud-opcache:8.4",
      "nextcloud-opcache:8.4",
    ]);
  });

  it("uses globalThis.indexedDB by default", async () => {
    const deleted = [];
    globalThis.indexedDB = { deleteDatabase: (n) => deleted.push(n) };
    await dropLegacyOpcacheJournals("8.2");
    assert.deepEqual(deleted, ["nextcloud-opcache:8.2"]);
  });
});

describe("SQLITE_TEMP_FILE_RE", () => {
  it("matches SQLite sidecar files only", () => {
    assert.ok(SQLITE_TEMP_FILE_RE.test("/d/owncloud.db.sqlite-wal"));
    assert.ok(SQLITE_TEMP_FILE_RE.test("/d/x.sqlite-shm"));
    assert.ok(!SQLITE_TEMP_FILE_RE.test("/d/owncloud.db"));
  });
});
