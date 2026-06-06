#!/usr/bin/env node
/**
 * Integration validation: boot the BUILT, trimmed Nextcloud bundle the same way
 * the browser does — extract the ZIP into MEMFS via the real loader, apply the
 * real runtime modules (posix prepend + occ install script), then install and
 * render the login page.
 *
 * Unlike spike/run-spike.mjs (which NODEFS-mounts the raw source), this proves:
 *   1. the build pipeline output is correct and WASM-patched, and
 *   2. the trimmed bundle fits + works in MEMFS (the browser memory model).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __private__dont__use, PHP, setPhpIniEntries } from "@php-wasm/universal";
import { loadNodeRuntime } from "@php-wasm/node";
import {
  extractZipEntries,
  writeEntriesToPhp,
} from "../lib/nextcloud-loader.js";
import { buildPhpPrepend } from "../src/runtime/php-prepend.js";
import {
  buildOccInstallScript,
  buildPostInstallConfigScript,
} from "../src/runtime/install-script.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const MAJOR = process.env.NC_MAJOR || "31";
const NC_ROOT = "/www/nextcloud";
const PREPEND = "/internal/shared/auto_prepend_file.php";

const banner = (t) => console.log(`\n${"=".repeat(68)}\n${t}\n${"=".repeat(68)}`);
const decode = (b) => new TextDecoder().decode(b);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

const manifest = JSON.parse(
  readFileSync(resolve(repo, `assets/manifests/nextcloud-${MAJOR}.json`), "utf8"),
);
// manifest.bundle.path is relative to the manifests directory.
const bundlePath = resolve(repo, "assets/manifests", manifest.bundle.path);
banner(`Booting built bundle: ${manifest.bundle.path} (release ${manifest.release})`);

const php = new PHP(
  await loadNodeRuntime("8.3", {
    extensions: ["intl"],
    emscriptenOptions: { processId: 1 },
  }),
);
const FS = php[__private__dont__use].FS;
console.log(`[${el()}s] runtime loaded`);

// Extract the ZIP into MEMFS via the real loader (the browser code path).
const zipBytes = readFileSync(bundlePath);
const entries = extractZipEntries(new Uint8Array(zipBytes));
console.log(`[${el()}s] zip entries: ${entries.length}`);
FS.mkdirTree(NC_ROOT);
writeEntriesToPhp({ FS }, entries, NC_ROOT);
console.log(`[${el()}s] extracted into MEMFS`);

for (const d of [`${NC_ROOT}/data`, `${NC_ROOT}/config`, "/internal/shared", "/tmp"]) {
  try {
    FS.mkdirTree(d);
  } catch {}
}

php.writeFile(PREPEND, buildPhpPrepend());
await setPhpIniEntries(php, {
  auto_prepend_file: PREPEND,
  memory_limit: "512M",
  max_execution_time: "0",
  "date.timezone": "UTC",
  display_errors: "Off",
  "session.save_path": "/tmp",
});

// ── install ──────────────────────────────────────────────────────────────────
banner("occ maintenance:install (from built bundle, in MEMFS)");
const installCfg = { admin: { username: "admin", password: "admin", email: "admin@example.com" } };
const ir = await php.run({ code: buildOccInstallScript(installCfg) });
console.log(`[${el()}s] install exit=${ir.exitCode}`);
const installOut = decode(ir.bytes);
console.log(installOut.split("\n").filter((l) => /install|error|exception/i.test(l)).slice(0, 5).join("\n"));

let installed = false;
try {
  installed = decode(php.readFileAsBuffer(`${NC_ROOT}/config/config.php`)).includes("'installed' => true");
} catch {}
console.log("installed=true:", installed);

banner("post-install config");
const cr = await php.run({ code: buildPostInstallConfigScript({ runtimeHost: "localhost", debug: {} }) });
console.log("config:", decode(cr.bytes).slice(0, 40));

// ── full login flow with a cookie jar (mirrors the browser) ──────────────────
const cookies = new Map();
function mergeSetCookie(headers) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === "set-cookie");
  for (const h of key ? headers[key] : []) {
    const first = h.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(h)) cookies.delete(name);
    else cookies.set(name, value);
    if (/;\s*secure/i.test(h)) console.log(`  [warn] cookie ${name} is Secure (dropped over http!)`);
  }
}
function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function baseServer(uri, pathInfo) {
  return {
    REQUEST_URI: uri,
    SCRIPT_NAME: "/index.php",
    SCRIPT_FILENAME: `${NC_ROOT}/index.php`,
    DOCUMENT_ROOT: NC_ROOT,
    PATH_INFO: pathInfo,
    HTTP_HOST: "localhost",
    SERVER_NAME: "localhost",
    SERVER_PORT: "80",
    SERVER_PROTOCOL: "HTTP/1.1",
    REMOTE_ADDR: "127.0.0.1",
    HTTPS: "",
    HTTP_COOKIE: cookieHeader(),
  };
}

banner("GET /index.php/login");
const lr = await php.run({
  scriptPath: `${NC_ROOT}/index.php`,
  method: "GET",
  $_SERVER: { ...baseServer("/index.php/login", "/login"), REQUEST_METHOD: "GET" },
});
mergeSetCookie(lr.headers);
const body = decode(lr.bytes);
const loginRenderOk = lr.httpStatusCode === 200 && /Nextcloud/.test(body);
const token = (body.match(/data-requesttoken="([^"]+)"/) || body.match(/<input[^>]+name="requesttoken"[^>]+value="([^"]+)"/) || [])[1];
console.log(`[${el()}s] HTTP ${lr.httpStatusCode} bytes=${lr.bytes.byteLength} token=${token ? "yes" : "NO"} cookies=${[...cookies.keys()].join(",")}`);

banner("POST /index.php/login (admin/admin)");
const form = new URLSearchParams({
  user: "admin",
  password: "admin",
  requesttoken: token || "",
  timezone: "UTC",
  timezone_offset: "0",
}).toString();
const pr = await php.run({
  scriptPath: `${NC_ROOT}/index.php`,
  method: "POST",
  body: form,
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
  $_SERVER: {
    ...baseServer("/index.php/login", "/login"),
    REQUEST_METHOD: "POST",
    CONTENT_TYPE: "application/x-www-form-urlencoded",
    CONTENT_LENGTH: String(Buffer.byteLength(form)),
  },
});
mergeSetCookie(pr.headers);
const locKey = Object.keys(pr.headers || {}).find((k) => k.toLowerCase() === "location");
const location = locKey ? pr.headers[locKey][0] : "";
console.log(`[${el()}s] HTTP ${pr.httpStatusCode} location=${location}`);
if (pr.errors?.trim()) console.log("stderr:", pr.errors.split("\n").filter((l) => /error|exception|login/i.test(l)).slice(0, 3).join("\n"));
const loginSuccess = !!location && !/\/login(\?|$)/.test(location);

banner("GET dashboard with session");
const target = loginSuccess ? location.replace(/^https?:\/\/[^/]+/, "") : "/index.php/apps/dashboard";
const pinfo = (target.match(/index\.php(\/[^?]*)/) || [, "/"])[1].split("?")[0];
const dr = await php.run({
  scriptPath: `${NC_ROOT}/index.php`,
  method: "GET",
  $_SERVER: { ...baseServer(target, pinfo), REQUEST_METHOD: "GET" },
});
const dbody = decode(dr.bytes);
const dashTitle = (dbody.match(/<title>[\s\S]*?<\/title>/) || [""])[0].replace(/\s+/g, " ").trim();
const loggedIn = dr.httpStatusCode === 200 && !/\/login/.test(dashTitle) && !/Login –/.test(dashTitle);
console.log(`[${el()}s] HTTP ${dr.httpStatusCode} title: ${dashTitle}`);

banner("RESULT");
console.log("installed        :", installed);
console.log("login render ok  :", loginRenderOk);
console.log("login POST ok    :", loginSuccess, location ? `→ ${location}` : "");
console.log("dashboard logged :", loggedIn);
console.log(`total: ${el()}s`);
process.exit(installed && loginRenderOk && loginSuccess ? 0 : 1);
