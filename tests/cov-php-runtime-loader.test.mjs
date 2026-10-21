import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import { __testing, createPhpRuntime } from "../src/runtime/php-loader.js";

const PHP_INI_PATH = "/internal/shared/php.ini";
const CA_PATH = "/internal/shared/playground-ca.pem";
const decoder = new TextDecoder();
const realDeps = { ...__testing.runtimeDeps };

// Fake raw PHP instance covering what refresh() and setPhpIniEntries() touch.
function fakeRawPhp({ failFs = false } = {}) {
  const files = new Map([[PHP_INI_PATH, ""]]);
  const dirs = [];
  const calls = { sapi: [], spawn: [] };
  const php = {
    [__private__dont__use]: {
      FS: {
        mkdirTree(path) {
          dirs.push(path);
          if (failFs) throw new Error("EEXIST");
        },
        chdir() {},
      },
    },
    async setSapiName(name) {
      calls.sapi.push(name);
    },
    async setSpawnHandler(handler) {
      calls.spawn.push(handler);
      if (failFs) throw new Error("unsupported");
    },
    writeFile(path, data) {
      if (failFs && path.endsWith("openssl.cnf")) throw new Error("EROFS");
      files.set(path, typeof data === "string" ? data : decoder.decode(data));
    },
    readFileAsText: (path) => files.get(path) ?? "",
    readFileAsBuffer(path) {
      if (!files.has(path)) throw new Error("ENOENT");
      return new TextEncoder().encode(files.get(path));
    },
    fileExists: (path) => files.has(path),
    async run(request) {
      calls.run = request;
      return { httpStatusCode: 200, headers: {}, bytes: new Uint8Array() };
    },
  };
  return { php, files, dirs, calls };
}

function installFake(fake) {
  const loads = [];
  __testing.runtimeDeps.loadWebRuntime = async (version, options) => {
    loads.push({ version, options });
    return 42;
  };
  __testing.runtimeDeps.createPhp = (runtimeId) => {
    assert.equal(runtimeId, 42);
    return fake.php;
  };
  return loads;
}

afterEach(() => {
  Object.assign(__testing.runtimeDeps, realDeps);
  delete globalThis.indexedDB;
});

describe("createPhpRuntime before refresh()", () => {
  it("rejects filesystem and request calls until the runtime exists", async () => {
    const runtime = createPhpRuntime({});
    for (const method of [
      "request",
      "analyzePath",
      "mkdir",
      "writeFile",
      "readFile",
      "run",
    ]) {
      await assert.rejects(runtime[method](), /not initialized/, method);
    }
    assert.equal(
      runtime.addEventListener("x", () => {}),
      undefined,
    );
    assert.equal(
      runtime.removeEventListener("x", () => {}),
      undefined,
    );
  });

  it("reports persistence as disabled without a scope", async () => {
    assert.deepEqual(await createPhpRuntime({}).flushPersistence(), {
      enabled: false,
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
  });
});

describe("createPhpRuntime refresh()", () => {
  let fake;
  let loads;
  beforeEach(() => {
    fake = fakeRawPhp();
    loads = installFake(fake);
  });

  it("boots PHP 8.3 with intl, the generated CA, ini and base layout", async () => {
    const runtime = createPhpRuntime({});
    await runtime.refresh();

    assert.equal(loads.length, 1);
    const { version, options } = loads[0];
    assert.equal(version, "8.3");
    assert.deepEqual(options.extensions, ["intl"]);
    assert.equal(options.emscriptenOptions.ALLOW_MEMORY_GROWTH, 1);
    assert.ok(options.tcpOverFetch.CAroot.certificate);
    assert.equal("corsProxyUrl" in options.tcpOverFetch, false);

    // OPcache off by default: the SAPI name stays untouched.
    assert.deepEqual(fake.calls.sapi, []);
    assert.equal(typeof fake.calls.spawn[0], "function");
    for (const dir of [
      "/tmp",
      "/www/nextcloud",
      "/persist",
      "/config",
      "/root/install/ssl",
      "/internal/shared/preload",
    ]) {
      assert.ok(fake.dirs.includes(dir), `missing ${dir}`);
    }
    assert.match(
      fake.files.get("/root/install/ssl/openssl.cnf"),
      /empty OpenSSL config/,
    );
    assert.match(fake.files.get(CA_PATH), /^-----BEGIN CERTIFICATE-----/);
    assert.equal(
      fake.files.get(__testing.OPCACHE_BLACKLIST_PATH),
      __testing.OPCACHE_BLACKLIST,
    );
    const ini = fake.files.get(PHP_INI_PATH);
    assert.match(ini, /memory_limit\s*=\s*"?256M/);
    assert.match(
      ini,
      /openssl\.cafile\s*=\s*"?\/internal\/shared\/playground-ca\.pem/,
    );
  });

  it("exposes the wrapped instance after refresh()", async () => {
    const runtime = createPhpRuntime({});
    await runtime.refresh();
    await runtime.writeFile("/tmp/a.txt", "hi");
    assert.equal(fake.files.get("/tmp/a.txt"), "hi");
    assert.equal(runtime._php, fake.php);
    assert.equal(runtime.binary, fake.php[__private__dont__use]);
    assert.equal(typeof runtime.refresh, "function");

    await runtime.request({ url: "/status.php" });
    assert.equal(fake.calls.run.scriptPath, "/www/nextcloud/index.php");
    assert.equal(fake.calls.run.$_SERVER.SERVER_PORT, "8080");
  });

  it("applies opcache, version, proxy, base URL and web root options", async () => {
    const runtime = createPhpRuntime(
      {},
      {
        opcache: true,
        phpVersion: "8.4",
        phpCorsProxyUrl: "https://proxy.example/cors?",
        appBaseUrl: "https://play.example/nc/",
        webRoot: "/srv/nc",
      },
    );
    await runtime.refresh();
    assert.equal(loads[0].version, "8.4");
    assert.equal(
      loads[0].options.tcpOverFetch.corsProxyUrl,
      "https://proxy.example/cors?",
    );
    assert.deepEqual(fake.calls.sapi, [__testing.OPCACHE_SAPI_NAME]);

    await runtime.request({ url: "/" });
    assert.equal(fake.calls.run.scriptPath, "/srv/nc/index.php");
    assert.equal(fake.calls.run.$_SERVER.SERVER_NAME, "play.example");
    assert.equal(fake.calls.run.$_SERVER.HTTPS, "on");
  });

  it("prefers corsProxyUrl and reuses one CA across runtimes", async () => {
    const first = createPhpRuntime(
      {},
      { corsProxyUrl: "https://a.example/", phpCorsProxyUrl: "https://b/" },
    );
    await first.refresh();
    await createPhpRuntime({}).refresh();
    assert.equal(
      loads[0].options.tcpOverFetch.corsProxyUrl,
      "https://a.example/",
    );
    assert.equal(
      loads[0].options.tcpOverFetch.CAroot,
      loads[1].options.tcpOverFetch.CAroot,
    );
  });

  it("tolerates existing directories and a missing spawn/OpenSSL setup", async () => {
    fake = fakeRawPhp({ failFs: true });
    installFake(fake);
    const runtime = createPhpRuntime({});
    await runtime.refresh();
    assert.equal(fake.files.has("/root/install/ssl/openssl.cnf"), false);
    assert.match(fake.files.get(CA_PATH), /BEGIN CERTIFICATE/);
    assert.equal(
      fake.files.get(__testing.OPCACHE_BLACKLIST_PATH),
      __testing.OPCACHE_BLACKLIST,
    );
  });
});

describe("createPhpRuntime journal start-up", () => {
  // IndexedDB stub whose open() always fails; records requested names.
  function failingIndexedDb() {
    const opened = [];
    const deleted = [];
    globalThis.indexedDB = {
      open(name) {
        opened.push(name);
        const req = {};
        setTimeout(() => {
          req.error = new Error(`blocked ${name}`);
          req.onerror();
        });
        return req;
      },
      deleteDatabase: (name) => deleted.push(name),
    };
    return { opened, deleted };
  }

  it("clears the scope journal first on a clean boot", async () => {
    installFake(fakeRawPhp());
    const idb = failingIndexedDb();
    const runtime = createPhpRuntime(
      {},
      { scopeId: "s1", forceCleanBoot: true },
    );
    await assert.rejects(runtime.refresh(), /blocked nextcloud-fs-journal:s1/);
    assert.deepEqual(idb.opened, ["nextcloud-fs-journal:s1"]);
    assert.deepEqual(idb.deleted, []);
  });

  it("drops legacy OPcache stores and opens the scope journal", async () => {
    installFake(fakeRawPhp());
    const idb = failingIndexedDb();
    const runtime = createPhpRuntime({}, { scopeId: "s2", phpVersion: "8.2" });
    await assert.rejects(runtime.refresh(), /blocked nextcloud-fs-journal:s2/);
    assert.deepEqual(idb.deleted, ["nextcloud-opcache:8.2"]);
    assert.deepEqual(idb.opened, ["nextcloud-fs-journal:s2"]);
  });
});
