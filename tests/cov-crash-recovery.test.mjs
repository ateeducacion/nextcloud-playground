import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import {
  NEXTCLOUD_DATA_DIR,
  PLAYGROUND_DB_PATH,
} from "../src/runtime/bootstrap-paths.js";
import {
  bootAfterUnreplayedCrash,
  createSnapshotManager,
  isEmscriptenNetworkError,
  isFatalWasmError,
  isSafeToReplay,
  requestPathname,
} from "../src/runtime/crash-recovery.js";

const bytes = (n, fill = 1) => new Uint8Array(n).fill(fill);

// In-memory raw PHP with the subset of the API the snapshot manager uses.
function fakeRawPhp(entries = {}, { stat, unreadable = [], failWrite } = {}) {
  const files = new Map(Object.entries(entries));
  const dirs = new Set(["/"]);
  const addParents = (path) => {
    let dir = path.slice(0, path.lastIndexOf("/"));
    while (dir) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  };
  for (const path of files.keys()) addParents(path);
  const mkdirs = [];
  return {
    files,
    dirs,
    mkdirs,
    [__private__dont__use]: {
      FS: {
        stat(path) {
          if (stat) return stat(path);
          return { size: files.get(path)?.byteLength };
        },
      },
    },
    fileExists: (p) => files.has(p) || dirs.has(p),
    isDir: (p) => dirs.has(p),
    listFiles(dir, { prependPath } = {}) {
      if (!dirs.has(dir)) throw new Error(`ENOENT ${dir}`);
      const out = new Set();
      for (const p of [...dirs, ...files.keys()]) {
        if (!p.startsWith(`${dir}/`)) continue;
        const rest = p.slice(dir.length + 1);
        if (rest && !rest.includes("/"))
          out.add(prependPath ? `${dir}/${rest}` : rest);
      }
      return [...out];
    },
    readFileAsBuffer(path) {
      if (unreadable.includes(path) || !files.has(path))
        throw new Error(`cannot read ${path}`);
      return files.get(path);
    },
    mkdirTree(dir) {
      mkdirs.push(dir);
      dirs.add(dir);
    },
    writeFile(path, data) {
      if (failWrite?.(path)) throw new Error(`write failed ${path}`);
      files.set(path, data);
    },
  };
}

function manager(opts = {}) {
  const messages = [];
  const m = createSnapshotManager({
    postShell: (msg) => messages.push(msg),
    ...opts,
  });
  return { m, messages, details: () => messages.map((x) => x.detail) };
}

describe("error classification", () => {
  it("detects Emscripten EHOSTUNREACH", () => {
    assert.equal(isEmscriptenNetworkError(null), false);
    assert.equal(isEmscriptenNetworkError({ errno: 23 }), true);
    assert.equal(isEmscriptenNetworkError({ errno: 2 }), false);
  });

  it("treats WASM traps and missing includes as fatal", () => {
    assert.equal(isFatalWasmError(null), false);
    assert.equal(isFatalWasmError({ errno: 23 }), true);
    assert.equal(isFatalWasmError(new WebAssembly.RuntimeError("x")), true);
    assert.equal(
      isFatalWasmError(new Error("memory access out of bounds")),
      true,
    );
    assert.equal(isFatalWasmError("unreachable executed"), true);
    assert.equal(isFatalWasmError(new Error("RuntimeError: boom")), true);
    assert.equal(
      isFatalWasmError(new Error("Failed opening required 'x.php'")),
      true,
    );
    assert.equal(isFatalWasmError(new Error("404 not found")), false);
  });

  it("replays only GET and HEAD", () => {
    assert.equal(isSafeToReplay(undefined), true);
    assert.equal(isSafeToReplay({ method: "head" }), true);
    assert.equal(isSafeToReplay({ method: "POST" }), false);
  });
});

describe("bootAfterUnreplayedCrash", () => {
  it("boots only after a reset of a non-replayable first attempt", async () => {
    let boots = 0;
    const boot = async () => {
      boots += 1;
    };
    const base = { didReset: true, isRetry: false, canReplay: false, boot };
    assert.equal(
      await bootAfterUnreplayedCrash({ ...base, didReset: false }),
      false,
    );
    assert.equal(
      await bootAfterUnreplayedCrash({ ...base, isRetry: true }),
      false,
    );
    assert.equal(
      await bootAfterUnreplayedCrash({ ...base, canReplay: true }),
      false,
    );
    assert.equal(boots, 0);
    assert.equal(await bootAfterUnreplayedCrash(base), true);
    assert.equal(boots, 1);
  });

  it("reports a failed boot instead of throwing", async () => {
    const errors = [];
    const result = await bootAfterUnreplayedCrash({
      didReset: true,
      boot: async () => {
        throw new Error("boot failed");
      },
      onError: (e) => errors.push(e.message),
    });
    assert.equal(result, true);
    assert.deepEqual(errors, ["boot failed"]);
  });
});

describe("requestPathname", () => {
  it("drops the query and falls back to / on bad input", () => {
    assert.equal(
      requestPathname({ url: "/apps/files/?token=x" }),
      "/apps/files/",
    );
    assert.equal(requestPathname(undefined), "/");
    assert.equal(requestPathname({ url: "http://[bad" }), "/");
  });
});

describe("snapshot manager: journal checkpoint", () => {
  it("aborts the snapshot when the checkpoint hits the size limit", async () => {
    const { m, messages } = manager({ maxCrashDataDirBytes: 2048 });
    const php = {
      _php: fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(4) }),
      flushPersistence: async () => ({
        enabled: true,
        ok: false,
        reason: "size-limit",
        estimatedBytes: 4096,
      }),
    };
    assert.deepEqual(await m.hydrate(php), {
      captured: false,
      reason: "size-limit",
    });
    assert.match(messages[0].detail, /\(4KB exceeds 2KB limit\)/);
    assert.equal(messages[0].kind, "error");
    assert.equal(m.hasPendingRestore, false);
  });

  it("aborts with a generic reason when the flush fails without detail", async () => {
    const { m, details } = manager();
    const php = {
      _php: fakeRawPhp(),
      flushPersistence: async () => ({ enabled: true, ok: false }),
    };
    assert.deepEqual(await m.hydrate(php), {
      captured: false,
      reason: "data-dir-checkpoint-failed",
    });
    assert.match(details()[0], /checkpoint failed; using the last/);
  });

  it("aborts when flushPersistence throws", async () => {
    const { m, details } = manager();
    const php = {
      _php: fakeRawPhp(),
      flushPersistence: async () => {
        throw new Error("idb gone");
      },
    };
    assert.deepEqual(await m.hydrate(php), {
      captured: false,
      reason: "flush-failed",
    });
    assert.match(details()[0], /checkpoint failed: idb gone/);
  });

  it("checkpoints with defaulted counters and saves the DB", async () => {
    const { m, details } = manager();
    const php = {
      _php: fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(10) }),
      flushPersistence: async () => ({ enabled: true, ok: true }),
    };
    assert.deepEqual(await m.hydrate(php), {
      captured: true,
      dataDirMode: "journal",
    });
    assert.match(details()[0], /checkpointed 0 pending data-dir ops \(0KB\)/);
    assert.match(details()[1], /saved DB \(10 bytes\)/);
  });

  it("falls back to scanning when persistence is disabled", async () => {
    const { m } = manager();
    const php = {
      _php: fakeRawPhp({ [`${NEXTCLOUD_DATA_DIR}/admin/f.txt`]: bytes(3) }),
      flushPersistence: async () => ({ enabled: false }),
    };
    const result = await m.hydrate(php, "/custom.db");
    // No DB at /custom.db: the read throws and the snapshot is abandoned.
    assert.deepEqual(result, { captured: false, reason: "db-read-failed" });
    assert.equal(m.hasPendingRestore, false);
  });
});

describe("snapshot manager: bounded fallback scan", () => {
  it("returns no files when the raw API lacks fileExists/isDir", async () => {
    const { m } = manager();
    const raw = { readFileAsBuffer: () => bytes(0) };
    assert.deepEqual(await m.hydrate({ _php: raw }), {
      captured: true,
      dataDirMode: "fallback",
    });
    assert.equal(m.hasPendingRestore, false);
  });

  it("treats a throwing data-dir probe and a missing data dir as empty", async () => {
    const { m } = manager();
    const throwing = fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(1) });
    throwing.fileExists = () => {
      throw new Error("FS dead");
    };
    assert.equal((await m.hydrate({ _php: throwing })).dataDirMode, "fallback");

    const noData = fakeRawPhp({ "/elsewhere/db": bytes(1) });
    assert.deepEqual(await m.hydrate({ _php: noData }, "/elsewhere/db"), {
      captured: true,
      dataDirMode: "fallback",
    });
  });

  it("collects data files (skipping the DB, SQLite temp and unreadable files) and restores them", async () => {
    const { m, details } = manager();
    const raw = fakeRawPhp(
      {
        [PLAYGROUND_DB_PATH]: bytes(8, 7),
        [`${NEXTCLOUD_DATA_DIR}/owncloud.db.sqlite-wal`]: bytes(5),
        [`${NEXTCLOUD_DATA_DIR}/admin/files/a.txt`]: bytes(2, 9),
        [`${NEXTCLOUD_DATA_DIR}/admin/files/b.txt`]: bytes(3, 8),
        [`${NEXTCLOUD_DATA_DIR}/admin/locked`]: bytes(1),
      },
      { unreadable: [`${NEXTCLOUD_DATA_DIR}/admin/locked`] },
    );
    assert.deepEqual(await m.hydrate({ _php: raw }), {
      captured: true,
      dataDirMode: "fallback",
    });
    assert.ok(details().some((d) => /fallback \(2 entries, 0KB\)/.test(d)));
    assert.equal(m.hasPendingRestore, true);

    const fresh = fakeRawPhp();
    assert.deepEqual(await m.restore({ _php: fresh }), {
      restored: true,
      addonsRestored: false,
    });
    assert.deepEqual(fresh.files.get(PLAYGROUND_DB_PATH), bytes(8, 7));
    assert.deepEqual(
      fresh.files.get(`${NEXTCLOUD_DATA_DIR}/admin/files/b.txt`),
      bytes(3, 8),
    );
    assert.equal(
      fresh.files.has(`${NEXTCLOUD_DATA_DIR}/owncloud.db.sqlite-wal`),
      false,
    );
    // Shared parent directories are created once.
    assert.deepEqual(fresh.mkdirs, [`${NEXTCLOUD_DATA_DIR}/admin/files`]);
    assert.ok(
      details().some((d) => /restored 2 data-dir fallback files$/.test(d)),
    );
    assert.equal(m.hasPendingRestore, false);
  });

  it("skips the live snapshot when FS.stat reports too many bytes", async () => {
    const { m, details } = manager({ maxCrashDataDirBytes: 4 });
    const raw = fakeRawPhp({
      [PLAYGROUND_DB_PATH]: bytes(1),
      [`${NEXTCLOUD_DATA_DIR}/a`]: bytes(3),
      [`${NEXTCLOUD_DATA_DIR}/b`]: bytes(3),
      [`${NEXTCLOUD_DATA_DIR}/z/c`]: bytes(3),
    });
    assert.deepEqual(await m.hydrate({ _php: raw }), {
      captured: false,
      reason: "size-limit",
    });
    assert.match(details()[0], /bounded data-dir fallback exceeds 0KB/);
  });

  it("enforces the limit on read size when FS.stat is unavailable", async () => {
    const { m } = manager({ maxCrashDataDirBytes: 4 });
    const raw = fakeRawPhp(
      {
        [PLAYGROUND_DB_PATH]: bytes(1),
        [`${NEXTCLOUD_DATA_DIR}/a`]: bytes(3),
        [`${NEXTCLOUD_DATA_DIR}/b`]: bytes(3),
      },
      {
        stat: () => {
          throw new Error("no stat");
        },
      },
    );
    assert.equal((await m.hydrate({ _php: raw })).reason, "size-limit");
  });
});

describe("snapshot manager: addon dirs", () => {
  it("saves tracked addon files and restores them with per-file failures", async () => {
    const { m, details } = manager();
    m.trackAddonDir("/www/nextcloud/apps/myapp");
    m.trackAddonDir("/www/nextcloud/apps/missing");
    m.trackAddonDir("/www/nextcloud/apps/empty");
    m.trackAddonDir("/www/nextcloud/apps/broken");
    assert.match(
      details()[0],
      /tracking installed addon: \/www\/nextcloud\/apps\/myapp/,
    );

    const raw = fakeRawPhp(
      {
        [PLAYGROUND_DB_PATH]: bytes(2),
        "/www/nextcloud/apps/myapp/appinfo/info.xml": bytes(4),
        "/www/nextcloud/apps/myapp/top.php": bytes(1),
        "/www/nextcloud/apps/myapp/bad.php": bytes(1),
      },
      { unreadable: ["/www/nextcloud/apps/myapp/bad.php"] },
    );
    raw.dirs.add("/www/nextcloud/apps/empty");
    raw.dirs.add("/www/nextcloud/apps/broken");
    const listFiles = raw.listFiles;
    raw.listFiles = (dir, opts) => {
      if (dir === "/www/nextcloud/apps/broken") throw new Error("EIO");
      return listFiles(dir, opts);
    };
    await m.hydrate({ _php: raw });
    assert.ok(details().includes("[snapshot] saved 2 addon files"));

    const fresh = fakeRawPhp({}, { failWrite: (p) => p.endsWith("top.php") });
    assert.deepEqual(await m.restore({ _php: fresh }), {
      restored: true,
      addonsRestored: true,
    });
    assert.deepEqual(
      fresh.files.get("/www/nextcloud/apps/myapp/appinfo/info.xml"),
      bytes(4),
    );
    assert.ok(
      details().includes("[snapshot] restored 1 addon files (1 failed)"),
    );
  });

  it("reports addon dirs whose existence check throws", async () => {
    const { m, details } = manager();
    m.trackAddonDir("/www/nextcloud/apps/x");
    const raw = fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(1) });
    raw.fileExists = (p) => {
      if (p === "/www/nextcloud/apps/x") throw new Error("EIO");
      return raw.dirs.has(p) || raw.files.has(p);
    };
    assert.equal((await m.hydrate({ _php: raw })).captured, true);
    assert.ok(
      details().some((d) =>
        /failed to read addon dir \/www\/nextcloud\/apps\/x: EIO/.test(d),
      ),
    );
  });

  it("does not mark addons restored when every addon write fails", async () => {
    const { m, details } = manager();
    m.trackAddonDir("/apps/a");
    await m.hydrate(
      { _php: fakeRawPhp({ "/apps/a/f": bytes(1) }) },
      "/apps/a/f",
    );
    const fresh = fakeRawPhp({}, { failWrite: () => true });
    assert.deepEqual(await m.restore({ _php: fresh }), {
      restored: false,
      addonsRestored: false,
    });
    assert.ok(
      details().some((d) => /failed to restore DB: write failed/.test(d)),
    );
    assert.ok(
      details().some((d) => /restored 0 addon files \(1 failed\)/.test(d)),
    );
  });
});

describe("snapshot manager: restore and clear", () => {
  it("restore is a no-op without a snapshot", async () => {
    const { m } = manager();
    assert.deepEqual(await m.restore({ _php: fakeRawPhp() }), {
      restored: false,
      addonsRestored: false,
    });
  });

  it("an empty DB file is not snapshotted", async () => {
    const { m } = manager();
    const raw = fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(0) });
    assert.equal((await m.hydrate({ _php: raw })).captured, true);
    assert.equal(m.hasPendingRestore, false);
  });

  it("clear drops a pending snapshot", async () => {
    const { m } = manager();
    await m.hydrate({ _php: fakeRawPhp({ [PLAYGROUND_DB_PATH]: bytes(1) }) });
    assert.equal(m.hasPendingRestore, true);
    m.clear();
    assert.equal(m.hasPendingRestore, false);
  });

  it("restores data-dir files even when some writes fail", async () => {
    const { m, details } = manager();
    const raw = fakeRawPhp({
      [PLAYGROUND_DB_PATH]: bytes(1),
      [`${NEXTCLOUD_DATA_DIR}/a`]: bytes(1),
      [`${NEXTCLOUD_DATA_DIR}/b`]: bytes(1),
    });
    await m.hydrate({ _php: raw });
    const fresh = fakeRawPhp({}, { failWrite: (p) => p.endsWith("/b") });
    assert.equal((await m.restore({ _php: fresh })).restored, true);
    assert.ok(
      details().some((d) =>
        /restored 1 data-dir fallback files \(1 failed\)/.test(d),
      ),
    );
  });

  it("a fully failed data-dir restore does not count as restored", async () => {
    const { m } = manager();
    m.clear();
    const raw = fakeRawPhp({
      [PLAYGROUND_DB_PATH]: bytes(1),
      [`${NEXTCLOUD_DATA_DIR}/a`]: bytes(1),
    });
    await m.hydrate({ _php: raw });
    const fresh = fakeRawPhp({}, { failWrite: () => true });
    assert.equal((await m.restore({ _php: fresh })).restored, false);
  });
});
