import {
  NEXTCLOUD_CONFIG_DIR,
  NEXTCLOUD_DATA_DIR,
  NEXTCLOUD_ROOT,
} from "./bootstrap-paths.js";

const escapePhp = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

/**
 * PHP run as the MAIN script (code mode, no REQUEST_URI → OC::$CLI === true via
 * the wasm base.php patch) that drives `occ maintenance:install` against SQLite.
 *
 * occ itself cannot be required directly — its `#!/usr/bin/env php` shebang
 * breaks the `declare(strict_types=1)` "first statement" rule — so we replicate
 * what occ does after dropPrivileges(): set $_SERVER['argv'] and require
 * console.php. See docs/feasibility-spike.md.
 */
export function buildOccInstallScript(config) {
  const admin = config.admin || {};
  const argv = [
    "occ",
    "maintenance:install",
    "--database",
    "sqlite",
    "--database-name",
    "nextcloud",
    "--admin-user",
    String(admin.username || "admin"),
    "--admin-pass",
    String(admin.password || "admin"),
    "--admin-email",
    String(admin.email || "admin@example.com"),
    "--data-dir",
    NEXTCLOUD_DATA_DIR,
  ];
  return buildOccScript(argv);
}

/** Build a generic occ invocation wrapper (code-mode, CLI semantics). */
export function buildOccScript(argv, env = {}) {
  const json = JSON.stringify(argv);
  const envLines = Object.entries(env)
    .map(([k, v]) => `putenv('${escapePhp(k)}=${escapePhp(v)}');`)
    .join("\n");
  return `<?php
${envLines}
$_SERVER['argv'] = ${json};
$_SERVER['argc'] = ${argv.length};
$argv = $_SERVER['argv'];
$argc = $_SERVER['argc'];
unset($_SERVER['REQUEST_URI']);
chdir('${NEXTCLOUD_ROOT}');
require '${NEXTCLOUD_ROOT}/console.php';
`;
}

/**
 * Extract a downloaded app ZIP into apps/<appId> using PHP's ZipArchive instead
 * of decompressing the whole archive in JavaScript.
 *
 * Why: the JS path (fflate `unzipSync` + `writeEntriesToPhp`) decompresses every
 * entry into JS memory at once and then holds the whole decompressed tree while
 * copying it into MEMFS. For a large app (the ~70MB / 3000+ file eXeLearning
 * editor) that peak exhausts memory on constrained clients, leaving a partial
 * install (missing files 404 at runtime). libzip's `extractTo()` inflates and
 * writes one entry at a time, so the peak stays ~one entry — the same approach
 * moodle-playground uses for its editor. The zip is already written to MEMFS by
 * the caller; we read it from there.
 *
 * Contract: prints exactly one sentinel on stdout:
 *   - `NO_ZIP_EXT`            → the build lacks ext/zip; caller falls back to JS.
 *   - `INSTALL_OK <count>`    → extracted <count> entries into apps/<appId>.
 *   - `INSTALL_ERR <message>` → anything else; caller falls back to JS.
 * On success the temp zip is removed; on failure it is left in place so the JS
 * fallback can read it back without re-downloading.
 */
export function buildZipExtractScript(appId, zipPath, stagePath) {
  const zip = escapePhp(zipPath);
  const stage = escapePhp(stagePath);
  const target = escapePhp(`${NEXTCLOUD_ROOT}/apps/${appId}`);
  return `<?php
echo (function () {
  $zipPath = '${zip}';
  $stage = '${stage}';
  $target = '${target}';
  if (!class_exists('ZipArchive')) { return 'NO_ZIP_EXT'; }
  $rrmdir = function ($dir) use (&$rrmdir) {
    if (!is_dir($dir)) { return; }
    foreach (scandir($dir) as $e) {
      if ($e === '.' || $e === '..') { continue; }
      $p = $dir . '/' . $e;
      is_dir($p) ? $rrmdir($p) : @unlink($p);
    }
    @rmdir($dir);
  };
  $findRoot = function ($base) use (&$findRoot) {
    if (is_file($base . '/appinfo/info.xml')) { return $base; }
    foreach (scandir($base) as $e) {
      if ($e === '.' || $e === '..') { continue; }
      $p = $base . '/' . $e;
      if (is_dir($p)) { $r = $findRoot($p); if ($r !== null) { return $r; } }
    }
    return null;
  };
  try {
    $rrmdir($stage);
    @mkdir($stage, 0777, true);
    $zip = new ZipArchive();
    $rc = $zip->open($zipPath);
    if ($rc !== true) { $rrmdir($stage); return 'INSTALL_ERR open=' . $rc; }
    $ok = $zip->extractTo($stage);
    $count = $zip->numFiles;
    $zip->close();
    if (!$ok) { $rrmdir($stage); return 'INSTALL_ERR extract'; }
    $src = $findRoot($stage);
    if ($src === null) { $rrmdir($stage); return 'INSTALL_ERR no_appinfo'; }
    $rrmdir($target);
    @mkdir(dirname($target), 0777, true);
    if (!@rename($src, $target)) { $rrmdir($stage); return 'INSTALL_ERR rename'; }
    $rrmdir($stage);
    @unlink($zipPath);
    return 'INSTALL_OK ' . $count;
  } catch (\\Throwable $e) {
    $rrmdir($stage);
    return 'INSTALL_ERR ' . $e->getMessage();
  }
})();
`;
}

/**
 * Post-install: merge the playground-required system config keys into the
 * config.php written by occ. We rewrite the file directly (read $CONFIG,
 * merge, var_export back) rather than spawning N occ processes.
 *
 * - trusted_domains: include the playground host so Nextcloud serves the UI.
 * - enabledPreviewProviders: [] — preview generation needs proc_open (impossible
 *   in WASM).
 * - filelocking.enabled: false — flock is unreliable under Emscripten.
 * - check_data_directory_permissions: false — the VFS has no real ownership.
 */
export function buildPostInstallConfigScript(config) {
  const host = escapePhp(config.runtimeHost || "localhost");
  const baseUrl = escapePhp(config.runtimeBaseUrl || "http://localhost/");
  const loglevel = config.debug?.enabled ? 0 : 2;
  return `<?php
$configFile = '${NEXTCLOUD_CONFIG_DIR}/config.php';
$CONFIG = [];
require $configFile;
$domains = $CONFIG['trusted_domains'] ?? [];
foreach (['localhost', '${host}'] as $d) {
    if ($d !== '' && !in_array($d, $domains, true)) { $domains[] = $d; }
}
$CONFIG['trusted_domains'] = array_values($domains);
$CONFIG['overwrite.cli.url'] = '${baseUrl}';
// Do NOT force overwriteprotocol: forcing 'https' would mark the session cookie
// Secure, which the browser drops over http://localhost — breaking login.
// Let Nextcloud detect the scheme per request instead.
$CONFIG['enabledPreviewProviders'] = [];
$CONFIG['filelocking.enabled'] = false;
$CONFIG['check_data_directory_permissions'] = false;
$CONFIG['loglevel'] = ${loglevel};
$CONFIG['log_type'] = 'errorlog';
$CONFIG['appstoreenabled'] = false;
$CONFIG['updatechecker'] = false;
$CONFIG['has_internet_connection'] = false;
file_put_contents($configFile, "<?php\\n\\$CONFIG = " . var_export($CONFIG, true) . ";\\n");
echo 'CONFIG_OK';
`;
}
