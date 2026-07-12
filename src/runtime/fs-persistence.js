import {
  hydrateUpdateFileOps,
  journalFSEvents,
  normalizeFilesystemOperations,
  replayFSJournal,
} from "@php-wasm/fs-journal";
import { __private__dont__use } from "@php-wasm/universal";
import { NEXTCLOUD_CONFIG_DIR, NEXTCLOUD_DATA_DIR } from "./bootstrap-paths.js";

const PERSIST_DB_PREFIX = "nextcloud-fs-journal";
const OPCACHE_DB_PREFIX = "nextcloud-opcache";
const DB_VERSION = 1;
const STORE_NAME = "ops";
const FLUSH_DELAY_MS = 1500;
export const SQLITE_TEMP_FILE_RE = /\.(sqlite-journal|sqlite-wal|sqlite-shm)$/u;
const MUTABLE_PATH_PREFIXES = [
  "/persist",
  NEXTCLOUD_CONFIG_DIR,
  NEXTCLOUD_DATA_DIR,
];

function isPathUnderPrefix(path, pathPrefix) {
  // An empty pathPrefix means "flush everything" for callers like flushNow()
  // that intentionally omit a scope filter.
  if (!pathPrefix) return true;
  const normalizedPrefix = String(pathPrefix).replace(/\/$/u, "");
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

export function operationTouchesPathPrefix(operation, pathPrefix) {
  if (isPathUnderPrefix(operation?.path || "", pathPrefix)) {
    return true;
  }
  return (
    operation?.operation === "RENAME" &&
    isPathUnderPrefix(operation.toPath || "", pathPrefix)
  );
}

async function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOps(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function replaceOps(db, ops) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const op of ops) {
      store.add(op);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearDb(name) {
  const db = await openDb(name);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Collapse the raw journal ops, THEN hydrate only the survivors — the canonical
// fs-journal order (WordPress Playground's hydrate-fs-writes middleware does
// `hydrateUpdateFileOps(php, normalizeFilesystemOperations(ops))`). Hydrating the
// raw, un-collapsed list reads every write's content into memory: a heavy install
// rewrites the multi-MB SQLite DB hundreds of times within one flush window, so
// hydrating each one OOMs ("Array buffer allocation failed"). Normalizing first
// collapses the repeated same-path writes (and folds write-temp + rename) so each
// changed file is read exactly once.
export async function collapseAndHydrate(rawPhp, ops) {
  return hydrateUpdateFileOps(rawPhp, normalizeFilesystemOperations(ops));
}

function estimateWriteBytes(rawPhp, ops, getFileSize) {
  const resolveFileSize =
    getFileSize ||
    ((path) => {
      try {
        return rawPhp[__private__dont__use].FS.stat(path).size || 0;
      } catch (error) {
        throw new Error(
          `Unable to estimate persisted size for ${path}: ${error?.message || error}`,
        );
      }
    });
  let estimatedBytes = 0;

  for (const op of ops) {
    if (op.operation !== "WRITE") continue;
    estimatedBytes += Number(resolveFileSize(op.path)) || 0;
  }

  return estimatedBytes;
}

export async function flushPendingOps({
  rawPhp,
  pendingOps,
  loadPersistedOps,
  replacePersistedOps,
  shouldFlush = () => true,
  maxBytes = Number.POSITIVE_INFINITY,
  getFileSize = null,
}) {
  const selectedOps = [];
  const remainingOps = [];

  for (const op of pendingOps) {
    if (shouldFlush(op)) {
      selectedOps.push(op);
    } else {
      remainingOps.push(op);
    }
  }

  if (selectedOps.length === 0) {
    return {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    };
  }

  pendingOps.splice(0, pendingOps.length, ...remainingOps);
  const normalizedOps = normalizeFilesystemOperations(selectedOps);

  let estimatedBytes = 0;
  try {
    if (Number.isFinite(maxBytes)) {
      estimatedBytes = estimateWriteBytes(rawPhp, normalizedOps, getFileSize);
      if (estimatedBytes > maxBytes) {
        pendingOps.unshift(...selectedOps);
        return {
          ok: false,
          reason: "size-limit",
          flushedOps: 0,
          hydratedBytes: 0,
          estimatedBytes,
        };
      }
    }

    const hydrated = await hydrateUpdateFileOps(rawPhp, normalizedOps);
    const current = await loadPersistedOps();
    const merged = normalizeFilesystemOperations([...current, ...hydrated]);
    await replacePersistedOps(merged);
    const hydratedBytes = hydrated.reduce(
      (sum, op) =>
        sum + (op.operation === "WRITE" ? op.data?.byteLength || 0 : 0),
      0,
    );

    return {
      ok: true,
      flushedOps: hydrated.length,
      hydratedBytes,
      estimatedBytes,
    };
  } catch (error) {
    pendingOps.unshift(...selectedOps);
    return {
      ok: false,
      reason: "flush-failed",
      error,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes,
    };
  }
}

function createJournalFlusher(rawPhp, db, pendingOps) {
  let flushTimer = null;
  let flushQueue = Promise.resolve();

  const enqueueFlush = (options = {}) => {
    const run = flushQueue.then(() =>
      flushPendingOps({
        rawPhp,
        pendingOps,
        loadPersistedOps: () => loadOps(db),
        replacePersistedOps: (ops) => replaceOps(db, ops),
        ...options,
      }),
    );
    flushQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await enqueueFlush();
    }, FLUSH_DELAY_MS);
  };

  const flushNow = async ({ pathPrefix = null, maxBytes } = {}) => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const shouldFlush = pathPrefix
      ? (op) => operationTouchesPathPrefix(op, pathPrefix)
      : () => true;
    const aggregate = {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    };

    while (pendingOps.some(shouldFlush)) {
      const result = await enqueueFlush({ shouldFlush, maxBytes });
      aggregate.flushedOps += result.flushedOps || 0;
      aggregate.hydratedBytes += result.hydratedBytes || 0;
      aggregate.estimatedBytes += result.estimatedBytes || 0;

      if (!result.ok) {
        return { ...aggregate, ...result, ok: false };
      }
    }

    return aggregate;
  };

  return { flushNow, scheduleFlush };
}

export async function clearJournal(scopeId) {
  await clearDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
}

export async function clearOpcacheJournal(phpVersion) {
  await clearDb(`${OPCACHE_DB_PREFIX}:${phpVersion}`);
}

/**
 * Replay the journal, tolerating ops that can't be applied to a fresh FS so a
 * single bad op never bricks the reload. A dangling op can occur when a CREATE
 * was never journaled but a later delete (in another runtime) was — leaving a
 * dangling unlink that throws against the fresh MEMFS. Fast path replays the
 * whole batch; on any failure, replay op-by-op and skip the ones that throw (a
 * failed unlink just means the file is already gone, which is the intended end
 * state).
 */
function replayResilient(rawPhp, ops) {
  if (!ops || ops.length === 0) return;
  try {
    replayFSJournal(rawPhp, ops);
  } catch {
    for (const op of ops) {
      try {
        replayFSJournal(rawPhp, [op]);
      } catch {
        // Skip un-appliable op.
      }
    }
  }
}

/**
 * Replays the persisted FS journals onto a fresh PHP instance, then starts
 * journaling new changes back to IndexedDB.
 *
 * - /persist + Nextcloud config/data → keyed by scopeId (per-session mutable state)
 * - /internal/shared/opcache → keyed by phpVersion (cross-session OPcache persistence)
 *
 * Persisting OPcache means PHP only compiles each file once across reloads,
 * making the second and subsequent sessions dramatically faster.
 */
export async function initFsPersistence(rawPhp, scopeId, phpVersion) {
  const persistDb = await openDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
  const opcacheDb = phpVersion
    ? await openDb(`${OPCACHE_DB_PREFIX}:${phpVersion}`)
    : null;

  const pendingPersistOps = [];
  const pendingOpcacheOps = [];
  const persistFlusher = createJournalFlusher(
    rawPhp,
    persistDb,
    pendingPersistOps,
  );
  const opcacheFlusher = opcacheDb
    ? createJournalFlusher(rawPhp, opcacheDb, pendingOpcacheOps)
    : null;

  for (const root of MUTABLE_PATH_PREFIXES) {
    journalFSEvents(rawPhp, root, (op) => {
      if (SQLITE_TEMP_FILE_RE.test(op.path || "")) {
        return;
      }
      pendingPersistOps.push(op);
      persistFlusher.scheduleFlush();
    });
  }

  // Journal /internal/shared/opcache — PHP compiled bytecode.
  // Persisting this across sessions means PHP does not recompile on every reload.
  if (opcacheDb) {
    journalFSEvents(rawPhp, "/internal/shared/opcache", (op) => {
      pendingOpcacheOps.push(op);
      opcacheFlusher.scheduleFlush();
    });
  }

  // Replay saved ops onto the fresh MEMFS instance.
  // OPcache ops are replayed first so PHP finds the bytecode before any script runs.
  if (opcacheDb) {
    const savedOpcacheOps = await loadOps(opcacheDb);
    replayResilient(rawPhp, savedOpcacheOps);
  }

  const savedPersistOps = await loadOps(persistDb);
  replayResilient(rawPhp, savedPersistOps);

  return {
    flushNow: persistFlusher.flushNow,
  };
}
