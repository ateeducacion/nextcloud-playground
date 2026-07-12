/**
 * Crash recovery utilities for the PHP WASM runtime.
 *
 * Recovery strategy:
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - DB snapshot preserves session state across restarts.
 */

import { NEXTCLOUD_DATA_DIR, PLAYGROUND_DB_PATH } from "./bootstrap-paths.js";
import { SQLITE_TEMP_FILE_RE } from "./fs-persistence.js";

export const DEFAULT_MAX_CRASH_DATA_DIR_BYTES = 16 * 1024 * 1024;

function formatKB(bytes) {
  return Math.round((bytes || 0) / 1024);
}

/**
 * Detect Emscripten errno 23 (EHOSTUNREACH).  In WASM, outbound curl
 * calls that cannot reach the host crash with this errno.  Dashboard's
 * Telemetry/News HTTP calls trigger it on Firefox/Safari where
 * Emscripten's networking layer fails to connect.
 */
export function isEmscriptenNetworkError(error) {
  if (!error) return false;
  return error.errno === 23;
}

/**
 * Determine whether an error represents a fatal, unrecoverable WASM crash.
 */
export function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  if (isEmscriptenNetworkError(error)) return true;

  const message = String(error.message || error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError) ||
    message.includes("memory access out of bounds") ||
    message.includes("unreachable") ||
    message.includes("RuntimeError") ||
    message.includes("Failed opening required")
  );
}

/**
 * Determine whether a serialized request is safe to replay after a crash.
 */
export function isSafeToReplay(serializedRequest) {
  const method = String(serializedRequest?.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * Format an error into a human-readable string for display/logging.
 */
export function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return String(error.stack || error.message || error);
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Create a state snapshot manager for crash recovery.
 *
 * Before destroying the crashed runtime, read the DB file and addon files
 * from MEMFS (JS heap — works even with corrupted WASM linear memory).
 * After bootstrapping a fresh runtime, restore them.
 */
export function createSnapshotManager({
  postShell,
  maxCrashDataDirBytes = DEFAULT_MAX_CRASH_DATA_DIR_BYTES,
}) {
  let savedDbSnapshot = null;
  let savedAddonFiles = null;
  let savedDataDirFiles = null;
  const installedAddonDirs = new Set();

  function restoreFiles(rawPhp, files) {
    let ok = 0;
    let failed = 0;
    const createdDirs = new Set();

    for (const file of files) {
      try {
        const lastSlash = file.path.lastIndexOf("/");
        const parentDir =
          lastSlash > 0 ? file.path.substring(0, lastSlash) : null;
        if (parentDir && !createdDirs.has(parentDir)) {
          rawPhp.mkdirTree(parentDir);
          let dir = parentDir;
          while (dir && !createdDirs.has(dir)) {
            createdDirs.add(dir);
            dir = dir.substring(0, dir.lastIndexOf("/")) || null;
          }
        }
        rawPhp.writeFile(file.path, file.data);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  function collectFiles(rawPhp, dirPath) {
    const files = [];
    try {
      const entries = rawPhp.listFiles(dirPath, { prependPath: true });
      for (const entry of entries) {
        if (rawPhp.isDir(entry)) {
          files.push(...collectFiles(rawPhp, entry));
        } else {
          try {
            const data = rawPhp.readFileAsBuffer(entry);
            files.push({ path: entry, data: new Uint8Array(data) });
          } catch {
            // Unreadable file — skip
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read — skip
    }
    return files;
  }

  function collectFilesBounded(rawPhp, dirPath, maxBytes) {
    const files = [];
    let totalBytes = 0;
    let exceeded = false;

    const visit = (path) => {
      if (exceeded) return;
      let entries;
      try {
        entries = rawPhp.listFiles(path, { prependPath: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (exceeded) return;
        if (entry === PLAYGROUND_DB_PATH) {
          continue;
        }
        if (rawPhp.isDir(entry)) {
          visit(entry);
          continue;
        }
        if (SQLITE_TEMP_FILE_RE.test(entry)) {
          continue;
        }

        try {
          const data = new Uint8Array(rawPhp.readFileAsBuffer(entry));
          if (totalBytes + data.byteLength > maxBytes) {
            exceeded = true;
            files.length = 0;
            return;
          }
          totalBytes += data.byteLength;
          files.push({ path: entry, data });
        } catch {}
      }
    };

    visit(dirPath);
    return { exceeded, files, totalBytes };
  }

  async function prepareDataDirCheckpoint(php, rawPhp) {
    if (typeof php.flushPersistence === "function") {
      try {
        const result = await php.flushPersistence({
          pathPrefix: NEXTCLOUD_DATA_DIR,
          maxBytes: maxCrashDataDirBytes,
        });

        if (result?.enabled) {
          if (!result.ok) {
            const sizeDetail =
              result.reason === "size-limit"
                ? ` (${formatKB(result.estimatedBytes)}KB exceeds ${formatKB(maxCrashDataDirBytes)}KB limit)`
                : "";
            postShell({
              kind: "error",
              detail: `[snapshot] data-dir checkpoint failed${sizeDetail}; using the last persisted checkpoint`,
            });
            return { ok: false, mode: "journal", reason: result.reason };
          }

          postShell({
            kind: "trace",
            detail: `[snapshot] checkpointed ${result.flushedOps || 0} pending data-dir ops (${formatKB(result.hydratedBytes)}KB)`,
          });
          return { ok: true, mode: "journal" };
        }
      } catch (error) {
        postShell({
          kind: "error",
          detail: `[snapshot] data-dir checkpoint failed: ${error.message}; using the last persisted checkpoint`,
        });
        return { ok: false, mode: "journal", reason: "flush-failed" };
      }
    }

    if (
      typeof rawPhp?.fileExists !== "function" ||
      typeof rawPhp?.isDir !== "function"
    ) {
      return { ok: true, mode: "fallback", files: [] };
    }

    let hasDataDir = false;
    try {
      hasDataDir =
        rawPhp.fileExists(NEXTCLOUD_DATA_DIR) &&
        rawPhp.isDir(NEXTCLOUD_DATA_DIR);
    } catch {
      return { ok: true, mode: "fallback", files: [] };
    }

    if (!hasDataDir) {
      return { ok: true, mode: "fallback", files: [] };
    }

    const fallback = collectFilesBounded(
      rawPhp,
      NEXTCLOUD_DATA_DIR,
      maxCrashDataDirBytes,
    );
    if (fallback.exceeded) {
      postShell({
        kind: "error",
        detail: `[snapshot] bounded data-dir fallback exceeds ${formatKB(maxCrashDataDirBytes)}KB; skipping live snapshot`,
      });
      return { ok: false, mode: "fallback", reason: "size-limit" };
    }

    postShell({
      kind: "trace",
      detail: `[snapshot] saved bounded data-dir fallback (${fallback.files.length} entries, ${formatKB(fallback.totalBytes)}KB)`,
    });
    return { ok: true, mode: "fallback", files: fallback.files };
  }

  return {
    /**
     * Read the DB file and addon directories from the (possibly crashed)
     * runtime before it is destroyed.
     */
    async hydrate(php, dbPath) {
      savedDbSnapshot = null;
      savedAddonFiles = null;
      savedDataDirFiles = null;
      const rawPhp = php._php;
      const effectiveDbPath = dbPath || PLAYGROUND_DB_PATH;
      const dataDirCheckpoint = await prepareDataDirCheckpoint(php, rawPhp);

      if (!dataDirCheckpoint.ok) {
        return {
          captured: false,
          reason: dataDirCheckpoint.reason || "data-dir-checkpoint-failed",
        };
      }

      if (
        dataDirCheckpoint.mode === "fallback" &&
        dataDirCheckpoint.files.length > 0
      ) {
        savedDataDirFiles = dataDirCheckpoint.files;
      }

      // 1. Save the DB file only after the data dir reached the same checkpoint.
      try {
        const data = rawPhp.readFileAsBuffer(effectiveDbPath);
        if (data && data.byteLength > 0) {
          savedDbSnapshot = {
            path: effectiveDbPath,
            data: new Uint8Array(data),
          };
          postShell({
            kind: "trace",
            detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
          });
        }
      } catch (err) {
        savedDbSnapshot = null;
        savedAddonFiles = null;
        savedDataDirFiles = null;
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}; using the last persisted checkpoint`,
        });
        return { captured: false, reason: "db-read-failed" };
      }

      // 2. Save files from addon directories installed during this session
      if (installedAddonDirs.size > 0) {
        const allFiles = [];
        for (const dir of installedAddonDirs) {
          try {
            if (!rawPhp.fileExists(dir)) continue;
            const files = collectFiles(rawPhp, dir);
            if (files.length > 0) {
              allFiles.push(...files);
            }
          } catch (err) {
            postShell({
              kind: "error",
              detail: `[snapshot] failed to read addon dir ${dir}: ${err.message}`,
            });
          }
        }
        if (allFiles.length > 0) {
          savedAddonFiles = allFiles;
          postShell({
            kind: "trace",
            detail: `[snapshot] saved ${allFiles.length} addon files`,
          });
        }
      }

      return { captured: true, dataDirMode: dataDirCheckpoint.mode };
    },

    /**
     * Restore the saved DB and addon files onto a fresh runtime.
     */
    async restore(php) {
      if (!savedDbSnapshot && !savedAddonFiles && !savedDataDirFiles) {
        return { restored: false, addonsRestored: false };
      }
      const rawPhp = php._php;
      let restored = false;
      let addonsRestored = false;

      if (savedDbSnapshot) {
        try {
          rawPhp.writeFile(savedDbSnapshot.path, savedDbSnapshot.data);
          postShell({
            kind: "trace",
            detail: `[snapshot] restored DB (${savedDbSnapshot.data.byteLength} bytes)`,
          });
          restored = true;
        } catch (err) {
          postShell({
            kind: "error",
            detail: `[snapshot] failed to restore DB: ${err.message}`,
          });
        }
        savedDbSnapshot = null;
      }

      if (savedAddonFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedAddonFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} addon files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
          addonsRestored = true;
        }
        savedAddonFiles = null;
      }

      if (savedDataDirFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedDataDirFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} data-dir fallback files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
        }
        savedDataDirFiles = null;
      }

      return { restored, addonsRestored };
    },

    get hasPendingRestore() {
      return (
        savedDbSnapshot !== null ||
        savedAddonFiles !== null ||
        savedDataDirFiles !== null
      );
    },

    trackAddonDir(dirPath) {
      installedAddonDirs.add(dirPath);
      postShell({
        kind: "trace",
        detail: `[snapshot] tracking installed addon: ${dirPath}`,
      });
    },

    clear() {
      savedDbSnapshot = null;
      savedAddonFiles = null;
      savedDataDirFiles = null;
    },
  };
}
