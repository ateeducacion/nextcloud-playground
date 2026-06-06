#!/usr/bin/env node
/**
 * Phase 0 feasibility spike: boot Nextcloud 31 under php-wasm (PHP 8.3) in Node.
 *
 *  1. Load the PHP 8.3 WASM runtime (@php-wasm/node) with intl.
 *  2. Mount the extracted Nextcloud source (host dir) into the VFS via NODEFS.
 *  3. Install a posix polyfill via auto_prepend_file.
 *  4. Run `occ maintenance:install` against SQLite (CLI mode).
 *  5. Request status.php and the login page (web mode) to confirm rendering.
 *
 * SAPI is "wasm": base.php is patched so wasm-without-REQUEST_URI == CLI.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PHP, setPhpIniEntries } from "@php-wasm/universal";
import { createNodeFsMountHandler, loadNodeRuntime } from "@php-wasm/node";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const NC_HOST = resolve(repo, ".cache/nextcloud-source/nextcloud");
const NC_VFS = "/www/nextcloud";
const DATA_DIR = "/www/data";
const PREPEND_VFS = "/internal/prepend.php";

const banner = (t) => console.log(`\n${"=".repeat(70)}\n${t}\n${"=".repeat(70)}`);
const decode = (b) => new TextDecoder().decode(b);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

banner("Phase 0 spike — Nextcloud 31 on php-wasm (PHP 8.3)");

const php = new PHP(
  await loadNodeRuntime("8.3", {
    extensions: ["intl"],
    emscriptenOptions: { processId: 1 },
  }),
);
console.log(`[${el()}s] PHP 8.3 runtime loaded (intl)`);

php.mkdirTree("/www");
php.mkdirTree("/internal");
php.mkdirTree(DATA_DIR);
php.mkdirTree("/tmp");
await php.mount(NC_VFS, createNodeFsMountHandler(NC_HOST));
console.log(`[${el()}s] Mounted ${NC_HOST} -> ${NC_VFS}`);

php.writeFile(PREPEND_VFS, readFileSync(resolve(here, "prepend.php")));

await setPhpIniEntries(php, {
  memory_limit: "1024M",
  max_execution_time: "0",
  display_errors: "On",
  error_reporting: "E_ALL",
  "date.timezone": "UTC",
  auto_prepend_file: PREPEND_VFS,
  "session.save_path": "/tmp",
  upload_tmp_dir: "/tmp",
});

/**
 * Run a CLI command through occ via $_SERVER['argv'].
 * We can't `require` occ directly (its `#!/usr/bin/env php` shebang would be
 * emitted as text, breaking the `declare(strict_types=1)` "must be first"
 * rule). Instead run a shebang-free wrapper as the MAIN script that sets argv
 * and requires console.php (what occ does after dropPrivileges()).
 */
async function occ(argv, label) {
  banner(`occ ${argv.join(" ")}`);
  const wrapper = `<?php
$_SERVER['argv'] = ${JSON.stringify(["occ", ...argv])};
$_SERVER['argc'] = ${argv.length + 1};
$argv = $_SERVER['argv']; $argc = $_SERVER['argc'];
unset($_SERVER['REQUEST_URI']);
chdir(${JSON.stringify(NC_VFS)});
require ${JSON.stringify(`${NC_VFS}/console.php`)};
`;
  php.writeFile("/tmp/__occ_run.php", wrapper);
  let res;
  try {
    res = await php.run({ scriptPath: "/tmp/__occ_run.php" });
  } catch (e) {
    console.error(`${label} threw:`, e?.message || e);
    console.error(String(e?.stack || "").split("\n").slice(0, 6).join("\n"));
    return { ok: false, exitCode: -1 };
  }
  console.log(`[${el()}s] exitCode=${res.exitCode}`);
  const out = decode(res.bytes);
  if (out.trim()) console.log("--- stdout ---\n" + out.slice(0, 4000));
  if (res.errors?.trim()) console.log("--- stderr ---\n" + res.errors.slice(0, 4000));
  return { ok: res.exitCode === 0, exitCode: res.exitCode, out };
}

/** Run a web request through a front controller in web mode. */
async function web(scriptPath, requestUri, pathInfo) {
  banner(`GET ${requestUri}`);
  const $_SERVER = {
    REQUEST_URI: requestUri,
    REQUEST_METHOD: "GET",
    SCRIPT_NAME: scriptPath.replace(NC_VFS, ""),
    SCRIPT_FILENAME: scriptPath,
    DOCUMENT_ROOT: NC_VFS,
    HTTP_HOST: "localhost",
    SERVER_NAME: "localhost",
    SERVER_PORT: "80",
    HTTPS: "",
    REMOTE_ADDR: "127.0.0.1",
  };
  if (pathInfo) $_SERVER.PATH_INFO = pathInfo;
  let res;
  try {
    res = await php.run({ scriptPath, $_SERVER, method: "GET" });
  } catch (e) {
    console.error(`request threw:`, e?.message || e);
    return { ok: false };
  }
  const body = decode(res.bytes);
  console.log(`[${el()}s] HTTP ${res.httpStatusCode} bytes=${res.bytes.byteLength}`);
  console.log(body.slice(0, 1200));
  if (res.errors?.trim()) console.log("--- stderr ---\n" + res.errors.slice(0, 2000));
  return { ok: true, code: res.httpStatusCode, body };
}

// ── Step 1: install ─────────────────────────────────────────────────────────
const install = await occ(
  [
    "maintenance:install",
    "--database", "sqlite",
    "--database-name", "nextcloud",
    "--admin-user", "admin",
    "--admin-pass", "admin",
    "--admin-email", "admin@example.com",
    "--data-dir", DATA_DIR,
  ],
  "install",
);

let installedFlag = false;
try {
  installedFlag = decode(php.readFileAsBuffer(`${NC_VFS}/config/config.php`)).includes(
    "'installed' => true",
  );
} catch {}
console.log("config.php has installed=true:", installedFlag);

// ── Step 2: status.php ──────────────────────────────────────────────────────
const status = await web(`${NC_VFS}/status.php`, "/status.php", null);
const statusOk = status.ok && status.code === 200 && /installed/.test(status.body || "");

// ── Step 3: login page ──────────────────────────────────────────────────────
const login = await web(`${NC_VFS}/index.php`, "/index.php/login", "/login");
const loginOk = login.ok && [200, 302, 303].includes(login.code);

banner("SPIKE RESULT");
console.log("occ install exit   :", install.exitCode);
console.log("installed=true     :", installedFlag);
console.log("status.php 200+json:", statusOk);
console.log("login render ok    :", loginOk);
console.log(`total: ${el()}s`);
process.exit(installedFlag && statusOk ? 0 : 1);
