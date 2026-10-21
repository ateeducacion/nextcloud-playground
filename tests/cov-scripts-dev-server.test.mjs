import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the real scripts/dev-server.mjs as a child process. The preload gives
// the add-on proxy an allowlist and a local fake upstream (no network).
const repoDir = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(
  new URL("./fixtures/cov-scripts/dev-server-preload.mjs", import.meta.url),
);

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe("scripts/dev-server.mjs", () => {
  let child;
  let base;
  let banner = "";

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ["--import", preload, "scripts/dev-server.mjs"],
      { cwd: repoDir, env: { ...process.env, PORT: String(port) } },
    );
    await new Promise((resolve, reject) => {
      child.on("exit", (code) => reject(new Error(`exited ${code}`)));
      child.stdout.on("data", (chunk) => {
        banner += chunk;
        if (banner.includes("listening")) resolve();
      });
    });
  });

  after(async () => {
    child.removeAllListeners("exit");
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  });

  const proxy = (target, init) =>
    fetch(
      `${base}/__addon_proxy__${target === undefined ? "" : `?url=${encodeURIComponent(target)}`}`,
      init,
    );

  it("announces the address it listens on", () => {
    assert.match(banner, new RegExp(`listening on ${base}`));
  });

  it("serves repo files with their MIME type and no-store caching", async () => {
    const res = await fetch(`${base}/playground.config.json?x=1`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok((await res.json()).runtimes.length > 0);
  });

  it("maps / to index.html and unknown extensions to octet-stream", async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await index.text(), /<html/i);
    const makefile = await fetch(`${base}/Makefile`);
    assert.equal(
      makefile.headers.get("content-type"),
      "application/octet-stream",
    );
  });

  it("answers 404 for missing files and directories without index.html", async () => {
    for (const path of [
      "/no-such-file.txt",
      "/scripts/",
      "/..%2f..%2fetc/passwd",
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
      assert.equal(await res.text(), "Not found");
    }
  });

  it("rejects methods other than GET/HEAD and handles proxy preflight", async () => {
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: "OPTIONS" })).status, 405);
    const preflight = await proxy(undefined, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  });

  it("validates the proxy target before fetching it", async () => {
    const cases = [
      [undefined, 400, /Missing "url"/],
      ["not a url", 400, /Invalid URL/],
      ["ftp://github.com/a.zip", 400, /Invalid protocol/],
      ["https://evil.example/a.zip", 403, /"evil.example" is not allowed/],
      ["https://github.com/owner/repo", 400, /not a supported plugin page/],
      ["https://nextcloud.com/plugins/a/b", 400, /not a supported/],
    ];
    for (const [target, status, error] of cases) {
      const res = await proxy(target);
      assert.equal(res.status, status, String(target));
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match((await res.json()).error, error);
    }
  });

  it("streams allowed downloads with the upstream headers", async () => {
    const res = await proxy(
      "https://api.github.com/o/r/archive/refs/heads/main.zip",
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-zip");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="up.zip"',
    );
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(await res.text(), "PK-GET-nextcloud-playground-dev-proxy");
  });

  it("answers HEAD without a body", async () => {
    const res = await proxy("https://github.com/o/r/zip/main", {
      method: "HEAD",
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-length"),
      String("PK-HEAD-nextcloud-playground-dev-proxy".length),
    );
    assert.equal(await res.text(), "");
  });

  it("infers type and filename when upstream sends none", async () => {
    const tag = await proxy("https://github.com/o/r/archive/refs/tags/v1-bare");
    assert.equal(tag.headers.get("content-type"), "application/zip");
    assert.equal(
      tag.headers.get("content-disposition"),
      'attachment; filename="v1-bare.zip"',
    );
    assert.equal(await tag.text(), "PK");

    const odd = await proxy("https://github.com/o/my%20bare.zip");
    assert.equal(
      odd.headers.get("content-disposition"),
      'attachment; filename="my_20bare.zip"',
    );
    await odd.arrayBuffer();

    const build = await proxy(
      "https://nextcloud.com/downloadbuild/12/stable?bare=1",
    );
    assert.equal(
      build.headers.get("content-disposition"),
      'attachment; filename="stable.zip"',
    );
    await build.arrayBuffer();

    const page = await proxy("https://NEXTCLOUD.com/plugins/bare-app/");
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("content-disposition"), null);
    await page.arrayBuffer();
  });

  it("ends the response when upstream has no body", async () => {
    const res = await proxy("https://github.com/x/empty.zip");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });

  it("maps upstream failures to 502", async () => {
    const missing = await proxy("https://github.com/x/missing.zip");
    assert.equal(missing.status, 502);
    assert.deepEqual(await missing.json(), {
      error: "Upstream server returned an error.",
      status: 404,
      statusText: "Not Found",
    });
    const boom = await proxy("https://github.com/x/boom.zip");
    assert.equal(boom.status, 502);
    assert.deepEqual(await boom.json(), {
      error: "Failed to fetch remote plugin resource.",
      details: "socket hang up",
    });
  });
});
