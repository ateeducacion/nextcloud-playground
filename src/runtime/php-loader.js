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

// Scripts OPcache must never cache. php.run({ code }) writes every snippet to
// the same /internal/eval.php, so a stored .bin would be served for a later,
// different snippet. The blacklist is honoured on store in file-cache-only mode.
// Same decision as moodle-playground ADR-0038:
// https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0038-opcache-file-cache-timestamp-validation.md
const OPCACHE_BLACKLIST_PATH = "/internal/shared/opcache-blacklist.txt";
const OPCACHE_BLACKLIST = "/internal/eval.php\n";

// php-src <= 8.4 starts OPcache only for whitelisted SAPI names (apache,
// fastcgi, cli-server, cgi-fcgi, fpm-fcgi, fpmi-fcgi, apache2handler, litespeed,
// uwsgi, fuzzer, frankenphp, ngx-php); php-wasm reports `wasm`. With the
// `opcache` option (on by default) the runtime reports `uwsgi`: Nextcloud 33 has
// no reference to it, while the cgi*/fpm names take different code paths. The
// bundle patches in scripts/build-nextcloud-bundle.sh accept this name next to
// `wasm`; keep both in sync. Same decision as moodle-playground ADR-0039:
// https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0039-experimental-opcache-via-sapi-name.md
const OPCACHE_SAPI_NAME = "uwsgi";

function buildPhpIniEntries() {
  return {
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
    // OPcache file cache in /internal/shared/opcache. PHP <= 8.4 never starts
    // OPcache under the `wasm` SAPI, but PHP 8.5 dropped the SAPI whitelist and
    // runs this cache for real, and files do change within a session (app
    // install, blueprint writeFile/unzip). In file-cache-only mode
    // opcache_reset()/opcache_invalidate() are no-ops, so the mtime check
    // (whole seconds, with PHP's default 2 s file_update_protection) is the only
    // invalidation: validate_timestamps must stay on. See docs/KNOWN-ISSUES.md#opcache.
    // NOTE: with file_cache_only=1 OPcache allocates no shared memory segment, so
    // max_accelerated_files / memory_consumption / interned_strings_buffer are
    // inert here; kept for the day a shared-memory backend exists.
    "opcache.enable": "1",
    "opcache.file_cache": "/internal/shared/opcache",
    "opcache.file_cache_only": "1",
    "opcache.max_accelerated_files": "10000",
    "opcache.memory_consumption": "128",
    "opcache.interned_strings_buffer": "32",
    "opcache.jit": "0",
    "opcache.validate_timestamps": "1",
    "opcache.revalidate_freq": "0",
    "opcache.blacklist_filename": OPCACHE_BLACKLIST_PATH,
    "opcache.file_cache_consistency_checks": "0",
  };
}

// PHP reads opcache.blacklist_filename at startup, so the file has to exist
// before the first request of every runtime instance.
function writeOpcacheBlacklist(php, FS) {
  try {
    FS.mkdirTree("/internal/shared");
  } catch {
    /* exists */
  }
  php.writeFile(OPCACHE_BLACKLIST_PATH, OPCACHE_BLACKLIST);
}

// Indirection so unit tests can supply a fake runtime: Node cannot load the
// browser WASM build. Production always uses these defaults.
const runtimeDeps = {
  loadWebRuntime,
  createPhp: (runtimeId) => new PHP(runtimeId),
};

export const __testing = {
  runtimeDeps,
  buildPhpIniEntries,
  writeOpcacheBlacklist,
  OPCACHE_BLACKLIST_PATH,
  OPCACHE_BLACKLIST,
  OPCACHE_SAPI_NAME,
};

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
    opcache = false,
  } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  let wrapped = null;
  let persistenceController = null;

  const deferred = {
    async refresh() {
      const resolvedCorsProxyUrl = corsProxyUrl ?? phpCorsProxyUrl ?? null;
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await runtimeDeps.loadWebRuntime(resolvedPhpVersion, {
        tcpOverFetch,
        // Nextcloud strongly benefits from intl (translations, collation). It
        // is not in the base build but is available as a loadable extension.
        extensions: ["intl"],
        emscriptenOptions: {
          INITIAL_MEMORY: 128 * 1024 * 1024,
          ALLOW_MEMORY_GROWTH: 1,
        },
      });
      const php = runtimeDeps.createPhp(runtimeId);
      const FS = php[__private__dont__use].FS;
      persistenceController = null;

      if (opcache) {
        // Must precede the first request; php-wasm re-applies the name on a
        // runtime hot-swap. See docs/KNOWN-ISSUES.md#opcache.
        await php.setSapiName(OPCACHE_SAPI_NAME);
      }

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
        const { clearJournal, dropLegacyOpcacheJournals, initFsPersistence } =
          await import("./fs-persistence.js");
        // On a clean boot (reset / blueprint change), wipe the old journal
        // first; then ALWAYS start journaling so the fresh env persists on later
        // reloads (a same-blueprint reload then reuses it, no reinstall).
        if (forceCleanBoot) {
          await clearJournal(scopeId);
        }
        // OPcache bytecode is no longer persisted; drop stores older sessions left.
        dropLegacyOpcacheJournals(resolvedPhpVersion);
        persistenceController = await initFsPersistence(php, scopeId);
      }

      // The default auto_prepend_file at /internal/shared/auto_prepend_file.php
      // is written by bootstrap.js with the playground prepend (posix polyfill,
      // $_SERVER vars). Do NOT empty it here.

      writeOpcacheBlacklist(php, FS);

      await setPhpIniEntries(php, buildPhpIniEntries());

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
    async flushPersistence(options = {}) {
      if (!persistenceController) {
        return {
          enabled: false,
          ok: true,
          flushedOps: 0,
          hydratedBytes: 0,
          estimatedBytes: 0,
        };
      }

      return {
        enabled: true,
        ...(await persistenceController.flushNow(options)),
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}
