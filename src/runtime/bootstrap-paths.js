// Filesystem layout for the Nextcloud Playground runtime (inside the WASM VFS).
//
// The readonly Nextcloud core is extracted into NEXTCLOUD_ROOT (MEMFS). The
// SQLite database and the data directory live under the core's data/ dir, and
// config.php is written by `occ maintenance:install` into config/. State is
// ephemeral by design (MEMFS resets on reload), matching the sibling
// playgrounds.

export const NEXTCLOUD_ROOT = "/www/nextcloud";
export const NEXTCLOUD_DATA_DIR = "/www/nextcloud/data";
export const NEXTCLOUD_CONFIG_DIR = "/www/nextcloud/config";

// Roots journaled to IndexedDB by fs-persistence.js and restored on reload.
// Everything else (core, apps/, /tmp) is rebuilt on each boot.
export const MUTABLE_PATH_PREFIXES = [
  "/persist",
  NEXTCLOUD_CONFIG_DIR,
  NEXTCLOUD_DATA_DIR,
];

export function isMutablePath(path) {
  return MUTABLE_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

// Nextcloud's default SQLite database filename inside the data directory.
export const PLAYGROUND_DB_PATH = "/www/nextcloud/data/owncloud.db";

// Small JSON marker recording what was installed, so a warm reload can skip
// reinstalling when the bundle version matches.
export const PLAYGROUND_CONFIG_PATH = "/persist/playground-state.json";

// posix polyfill + $_SERVER defaults, loaded via php.ini auto_prepend_file.
export const PLAYGROUND_PREPEND_PATH = "/internal/shared/auto_prepend_file.php";
