#!/usr/bin/env node
/** Validate server-side autologin: install → autologin request → dashboard logged in. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __private__dont__use, PHP, setPhpIniEntries } from "@php-wasm/universal";
import { loadNodeRuntime } from "@php-wasm/node";
import { extractZipEntries, writeEntriesToPhp } from "../lib/nextcloud-loader.js";
import { buildPhpPrepend } from "../src/runtime/php-prepend.js";
import { buildOccInstallScript, buildPostInstallConfigScript } from "../src/runtime/install-script.js";
import { buildAutologinScript } from "../src/runtime/autologin-script.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const NC = "/www/nextcloud";
const decode = (b) => new TextDecoder().decode(b);
const manifest = JSON.parse(readFileSync(resolve(repo, "assets/manifests/nextcloud-31.json"), "utf8"));
const bundlePath = resolve(repo, "assets/manifests", manifest.bundle.path);

const php = new PHP(await loadNodeRuntime("8.3", { extensions: ["intl"], emscriptenOptions: { processId: 1 } }));
const FS = php[__private__dont__use].FS;
FS.mkdirTree(NC);
writeEntriesToPhp({ FS }, extractZipEntries(new Uint8Array(readFileSync(bundlePath))), NC);
for (const d of [`${NC}/data`, `${NC}/config`, "/internal/shared", "/tmp", "/root/install/ssl"]) { try { FS.mkdirTree(d); } catch {} }
php.writeFile("/root/install/ssl/openssl.cnf", "# nextcloud-playground\n");
php.writeFile("/internal/shared/auto_prepend_file.php", buildPhpPrepend());
await setPhpIniEntries(php, { auto_prepend_file: "/internal/shared/auto_prepend_file.php", memory_limit: "512M", "date.timezone": "UTC", display_errors: "Off", "session.save_path": "/tmp" });
const cfg = { admin: { username: "admin", password: "admin", email: "a@e.com" } };
await php.run({ code: buildOccInstallScript(cfg) });
await php.run({ code: buildPostInstallConfigScript({ runtimeHost: "localhost", debug: {} }) });

const cookies = new Map();
function mergeSetCookie(headers) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === "set-cookie");
  for (const h of key ? headers[key] : []) {
    const f = h.split(";")[0]; const eq = f.indexOf("=");
    if (eq <= 0) continue;
    const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim();
    if (v === "") cookies.delete(n); else cookies.set(n, v);
  }
}
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const srv = (uri, pinfo, script = "/index.php") => ({
  REQUEST_URI: uri, SCRIPT_NAME: script, SCRIPT_FILENAME: `${NC}${script}`, DOCUMENT_ROOT: NC,
  PATH_INFO: pinfo, REQUEST_METHOD: "GET", HTTP_HOST: "localhost", SERVER_NAME: "localhost",
  SERVER_PORT: "80", SERVER_PROTOCOL: "HTTP/1.1", REMOTE_ADDR: "127.0.0.1", HTTPS: "",
});

// autologin request
php.writeFile(`${NC}/_playground_autologin.php`, buildAutologinScript(cfg));
const a = await php.run({
  scriptPath: `${NC}/_playground_autologin.php`, method: "GET",
  headers: { cookie: cookieHeader() },
  $_SERVER: srv("/_playground_autologin.php", "", "/_playground_autologin.php"),
});
mergeSetCookie(a.headers);
console.log("autologin:", decode(a.bytes).trim());
console.log("cookies:", [...cookies.keys()].join(","));
if (a.errors?.trim()) console.log("stderr:", a.errors.split("\n").slice(0, 4).join("\n"));

// dashboard with session
const d = await php.run({
  scriptPath: `${NC}/index.php`, method: "GET",
  headers: { cookie: cookieHeader() },
  $_SERVER: srv("/index.php/apps/dashboard", "/apps/dashboard"),
});
const body = decode(d.bytes);
const title = (body.match(/<title>[\s\S]*?<\/title>/) || [""])[0].replace(/\s+/g, " ").trim();
const isLogin = /Login –|id="body-login"/.test(body) || /\/login/.test(d.headers?.location?.[0] || "");
const loggedIn = (d.httpStatusCode === 200 && !isLogin) || (d.httpStatusCode === 303 && !/\/login/.test(d.headers?.location?.[0] || ""));
console.log(`\nGET dashboard → HTTP ${d.httpStatusCode} loc=${d.headers?.location?.[0] || "-"}`);
console.log("title:", title);
console.log("logged-in user marker:", /data-user="admin"|"uid":"admin"|displayname/i.test(body) ? "found" : "(not in first bytes)");

console.log("\n=== RESULT ===");
console.log("autologin ok :", decode(a.bytes).includes('"ok":true'));
console.log("dashboard ok :", loggedIn);
process.exit(decode(a.bytes).includes('"ok":true') && loggedIn ? 0 : 1);
