import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import {
  phpResponseToResponse,
  wrapPhpInstance,
} from "../src/runtime/php-compat.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Minimal stand-in for a @php-wasm PHP instance: an in-memory file map plus a
// scripted php.run() that records every call.
function fakePhp({ files = {}, dirs = [], responses = [], module } = {}) {
  const fs = new Map(
    Object.entries(files).map(([path, data]) => [path, encoder.encode(data)]),
  );
  const dirSet = new Set(dirs);
  const runs = [];
  const chdirs = [];
  const listeners = [];
  const php = {
    [__private__dont__use]: module ?? {
      FS: { chdir: (dir) => chdirs.push(dir) },
    },
    readFileAsBuffer(path) {
      if (!fs.has(path)) throw new Error(`ENOENT ${path}`);
      return fs.get(path);
    },
    fileExists: (path) => fs.has(path) || dirSet.has(path),
    isDir: (path) => dirSet.has(path),
    mkdir: (path) => dirSet.add(path),
    writeFile: (path, data) =>
      fs.set(path, typeof data === "string" ? encoder.encode(data) : data),
    async run(request) {
      runs.push(request);
      return (
        responses.shift() ?? {
          httpStatusCode: 200,
          headers: {},
          bytes: encoder.encode("ok"),
        }
      );
    },
    addEventListener: (type, handler) => listeners.push(["add", type, handler]),
    removeEventListener: (type, handler) =>
      listeners.push(["remove", type, handler]),
  };
  return { php, fs, runs, chdirs, listeners };
}

function phpReply(headers = {}, status = 200, body = "ok") {
  return { httpStatusCode: status, headers, bytes: encoder.encode(body) };
}

afterEach(() => mock.restoreAll());

describe("wrapPhpInstance static files", () => {
  it("serves an existing non-PHP file with its MIME type and skips PHP", async () => {
    const { php, runs } = fakePhp({
      files: { "/www/nextcloud/core/css/app.CSS": "body{}" },
    });
    const response = await wrapPhpInstance(php).request({
      url: "/core/css/app.CSS?v=1",
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/css; charset=utf-8",
    );
    assert.equal(await response.text(), "body{}");
    assert.equal(runs.length, 0);
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    const { php } = fakePhp({ files: { "/www/nextcloud/blob.xyz": "x" } });
    const response = await wrapPhpInstance(php).request({ url: "/blob.xyz" });
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
  });

  it("serveStatic returns a Response only for existing non-PHP files", async () => {
    const { php, runs } = fakePhp({
      files: {
        "/www/nextcloud/core/img/logo.svg": "<svg/>",
        "/www/nextcloud/index.php": "<?php",
      },
    });
    const wrapped = wrapPhpInstance(php);
    const hit = wrapped.serveStatic("/core/img/logo.svg");
    assert.equal(hit.headers.get("content-type"), "image/svg+xml");
    assert.equal(await hit.text(), "<svg/>");
    assert.equal(wrapped.serveStatic("/index.php"), null);
    assert.equal(wrapped.serveStatic("/missing.js"), null);
    assert.equal(runs.length, 0);
  });
});

describe("wrapPhpInstance PHP routing", () => {
  it("rewrites a clean URL to the front controller with CGI variables", async () => {
    const { php, runs, chdirs } = fakePhp({
      files: { "/www/nextcloud/index.php": "<?php" },
    });
    const response = await wrapPhpInstance(php).request({
      url: "/apps/files?dir=/",
    });
    assert.equal(await response.text(), "ok");
    const [run] = runs;
    assert.equal(run.scriptPath, "/www/nextcloud/index.php");
    assert.equal(run.method, "GET");
    assert.equal(run.relativeUri, "/apps/files?dir=/");
    assert.equal(run.$_SERVER.SCRIPT_NAME, "/index.php");
    assert.equal(run.$_SERVER.PHP_SELF, "/index.php");
    assert.equal(run.$_SERVER.REQUEST_URI, "/apps/files?dir=/");
    assert.equal(run.$_SERVER.QUERY_STRING, "dir=/");
    assert.equal(run.$_SERVER.PATH_INFO, "");
    assert.equal(run.$_SERVER.SERVER_NAME, "localhost");
    assert.equal(run.$_SERVER.SERVER_PORT, "8080");
    assert.equal(run.$_SERVER.HTTPS, "");
    assert.deepEqual(chdirs, ["/www/nextcloud"]);
  });

  it("splits PATH_INFO after an existing .php script", async () => {
    const { php, runs, chdirs } = fakePhp({
      files: { "/srv/nc/remote.php": "<?php" },
    });
    await wrapPhpInstance(php, {
      webRoot: "/srv/nc",
      absoluteUrl: "https://cloud.example:8443/sub",
    }).request({ url: "/remote.php/dav/files/admin", method: "PROPFIND" });
    const [run] = runs;
    assert.equal(run.scriptPath, "/srv/nc/remote.php");
    assert.equal(run.method, "PROPFIND");
    assert.equal(run.$_SERVER.PATH_INFO, "/dav/files/admin");
    assert.equal(run.$_SERVER.DOCUMENT_ROOT, "/srv/nc");
    assert.equal(run.$_SERVER.HTTPS, "on");
    assert.equal(run.$_SERVER.SERVER_PORT, "8443");
    assert.equal(run.$_SERVER.HTTP_HOST, "cloud.example:8443");
    assert.deepEqual(chdirs, ["/srv/nc"]);
  });

  it("defaults the HTTPS port to 443 and a trailing slash to index.php", async () => {
    const { php, runs } = fakePhp({
      files: { "/www/nextcloud/ocs/index.php": "<?php" },
    });
    await wrapPhpInstance(php, {
      absoluteUrl: "https://cloud.example",
    }).request({ url: "/ocs/" });
    assert.equal(runs[0].scriptPath, "/www/nextcloud/ocs/index.php");
    assert.equal(runs[0].$_SERVER.SERVER_PORT, "443");
    assert.equal(runs[0].$_SERVER.SCRIPT_NAME, "/ocs/index.php");
  });

  it("routes a missing .php script to the front controller", async () => {
    const { php, runs } = fakePhp();
    await wrapPhpInstance(php).request({});
    assert.equal(runs[0].scriptPath, "/www/nextcloud/index.php");
    assert.equal(runs[0].$_SERVER.REQUEST_URI, "/");
    assert.equal(runs[0].$_SERVER.REQUEST_METHOD, "GET");
  });

  it("converts a native POST Request into body, headers and CGI vars", async () => {
    const { php, runs } = fakePhp();
    await wrapPhpInstance(php).request(
      new Request("http://localhost:8080/index.php/login?x=1", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-requested-with": "XMLHttpRequest",
        },
        body: "user=admin",
      }),
    );
    const [run] = runs;
    assert.equal(run.method, "POST");
    assert.equal(decoder.decode(run.body), "user=admin");
    assert.equal(run.headers["content-length"], "10");
    assert.equal(
      run.$_SERVER.CONTENT_TYPE,
      "application/x-www-form-urlencoded",
    );
    assert.equal(run.$_SERVER.CONTENT_LENGTH, "10");
    assert.equal(run.$_SERVER.HTTP_X_REQUESTED_WITH, "XMLHttpRequest");
    assert.equal(run.$_SERVER.QUERY_STRING, "x=1");
    assert.equal(run.$_SERVER.PATH_INFO, "/login");
  });

  it("does not forward the Host header and sends an empty body when it cannot be read", async () => {
    const { php, runs } = fakePhp();
    const request = new Request("http://localhost/upload.php", {
      method: "PUT",
      body: "already-read",
    });
    await request.arrayBuffer(); // a second read rejects
    await wrapPhpInstance(php).request(request);
    assert.equal(runs[0].body.byteLength, 0);
    assert.equal(runs[0].headers["content-length"], "0");

    await wrapPhpInstance(php).request({
      url: "/",
      headers: { Host: "evil.example" },
    });
    assert.equal(runs[1].$_SERVER.HTTP_HOST, "localhost:8080");
  });

  it("keeps serving when the module has no chdir or chdir throws", async () => {
    const noFs = fakePhp({ module: Promise.resolve({}) });
    assert.equal((await wrapPhpInstance(noFs.php).request({})).status, 200);
    const throwing = fakePhp({
      module: {
        FS: {
          chdir() {
            throw new Error("ENOENT");
          },
        },
      },
    });
    assert.equal((await wrapPhpInstance(throwing.php).request({})).status, 200);
  });

  it("calls syncFs after each PHP request", async () => {
    const { php } = fakePhp();
    let synced = 0;
    await wrapPhpInstance(php, { syncFs: async () => synced++ }).request({});
    assert.equal(synced, 1);
  });
});

describe("wrapPhpInstance cookie jar", () => {
  it("stores Set-Cookie values, replays them, and drops expired ones", async () => {
    const { php, runs } = fakePhp({
      responses: [
        phpReply({
          "Set-Cookie": [
            "oc_session=abc; path=/; HttpOnly",
            "nc_token=t1",
            "keep=1",
            "=nameless",
          ],
        }),
        phpReply({
          "set-cookie": [
            "nc_token=deleted; Max-Age=0",
            "keep=; path=/",
            "old=x; expires=Thu, 01 Jan 1970 00:00:00 GMT",
          ],
        }),
      ],
    });
    const wrapped = wrapPhpInstance(php);
    await wrapped.request({});
    await wrapped.request({ url: "/", headers: { cookie: "client=1" } });
    assert.equal(
      runs[1].$_SERVER.HTTP_COOKIE,
      "client=1; oc_session=abc; nc_token=t1; keep=1",
    );
    assert.equal(runs[1].headers.cookie, runs[1].$_SERVER.HTTP_COOKIE);

    await wrapped.request({});
    assert.equal(runs[2].$_SERVER.HTTP_COOKIE, "oc_session=abc");
  });

  it("setCookie adds a cookie and clears it on an empty or null value", async () => {
    const { php, runs } = fakePhp();
    const wrapped = wrapPhpInstance(php);
    wrapped.setCookie("a", "1");
    wrapped.setCookie("b", "2");
    wrapped.setCookie("b", "");
    await wrapped.request({});
    assert.equal(runs[0].$_SERVER.HTTP_COOKIE, "a=1");
    wrapped.setCookie("a", null);
    await wrapped.request({});
    assert.equal(runs[1].$_SERVER.HTTP_COOKIE, undefined);
    assert.equal("cookie" in runs[1].headers, false);
  });
});

describe("wrapPhpInstance filesystem helpers", () => {
  it("analyzePath reports missing paths, folders, files and errors", async () => {
    const { php } = fakePhp({
      files: { "/www/f.txt": "x" },
      dirs: ["/www"],
    });
    const wrapped = wrapPhpInstance(php);
    assert.deepEqual(await wrapped.analyzePath("/nope"), { exists: false });
    assert.deepEqual(await wrapped.analyzePath("/www"), {
      exists: true,
      object: { isFolder: true, mode: 0o40755 },
    });
    assert.deepEqual(await wrapped.analyzePath("/www/f.txt"), {
      exists: true,
      object: { isFolder: false, mode: 0o100644 },
    });
    php.fileExists = () => {
      throw new Error("boom");
    };
    assert.deepEqual(await wrapped.analyzePath("/www"), { exists: false });
  });

  it("delegates mkdir, writeFile, readFile, run and listeners to PHP", async () => {
    const module = { FS: {} };
    const { php, runs, listeners } = fakePhp({ module });
    const wrapped = wrapPhpInstance(php);
    await wrapped.mkdir("/d");
    assert.equal(php.isDir("/d"), true);
    await wrapped.writeFile("/d/a.txt", "hello");
    assert.equal(decoder.decode(await wrapped.readFile("/d/a.txt")), "hello");
    await wrapped.run("<?php echo 1;");
    assert.deepEqual(runs[0], { code: "<?php echo 1;" });
    const handler = () => {};
    wrapped.addEventListener("request.end", handler);
    wrapped.removeEventListener("request.end", handler);
    assert.deepEqual(listeners, [
      ["add", "request.end", handler],
      ["remove", "request.end", handler],
    ]);
    assert.equal(wrapped.binary, module);
    assert.equal(wrapped._php, php);
  });
});

describe("phpResponseToResponse headers", () => {
  it("skips a malformed header instead of failing the whole response", async () => {
    const warn = mock.method(console, "warn", () => {});
    const response = phpResponseToResponse(
      phpReply({ "bad header": ["x"], "x-good": ["1", "2"] }),
    );
    assert.equal(response.headers.get("x-good"), "1, 2");
    assert.equal(await response.text(), "ok");
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /bad header/);
  });

  it("survives a console.warn that throws and a response without headers", () => {
    mock.method(console, "warn", () => {
      throw new Error("console gone");
    });
    const response = phpResponseToResponse(phpReply({ "bad header": ["x"] }));
    assert.equal(response.status, 200);
    const bare = phpResponseToResponse({
      httpStatusCode: 201,
      bytes: encoder.encode(""),
    });
    assert.equal(bare.status, 201);
  });
});
