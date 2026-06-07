import {
  __private__dont__use,
  PHP,
  setPhpIniEntries,
} from "@php-wasm/universal";
import {
  certificateToPEM,
  generateCertificate,
  loadWebRuntime,
} from "@php-wasm/web";
import { NEXTCLOUD_ROOT } from "./bootstrap.js";
import { wrapPhpInstance } from "./php-compat.js";
import { createPlaygroundSpawnHandler } from "./spawn-handler.js";

const PERSIST_ROOT = "/persist";
const TEMP_ROOT = "/tmp";
const CONFIG_ROOT = "/config";
const DEFAULT_PHP_VERSION = "8.3";

const TCP_OVER_FETCH_CA_PATH = "/internal/shared/playground-ca.pem";
let cachedTcpOverFetchCaPromise = null;

async function getTcpOverFetchOptions(corsProxyUrl) {
  if (!cachedTcpOverFetchCaPromise) {
    cachedTcpOverFetchCaPromise = generateCertificate({
      subject: {
        commonName: "Nextcloud Playground CA",
        organizationName: "Nextcloud Playground",
        countryName: "ES",
      },
      basicConstraints: { ca: true },
    });
  }
  return {
    CAroot: await cachedTcpOverFetchCaPromise,
    ...(corsProxyUrl ? { corsProxyUrl } : {}),
  };
}

export function createPhpRuntime(
  _runtime,
  {
    appBaseUrl,
    phpVersion,
    webRoot,
    scopeId,
    forceCleanBoot,
    corsProxyUrl,
    phpCorsProxyUrl,
  } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  let wrapped = null;

  const deferred = {
    async refresh() {
      const resolvedCorsProxyUrl = corsProxyUrl ?? phpCorsProxyUrl ?? null;
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await loadWebRuntime(resolvedPhpVersion, {
        tcpOverFetch,
        // Nextcloud strongly benefits from intl (translations, collation). It
        // is not in the base build but is available as a loadable extension.
        extensions: ["intl"],
      });
      const php = new PHP(runtimeId);
      const FS = php[__private__dont__use].FS;

      // Nextcloud shells out (BinaryFinder, previews, setup checks). Without a
      // spawn handler php-wasm throws an uncatchable error that aborts the
      // request and blanks the page. Degrade those commands gracefully.
      try {
        await php.setSpawnHandler(createPlaygroundSpawnHandler());
      } catch {}

      try {
        FS.mkdirTree(TEMP_ROOT);
      } catch {}
      try {
        FS.mkdirTree(NEXTCLOUD_ROOT);
      } catch {}
      try {
        FS.mkdirTree(PERSIST_ROOT);
      } catch {}
      try {
        FS.mkdirTree(CONFIG_ROOT);
      } catch {}

      // The php-wasm build has no OpenSSL config file at its default location
      // (/root/install/ssl/openssl.cnf). Without it every openssl_* call fails
      // with "configuration file routines:def_load:no such file", which breaks
      // Nextcloud's session/CSRF crypto (and therefore login). Create an empty
      // (valid) config so OpenSSL initializes cleanly.
      try {
        FS.mkdirTree("/root/install/ssl");
      } catch {}
      try {
        php.writeFile(
          "/root/install/ssl/openssl.cnf",
          "# nextcloud-playground: empty OpenSSL config\n",
        );
      } catch {}

      php.writeFile(
        TCP_OVER_FETCH_CA_PATH,
        `${certificateToPEM(tcpOverFetch.CAroot.certificate)}\n`,
      );

      // Replay/start fs-journal persistence for mutable paths.
      if (scopeId) {
        const { clearJournal, clearOpcacheJournal, initFsPersistence } =
          await import("./fs-persistence.js");
        // On a clean boot (reset / blueprint change), wipe the old journals
        // first; then ALWAYS start journaling so the fresh env persists on later
        // reloads (a same-blueprint reload then reuses it, no reinstall).
        if (forceCleanBoot) {
          await clearJournal(scopeId);
          await clearOpcacheJournal(resolvedPhpVersion);
        }
        await initFsPersistence(php, scopeId, resolvedPhpVersion);
      }

      // The default auto_prepend_file at /internal/shared/auto_prepend_file.php
      // is written by bootstrap.js with the playground prepend (posix polyfill,
      // $_SERVER vars). Do NOT empty it here.

      await setPhpIniEntries(php, {
        memory_limit: "256M",
        max_execution_time: "0",
        display_errors: "On",
        error_reporting: "E_ALL",
        "session.save_path": "/persist/mutable/session",
        upload_tmp_dir: "/tmp",
        default_socket_timeout: "1",
        "date.timezone": "UTC",
        "openssl.cafile": TCP_OVER_FETCH_CA_PATH,
        "curl.cainfo": TCP_OVER_FETCH_CA_PATH,
        // OPcache tuning — defaults cap at 1000 files and use file_cache_only
        // which reads bytecode from MEMFS on every request.  Switch to the
        // in-memory cache with a higher file limit and no timestamp checks
        // (the readonly bundle never changes within a session).
        "opcache.enable": "1",
        "opcache.file_cache": "/internal/shared/opcache",
        "opcache.file_cache_only": "1",
        "opcache.max_accelerated_files": "10000",
        "opcache.memory_consumption": "128",
        "opcache.interned_strings_buffer": "32",
        "opcache.validate_timestamps": "0",
        "opcache.file_cache_consistency_checks": "0",
      });

      try {
        FS.mkdirTree("/internal/shared/preload");
      } catch {}

      const absoluteUrl = (appBaseUrl || "http://localhost:8080").replace(
        /\/$/u,
        "",
      );
      wrapped = wrapPhpInstance(php, {
        syncFs: null,
        absoluteUrl,
        webRoot: webRoot || NEXTCLOUD_ROOT,
      });

      for (const key of Object.keys(wrapped)) {
        if (key !== "refresh") {
          deferred[key] = wrapped[key];
        }
      }

      Object.defineProperty(deferred, "binary", {
        get() {
          return wrapped.binary;
        },
        configurable: true,
      });
      Object.defineProperty(deferred, "_php", {
        get() {
          return wrapped._php;
        },
        configurable: true,
      });
    },
    async request() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async analyzePath() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async mkdir() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async writeFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async readFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async run() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}
