import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import zlib from "node:zlib";
import { zipSync } from "fflate";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import { executeBlueprintSteps } from "../src/runtime/blueprint-steps.js";
import {
  NEXTCLOUD_DATA_DIR,
  NEXTCLOUD_ROOT,
} from "../src/runtime/bootstrap-paths.js";

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);

function gzipTar(fileMap) {
  const tar = createUstarTar(normalizeEntries(fileMap));
  return new Uint8Array(zlib.gzipSync(Buffer.from(tar)));
}

/** In-memory Emscripten-like FS. */
function fakeFs() {
  const files = new Map();
  const dirs = new Set(["/"]);
  return {
    files,
    dirs,
    analyzePath: (p) => ({ exists: dirs.has(p) || files.has(p) }),
    mkdir: (p) => dirs.add(p),
    writeFile: (p, data) => files.set(p, data),
  };
}

/**
 * Fake PHP. `onRun(script)` returns stdout (string) or a full result object.
 */
function fakePhp({ onRun = () => "", request, binaryFs, ownFs } = {}) {
  const runs = [];
  const written = new Map();
  const mkdirs = [];
  const php = {
    runs,
    written,
    mkdirs,
    async run(script) {
      runs.push(script);
      const out = onRun(script);
      if (out && typeof out === "object") return out;
      return { exitCode: 0, bytes: enc(String(out ?? "")) };
    },
    async writeFile(path, data) {
      written.set(path, data);
    },
    async readFile(path) {
      return written.get(path);
    },
    async analyzePath(path) {
      return { exists: path === "/www" };
    },
    async mkdir(path) {
      mkdirs.push(path);
      if (path === "/www/nextcloud") throw new Error("EEXIST");
    },
    binary: Promise.resolve(binaryFs ? { FS: binaryFs } : {}),
  };
  if (request) php.request = request;
  if (ownFs) php.FS = ownFs;
  return php;
}

function collect() {
  const messages = [];
  const publish = (msg) => messages.push(msg);
  return { messages, publish };
}

const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return calls;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

function occArgv(script) {
  const match = script.match(/\$_SERVER\['argv'\] = (\[.*\]);/);
  return match ? JSON.parse(match[1]) : null;
}

describe("executeBlueprintSteps edge cases", () => {
  it("returns zero executed for a blueprint without steps", async () => {
    const { publish } = collect();
    assert.deepEqual(
      await executeBlueprintSteps({ php: fakePhp(), blueprint: null, publish }),
      { executed: 0 },
    );
    assert.deepEqual(
      await executeBlueprintSteps({
        php: fakePhp(),
        blueprint: { steps: [] },
        publish,
      }),
      { executed: 0 },
    );
  });

  it("warns about unknown and empty step entries without counting them", async () => {
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: { steps: [{ type: "bogus" }, null] },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.deepEqual(messages, [
      "[warning] Unknown blueprint step: bogus",
      "[warning] Unknown blueprint step: undefined",
    ]);
  });
});

describe("occ-backed steps", () => {
  it("translates each step into the expected occ argv and env", async () => {
    const php = fakePhp({ onRun: () => ({ exitCode: 1 }) });
    const { publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      publish,
      blueprint: {
        steps: [
          { step: "enableApp", app: "text" },
          { step: "disableApp", appId: "firstrunwizard" },
          { step: "createGroup", group: "staff" },
          {
            step: "createUser",
            username: "alice",
            displayName: "Alice A",
            groups: ["staff", "admin"],
            email: "alice@example.com",
          },
          { step: "createUser", uid: "bob", password: "s3cr'et" },
          { step: "addUserToGroup", uid: "bob", gid: "staff" },
          { step: "setConfig", key: "theme", value: "dark" },
          { step: "setConfig", app: "files", key: "max", value: 5 },
          { step: "runOcc", args: ["status", 1] },
          { step: "runOcc" },
        ],
      },
    });
    // A non-zero occ exit status is not treated as a step failure.
    assert.equal(result.executed, 10);
    assert.equal(result.criticalFailure, false);
    assert.equal(result.loggedInUser, null);
    assert.deepEqual(php.runs.map(occArgv), [
      ["occ", "app:enable", "--force", "text"],
      ["occ", "app:disable", "firstrunwizard"],
      ["occ", "group:add", "staff"],
      [
        "occ",
        "user:add",
        "--password-from-env",
        "--display-name",
        "Alice A",
        "--group",
        "staff",
        "--group",
        "admin",
        "alice",
      ],
      [
        "occ",
        "user:setting",
        "alice",
        "settings",
        "email",
        "alice@example.com",
      ],
      ["occ", "user:add", "--password-from-env", "bob"],
      ["occ", "group:adduser", "staff", "bob"],
      ["occ", "config:system:set", "theme", "--value", "dark"],
      ["occ", "config:app:set", "files", "max", "--value", "5"],
      ["occ", "status", "1"],
      ["occ"],
    ]);
    assert.match(php.runs[3], /putenv\('OC_PASS=password'\);/);
    assert.match(php.runs[5], /putenv\('OC_PASS=s3cr\\'et'\);/);
  });
});

describe("login step", () => {
  it("warns when the username is blank", async () => {
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp({ request: async () => new Response("{}") }),
      blueprint: { steps: [{ step: "login", username: "   " }] },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.deepEqual(messages, ["[warning] login requires username."]);
  });

  it("warns when the runtime has no php.request()", async () => {
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: { steps: [{ step: "login" }] },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.match(messages[0], /requires php\.request\(\)/);
  });

  it("uses the blueprint admin as default and falls back to the username for uid", async () => {
    const php = fakePhp({
      request: async () => new Response('noise {"ok":true}'),
    });
    const { publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: { admin: { username: "root" }, steps: [{ step: "login" }] },
      publish,
    });
    assert.equal(result.loggedInUser, "root");
    const script = dec(
      php.written.get(`${NEXTCLOUD_ROOT}/_playground_autologin.php`),
    );
    assert.match(script, /->login\('root', 'password'\)/);
  });

  it("reports the PHP error, or a generic message, when login fails", async () => {
    const replies = ['{"ok":false,"error":"bad credentials"}', "garbage"];
    const php = fakePhp({
      request: async () => new Response(replies.shift()),
    });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        login: { username: "eve" },
        steps: [{ step: "login" }, { step: "login" }],
      },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.equal(result.loggedInUser, null);
    assert.ok(
      messages.includes('[warning] Step "login" failed: bad credentials'),
    );
    assert.ok(messages.includes('[warning] Step "login" failed: login failed'));
  });
});

describe("installApp step", () => {
  it("warns when appId or url is missing", async () => {
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: { steps: [{ step: "installApp", appId: "x" }] },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.deepEqual(messages, [
      "[warning] installApp requires both appId and url.",
    ]);
  });

  it("extracts a gzip tar app re-rooted at appinfo/ into apps/<appId>", async () => {
    stubFetch(
      () =>
        new Response(
          gzipTar({
            "pkg/appinfo/info.xml": enc("<info/>"),
            "pkg/lib/App.php": enc("<?php"),
            "README.md": enc("readme"),
          }),
        ),
    );
    const fs = fakeFs();
    const php = fakePhp({ binaryFs: fs });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "installApp", app: "myapp", url: "https://x/a.tgz" }],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.deepEqual([...fs.files.keys()].sort(), [
      `${NEXTCLOUD_ROOT}/apps/myapp/appinfo/info.xml`,
      `${NEXTCLOUD_ROOT}/apps/myapp/lib/App.php`,
    ]);
    assert.ok(messages.includes("Downloading app myapp: 100%"));
    assert.deepEqual(occArgv(php.runs.at(-1)), [
      "occ",
      "app:enable",
      "--force",
      "myapp",
    ]);
  });

  it("extracts a ZIP in PHP and skips enabling when enable is false", async () => {
    const zip = zipSync({ "appinfo/info.xml": enc("<info/>") });
    stubFetch(() => new Response(zip));
    const php = fakePhp({ onRun: () => "INSTALL_OK 1" });
    const { publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          {
            step: "installApp",
            appId: "z",
            url: "https://x/z.zip",
            enable: false,
          },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.deepEqual(php.written.get("/tmp/z-install.zip"), zip);
    assert.equal(php.runs.length, 1);
    assert.match(php.runs[0], /ZipArchive/);
  });

  it("falls back to JS extraction when PHP lacks ext/zip", async () => {
    // Two top-level entries: no common prefix is stripped, so re-rooting finds
    // appinfo/ under "inner/".
    const zip = zipSync({
      "inner/appinfo/info.xml": enc("<info/>"),
      "other.txt": enc("x"),
    });
    stubFetch(() => new Response(zip));
    const fs = fakeFs();
    const php = fakePhp({
      ownFs: fs,
      onRun: (script) => {
        if (script.startsWith("<?php @unlink"))
          throw new Error("unlink failed");
        return "NO_ZIP_EXT";
      },
    });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "installApp", appId: "z", url: "https://x/z.zip" }],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.ok(
      messages.some((m) =>
        m.startsWith("[warning] PHP extraction unavailable for z (NO_ZIP_EXT)"),
      ),
    );
    assert.deepEqual(
      [...fs.files.keys()],
      [`${NEXTCLOUD_ROOT}/apps/z/appinfo/info.xml`],
    );
  });

  it("keeps all entries when the archive has no appinfo/info.xml", async () => {
    stubFetch(
      () => new Response(zipSync({ "a.txt": enc("a"), "b.txt": enc("b") })),
    );
    const fs = fakeFs();
    const php = fakePhp({ binaryFs: fs, onRun: () => ({ exitCode: 0 }) });
    const { publish } = collect();
    await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "installApp", appId: "q", url: "https://x/q.zip" }],
      },
      publish,
    });
    assert.deepEqual([...fs.files.keys()].sort(), [
      `${NEXTCLOUD_ROOT}/apps/q/a.txt`,
      `${NEXTCLOUD_ROOT}/apps/q/b.txt`,
    ]);
  });

  it("flags a failed download as a critical failure", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: {
        steps: [{ step: "installApp", appId: "z", url: "https://x/z.zip" }],
      },
      publish,
    });
    assert.equal(result.criticalFailure, true);
    assert.match(
      messages.at(-1),
      /Step "installApp" failed: Failed to fetch .*404/,
    );
  });
});

describe("writeFile step", () => {
  it("warns when the path is missing", async () => {
    const { messages, publish } = collect();
    await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: { steps: [{ step: "writeFile" }] },
      publish,
    });
    assert.deepEqual(messages, ["[warning] writeFile requires a path."]);
  });

  it("writes base64, inline and downloaded content and creates parent dirs", async () => {
    stubFetch(() => new Response("remote body"));
    const php = fakePhp();
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "writeFile", path: "/top.txt", contents: "inline" },
          {
            step: "writeFile",
            path: "config/b.bin",
            content: "aGVs\nbG8=",
            encoding: "base64",
          },
          { step: "writeFile", path: "notes.txt", url: "https://x/n.txt" },
          { step: "writeFile", path: "empty.txt" },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 4);
    assert.equal(dec(php.written.get("/top.txt")), "inline");
    assert.equal(
      dec(php.written.get(`${NEXTCLOUD_ROOT}/config/b.bin`)),
      "hello",
    );
    assert.equal(
      dec(php.written.get(`${NEXTCLOUD_ROOT}/notes.txt`)),
      "remote body",
    );
    assert.equal(dec(php.written.get(`${NEXTCLOUD_ROOT}/empty.txt`)), "");
    assert.ok(messages.includes("Downloading notes.txt: 100%"));
    // /www exists; /www/nextcloud mkdir throws but is ignored.
    assert.ok(php.mkdirs.includes(`${NEXTCLOUD_ROOT}/config`));
    assert.ok(!php.mkdirs.includes("/www"));
    // No user-file targets, so no files:scan.
    assert.equal(php.runs.length, 0);
  });

  it("scans the user after writing into data/<uid>/files", async () => {
    const php = fakePhp();
    const { publish } = collect();
    await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "writeFile", path: "/bob/files/a.md", content: "hi" }],
      },
      publish,
    });
    assert.equal(
      dec(php.written.get(`${NEXTCLOUD_DATA_DIR}/bob/files/a.md`)),
      "hi",
    );
    assert.deepEqual(occArgv(php.runs[0]), ["occ", "files:scan", "bob"]);
  });
});

describe("createShare step", () => {
  it("warns about a missing path and user shares without shareWith", async () => {
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: {
        steps: [
          { step: "createShare" },
          { step: "createShare", path: "/a", shareType: "user" },
          { step: "createShare", path: "/a", shareType: "group" },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 0);
    assert.deepEqual(messages, [
      "[warning] createShare requires a path.",
      "[warning] createShare user/group shares require shareWith.",
      "[warning] createShare user/group shares require shareWith.",
    ]);
  });

  it("passes share options into the generated Share Manager script", async () => {
    const php = fakePhp({ onRun: () => '{"ok":true,"id":1}' });
    const { publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          {
            step: "createShare",
            path: "/carol/files/docs",
            shareType: "user",
            shareWith: "dave",
            permissions: ["read", "share"],
            password: "pw",
            expireDate: "2030-01-01",
            note: "n",
            label: "l",
          },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    const script = php.runs[0];
    assert.match(script, /\$owner = 'carol';/);
    assert.match(script, /\$userPath = 'docs';/);
    assert.match(script, /setShareType\(0\)/);
    assert.match(script, /setPermissions\(17\)/);
    assert.match(script, /setSharedWith\('dave'\)/);
    assert.match(script, /setPassword\('pw'\)/);
    assert.match(script, /new DateTime\('2030-01-01'\)/);
    assert.match(script, /setNote\('n'\)/);
    assert.match(script, /setLabel\('l'\)/);
  });

  it("reports raw output, or a generic error, when PHP returns no error field", async () => {
    const outputs = ["Fatal error: boom", { exitCode: 255 }];
    const php = fakePhp({ onRun: () => outputs.shift() });
    const { messages, publish } = collect();
    await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "createShare", path: "/a" },
          { step: "createShare", path: "/b" },
        ],
      },
      publish,
    });
    assert.ok(
      messages.includes(
        '[warning] Step "createShare" failed: Fatal error: boom',
      ),
    );
    assert.ok(
      messages.includes(
        '[warning] Step "createShare" failed: createShare failed',
      ),
    );
  });
});

describe("unzip step", () => {
  it("warns when destination or url is missing", async () => {
    const { messages, publish } = collect();
    await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: {
        steps: [
          { step: "unzip", destination: "apps/x" },
          { step: "unzip", url: "https://x/a.zip" },
        ],
      },
      publish,
    });
    assert.deepEqual(messages, [
      "[warning] unzip requires a destination and a url.",
      "[warning] unzip requires a destination and a url.",
    ]);
  });

  it("extracts a gzip tar into a relative destination", async () => {
    stubFetch(
      () => new Response(gzipTar({ "static/index.html": enc("<html>") })),
    );
    const fs = fakeFs();
    const php = fakePhp({ binaryFs: fs });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          {
            step: "unzip",
            path: "apps/exe/dist",
            data: { url: "https://x/e.tgz" },
          },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.deepEqual(
      [...fs.files.keys()],
      [`${NEXTCLOUD_ROOT}/apps/exe/dist/index.html`],
    );
    assert.ok(messages.includes("Downloading apps/exe/dist: 100%"));
  });

  it("extracts a ZIP in PHP into an absolute destination", async () => {
    stubFetch(() => new Response(zipSync({ "a.txt": enc("a") })));
    const php = fakePhp({ onRun: () => "UNZIP_OK 1" });
    const { publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "unzip", destination: "/tmp/out", url: "https://x/a.zip" },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.ok(php.written.has("/tmp/unzip-0.zip"));
    assert.match(php.runs[0], /\$target = '\/tmp\/out';/);
  });

  it("falls back to JS extraction when PHP extraction fails", async () => {
    stubFetch(() => new Response(zipSync({ "static/a.txt": enc("a") })));
    const fs = fakeFs();
    const php = fakePhp({
      ownFs: fs,
      onRun: (script) => {
        if (script.startsWith("<?php @unlink"))
          throw new Error("unlink failed");
        return "UNZIP_ERR open=19";
      },
    });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "unzip", destination: "/tmp/out", url: "https://x/a.zip" },
        ],
      },
      publish,
    });
    assert.equal(result.executed, 1);
    assert.ok(
      messages.some((m) =>
        m.includes(
          "PHP extraction unavailable for /tmp/out (UNZIP_ERR open=19)",
        ),
      ),
    );
    assert.deepEqual([...fs.files.keys()], ["/tmp/out/a.txt"]);
  });

  it("does not mark a failed unzip as critical", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    const { messages, publish } = collect();
    const result = await executeBlueprintSteps({
      php: fakePhp(),
      blueprint: {
        steps: [
          { step: "unzip", destination: "/tmp/out", url: "https://x/a.zip" },
        ],
      },
      publish,
    });
    assert.equal(result.criticalFailure, false);
    assert.match(messages.at(-1), /Step "unzip" failed/);
  });
});
