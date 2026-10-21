import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { zipSync } from "fflate";
import { FAKES, repo, runScript } from "./fixtures/cov-tools/run.mjs";

// The spike/ harnesses boot real Nextcloud under @php-wasm/node. Here PHP is a
// scripted fake (tests/fixtures/cov-tools/fake-php.mjs), so these tests check
// the harnesses' own logic: bundle extraction into the VFS, request shapes,
// cookie-jar handling and the pass/fail verdict (exit code).

const enc = new TextEncoder();
const zip = Buffer.from(
  zipSync({
    "nextcloud/index.php": enc.encode("<?php"),
    "nextcloud/core/": new Uint8Array(0),
    "nextcloud/core/routes.php": enc.encode("<?php return [];"),
  }),
).toString("base64");

function bundleFiles() {
  return {
    [resolve(repo, "assets/manifests/nextcloud-31.json")]: JSON.stringify({
      release: "latest-31",
      bundle: { path: "../nextcloud/nextcloud-31.zip" },
    }),
    [resolve(repo, "assets/nextcloud/nextcloud-31.zip")]: { base64: zip },
  };
}

const INSTALLED = {
  "/www/nextcloud/config/config.php": "<?php $CONFIG = ['installed' => true];",
};

const runs = (calls) => calls.filter((c) => c.php === "run");
const lines = (stdout) => stdout.split("\n").map((l) => l.trimEnd());

describe("spike/boot-from-bundle.mjs", () => {
  const run = (results, files = INSTALLED) =>
    runScript("spike/boot-from-bundle.mjs", {
      stubs: { ...FAKES.php, ...FAKES.fs },
      env: {
        NC_MAJOR: "",
        COV_FS: { files: bundleFiles() },
        COV_PHP: { results, files },
      },
    });

  it("installs, logs in with the request token and reaches the dashboard", () => {
    const result = run([
      { exitCode: 0, text: "Nextcloud was successfully installed\nnoise" },
      { text: "config ok" },
      {
        text: '<html data-requesttoken="tok123">Nextcloud</html>',
        headers: {
          "Set-Cookie": [
            "oc_sessionPassphrase=abc; path=/; Secure",
            "nc_old=gone; expires=Thu, 01 Jan 1970 00:00:00 GMT",
            "=nameless",
          ],
        },
      },
      {
        httpStatusCode: 303,
        headers: {
          Location: ["http://localhost/index.php/apps/dashboard/?x=1"],
        },
        errors: "login error detail\nunrelated",
      },
      { text: "<title>\n Dashboard - Nextcloud\n</title>" },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = lines(result.stdout);
    assert.ok(out.includes("installed        : true"));
    assert.ok(out.includes("login render ok  : true"));
    assert.ok(
      out.includes(
        "login POST ok    : true → http://localhost/index.php/apps/dashboard/?x=1",
      ),
    );
    assert.ok(out.includes("dashboard logged : true"));
    assert.match(
      result.stdout,
      /\[warn\] cookie oc_sessionPassphrase is Secure/,
    );
    assert.match(result.stdout, /Nextcloud was successfully installed/);
    assert.match(result.stdout, /stderr: login error detail/);
    assert.match(result.stdout, /zip entries: 2/);
    // The bundle's leading "nextcloud/" folder is stripped into /www/nextcloud.
    const written = result.calls
      .filter((c) => c.php === "FS.writeFile")
      .map((c) => c.path);
    assert.deepEqual(written.sort(), [
      "/www/nextcloud/core/routes.php",
      "/www/nextcloud/index.php",
    ]);
    const ini = result.calls.find((c) => c.php === "ini").entries;
    assert.equal(
      ini.auto_prepend_file,
      "/internal/shared/auto_prepend_file.php",
    );

    const [install, config, login, post, dashboard] = runs(result.calls);
    assert.match(install.code, /maintenance:install|<\?php/);
    assert.ok(config.code);
    assert.equal(login.server.REQUEST_URI, "/index.php/login");
    assert.equal(post.method, "POST");
    const form = new URLSearchParams(post.body);
    assert.equal(form.get("requesttoken"), "tok123");
    assert.equal(form.get("user"), "admin");
    assert.equal(post.headers.cookie, "oc_sessionPassphrase=abc");
    assert.equal(
      post.server.CONTENT_LENGTH,
      String(Buffer.byteLength(post.body)),
    );
    assert.equal(
      dashboard.server.REQUEST_URI,
      "/index.php/apps/dashboard/?x=1",
    );
    assert.equal(dashboard.server.PATH_INFO, "/apps/dashboard/");
  });

  it("fails when install, login render and login POST all fail", () => {
    const result = run(
      [
        { exitCode: 1 },
        { text: "" },
        {
          httpStatusCode: 500,
          text: '<input name="requesttoken" value="form-tok">',
        },
        { httpStatusCode: 200 },
        { text: "<title>Login – Nextcloud</title>" },
      ],
      {},
    );
    assert.equal(result.status, 1);
    const out = lines(result.stdout);
    assert.ok(out.includes("installed=true: false"));
    assert.ok(out.includes("login render ok  : false"));
    assert.ok(out.includes("login POST ok    : false"));
    assert.ok(out.includes("dashboard logged : false"));
    const [, , , post, dashboard] = runs(result.calls);
    assert.equal(
      new URLSearchParams(post.body).get("requesttoken"),
      "form-tok",
    );
    assert.equal(dashboard.server.REQUEST_URI, "/index.php/apps/dashboard");
  });

  it("falls back to an empty token and the root path info", () => {
    const result = run([
      {},
      {},
      { text: "Nextcloud" },
      { httpStatusCode: 303, headers: { location: ["/index.php"] } },
      { text: "" },
    ]);
    assert.equal(result.status, 0);
    const [, , , post, dashboard] = runs(result.calls);
    assert.equal(new URLSearchParams(post.body).get("requesttoken"), "");
    assert.equal(dashboard.server.PATH_INFO, "/");
  });
});

describe("spike/autologin-test.mjs", () => {
  const run = (results) =>
    runScript("spike/autologin-test.mjs", {
      stubs: { ...FAKES.php, ...FAKES.fs },
      env: {
        COV_FS: { files: bundleFiles() },
        COV_PHP: { results, files: INSTALLED },
      },
    });

  it("passes when autologin sets a session the dashboard accepts", () => {
    const result = run([
      {},
      {},
      {
        text: '{"ok":true}\n',
        headers: {
          "set-cookie": ["nc_session=s1; path=/", "nc_token=; path=/", "bad"],
        },
        errors: "e1\ne2",
      },
      { text: '<title>Dashboard</title><body data-user="admin">' },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = lines(result.stdout);
    assert.ok(out.includes('autologin: {"ok":true}'));
    assert.ok(out.includes("cookies: nc_session"));
    assert.ok(out.includes("stderr: e1"));
    assert.ok(out.includes("logged-in user marker: found"));
    assert.ok(out.includes("autologin ok : true"));
    assert.ok(out.includes("dashboard ok : true"));
    const [, , autologin, dashboard] = runs(result.calls);
    assert.equal(
      autologin.scriptPath,
      "/www/nextcloud/_playground_autologin.php",
    );
    assert.equal(autologin.headers.cookie, "");
    assert.equal(dashboard.headers.cookie, "nc_session=s1");
    assert.equal(dashboard.server.PATH_INFO, "/apps/dashboard");
    assert.ok(
      result.calls.some(
        (c) =>
          c.php === "writeFile" &&
          c.path === "/www/nextcloud/_playground_autologin.php",
      ),
    );
  });

  it("fails when the dashboard still shows the login page", () => {
    const result = run([
      {},
      {},
      { text: '{"ok":false}' },
      { httpStatusCode: 303, headers: { location: ["/index.php/login"] } },
    ]);
    assert.equal(result.status, 1);
    const out = lines(result.stdout);
    assert.ok(out.includes("autologin ok : false"));
    assert.ok(out.includes("dashboard ok : false"));
    assert.ok(out.includes("logged-in user marker: (not in first bytes)"));
    assert.match(
      result.stdout,
      /GET dashboard → HTTP 303 loc=\/index\.php\/login/,
    );
  });
});

describe("spike/run-spike.mjs", () => {
  const run = (results, files = INSTALLED) =>
    runScript("spike/run-spike.mjs", {
      stubs: FAKES.php,
      env: { COV_PHP: { results, files } },
    });

  it("installs via an occ wrapper and checks status.php and the login page", () => {
    const result = run([
      { exitCode: 0, text: "installed", errors: "deprecation" },
      { text: '{"installed":true}', errors: "notice" },
      { httpStatusCode: 302 },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = lines(result.stdout);
    assert.ok(out.includes("occ install exit   : 0"));
    assert.ok(out.includes("status.php 200+json: true"));
    assert.ok(out.includes("login render ok    : true"));
    assert.match(result.stdout, /--- stderr ---\ndeprecation/);
    const mount = result.calls.find((c) => c.php === "mount");
    assert.equal(
      mount.hostPath,
      resolve(repo, ".cache/nextcloud-source/nextcloud"),
    );
    const prepend = result.calls.find(
      (c) => c.php === "writeFile" && c.path === "/internal/prepend.php",
    );
    assert.ok(prepend.size > 0);
    const [occ, status, login] = runs(result.calls);
    assert.equal(occ.scriptPath, "/tmp/__occ_run.php");
    assert.equal(status.server.SCRIPT_NAME, "/status.php");
    assert.equal(status.server.PATH_INFO, undefined);
    assert.equal(login.server.PATH_INFO, "/login");
  });

  it("reports failures when PHP throws", () => {
    const result = run(
      [
        { throw: "wasm trap" },
        { throw: "status down" },
        { throw: "login down" },
      ],
      {},
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install threw: wasm trap/);
    assert.match(result.stderr, /request threw: status down/);
    const out = lines(result.stdout);
    assert.ok(out.includes("occ install exit   : -1"));
    assert.ok(out.includes("installed=true     : false"));
    assert.ok(out.includes("login render ok    : false"));
  });
});
