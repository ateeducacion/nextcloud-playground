import {
  hydrateUpdateFileOps,
  journalFSEvents,
  normalizeFilesystemOperations,
  replayFSJournal,
} from "@php-wasm/fs-journal";

const PERSIST_DB_PREFIX = "nextcloud-fs-journal";
const OPCACHE_DB_PREFIX = "nextcloud-opcache";
const DB_VERSION = 1;
const STORE_NAME = "ops";
const FLUSH_DELAY_MS = 1500;

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

async function flushOps(rawPhp, db, pendingOps) {
  if (pendingOps.length === 0) return;
  const ops = pendingOps.splice(0);
  try {
    const hydrated = await hydrateUpdateFileOps(rawPhp, ops);
    const current = await loadOps(db);
    const merged = normalizeFilesystemOperations([...current, ...hydrated]);
    await replaceOps(db, merged);
  } catch {
    // Non-fatal — changes are in MEMFS even if the journal write fails.
  }
}

export async function clearJournal(scopeId) {
  await clearDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
}

export async function clearOpcacheJournal(phpVersion) {
  await clearDb(`${OPCACHE_DB_PREFIX}:${phpVersion}`);
}

/**
 * Replays the persisted FS journals onto a fresh PHP instance, then starts
 * journaling new changes back to IndexedDB.
 *
 * - /persist  → keyed by scopeId (per-session mutable data: DB, config, session)
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
  let flushTimer = null;

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await Promise.all([
        flushOps(rawPhp, persistDb, pendingPersistOps),
        opcacheDb
          ? flushOps(rawPhp, opcacheDb, pendingOpcacheOps)
          : Promise.resolve(),
      ]);
    }, FLUSH_DELAY_MS);
  };

  // Journal /persist — mutable app data (DB, config, sessions).
  // Skip ephemeral SQLite temp files — they are created and deleted within
  // a single transaction and cause hydration failures if journaled.
  journalFSEvents(rawPhp, "/persist", (op) => {
    if (/\.(sqlite-journal|sqlite-wal|sqlite-shm)$/.test(op.path || "")) return;
    pendingPersistOps.push(op);
    scheduleFlush();
  });

  // Journal /internal/shared/opcache — PHP compiled bytecode.
  // Persisting this across sessions means PHP does not recompile on every reload.
  if (opcacheDb) {
    journalFSEvents(rawPhp, "/internal/shared/opcache", (op) => {
      pendingOpcacheOps.push(op);
      scheduleFlush();
    });
  }

  // Replay saved ops onto the fresh MEMFS instance.
  // OPcache ops are replayed first so PHP finds the bytecode before any script runs.
  if (opcacheDb) {
    const savedOpcacheOps = await loadOps(opcacheDb);
    if (savedOpcacheOps.length > 0) {
      replayFSJournal(rawPhp, savedOpcacheOps);
    }
  }

  const savedPersistOps = await loadOps(persistDb);
  if (savedPersistOps.length > 0) {
    replayFSJournal(rawPhp, savedPersistOps);
  }
}
