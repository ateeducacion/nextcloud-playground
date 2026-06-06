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
$CONFIG['skeletondirectory'] = '';
$CONFIG['loglevel'] = ${loglevel};
$CONFIG['log_type'] = 'errorlog';
$CONFIG['appstoreenabled'] = false;
$CONFIG['updatechecker'] = false;
$CONFIG['has_internet_connection'] = false;
file_put_contents($configFile, "<?php\\n\\$CONFIG = " . var_export($CONFIG, true) . ";\\n");
echo 'CONFIG_OK';
`;
}
