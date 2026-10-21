import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import {
  bootstrapNextcloud,
  manifestNameForRuntime,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_PREPEND_PATH,
  startCoreArchivePrefetch,
} from "../src/runtime/bootstrap.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONFIG_PHP = "/www/nextcloud/config/config.php";
const PHP_INI = "/internal/shared/php.ini";
const baseConfig = JSON.parse(
  readFileSync(new URL("../playground.config.json", import.meta.url), "utf8"),
);

const coreBytes = new Uint8Array(
  gzipSync(
    createUstarTar(
      normalizeEntries({
        "index.php": encoder.encode("<?php // front controller"),
        "console.php": encoder.encode("<?php // occ"),
      }),
    ),
  ),
);
const manifest = {
  release: "33.0.1",
  generatedAt: "2026-01-01T00:00:00Z",
  bundle: { path: "nc.tar.gz", codec: "gzip", sha256: "abc", fileCount: 2 },
};
const MANIFEST_VERSION = "33.0.1:abc";

// Fake of the wrapped PHP runtime (php-compat surface) plus the raw `_php`
// instance used for ini entries and tar extraction. occ runs are scripted by
// the argv they carry.
function fakeNextcloud({
  installSucceeds = true,
  configOk = true,
  occThrows = false,
  autologin = '{"ok":true}',
  requestError = null,
  files: seed = {},
  dirs: seedDirs = [],
} = {}) {
  const files = new Map(
    Object.entries(seed).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const dirs = new Set(seedDirs);
  const runs = [];
  const requests = [];
  const php = {
    async analyzePath(path) {
      return { exists: files.has(path) || dirs.has(path) };
    },
    async mkdir(path) {
      if (path === "/tmp") throw new Error("EEXIST");
      dirs.add(path);
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    async run(code) {
      runs.push(code);
      if (code.includes('"maintenance:install"')) {
        if (!installSucceeds) {
          return { exitCode: 1, bytes: encoder.encode("SQLite error") };
        }
        files.set(CONFIG_PHP, encoder.encode("<?php 'installed' => true,"));
        return { exitCode: 0, bytes: encoder.encode("installed") };
      }
      if (code.includes("CONFIG_OK")) {
        return { bytes: encoder.encode(configOk ? "CONFIG_OK" : "nope") };
      }
      if (occThrows) throw new Error("occ crashed");
      return { exitCode: 0 };
    },
    async request(request) {
      requests.push(request.url);
      if (requestError) throw requestError;
      return new Response(autologin);
    },
    _php: {
      readFileAsText: (path) =>
        files.has(path) ? decoder.decode(files.get(path)) : "",
      writeFile: (path, data) =>
        files.set(path, typeof data === "string" ? encoder.encode(data) : data),
      mkdirTree: (path) => dirs.add(path),
    },
  };
  const text = (path) =>
    files.has(path) ? decoder.decode(files.get(path)) : undefined;
  return { php, files, dirs, runs, requests, text };
}

function recorder() {
  const messages = [];
  const publish = (message, ratio) => messages.push({ message, ratio });
  publish.messages = messages;
  publish.has = (pattern) =>
    messages.some(({ message }) => pattern.test(message));
  return publish;
}

function boot(fake, overrides = {}) {
  const publish = recorder();
  return bootstrapNextcloud({
    config: baseConfig,
    blueprint: {},
    clean: false,
    corePrefetch: Promise.resolve({ manifest, bytes: coreBytes }),
    php: fake.php,
    publish,
    runtimeId: "php83-nc33",
    ...overrides,
    ...(overrides.publish ? {} : { publish }),
  }).then((result) => ({ result, publish: overrides.publish || publish }));
}

const occRuns = (runs, command) =>
  runs.filter((code) => code.includes(`"${command}"`));

const installedState = (manifestVersion = MANIFEST_VERSION) => ({
  [CONFIG_PHP]: "<?php $CONFIG = ['installed' => true];",
  [PLAYGROUND_CONFIG_PATH]: JSON.stringify({ manifestVersion }),
});

afterEach(() => mock.restoreAll());

describe("manifestNameForRuntime", () => {
  it("maps a runtime id to its version manifest, else latest.json", () => {
    assert.equal(
      manifestNameForRuntime(baseConfig, "php83-nc30"),
      "nextcloud-30.json",
    );
    assert.equal(manifestNameForRuntime(baseConfig, "nope"), "latest.json");
    assert.equal(manifestNameForRuntime(null, "php83-nc30"), "latest.json");
  });
});

describe("bootstrapNextcloud fresh install", () => {
  it("mounts the core, installs, configures, signs in and indexes files", async () => {
    const fake = fakeNextcloud();
    const { result, publish } = await boot(fake, {
      blueprint: {
        siteOptions: { timezone: "Europe/Madrid" },
        debug: { enabled: true },
      },
    });

    assert.equal(result.readyPath, "/index.php/apps/files/files");
    // Core extracted from the prefetched tar into the web root.
    assert.equal(
      fake.text("/www/nextcloud/index.php"),
      "<?php // front controller",
    );
    for (const dir of [
      "/www/nextcloud/data",
      "/www/nextcloud/config",
      "/internal/shared",
    ]) {
      assert.ok(fake.dirs.has(dir), `missing ${dir}`);
    }
    assert.match(fake.text(PLAYGROUND_PREPEND_PATH), /posix_getuid/);
    const ini = fake.text(PHP_INI);
    assert.match(
      ini,
      /auto_prepend_file\s*=\s*"?\/internal\/shared\/auto_prepend_file\.php/,
    );
    assert.match(ini, /date\.timezone\s*=\s*"?Europe\/Madrid/);
    assert.match(ini, /display_errors\s*=\s*"?On/);

    assert.equal(occRuns(fake.runs, "maintenance:install").length, 1);
    assert.equal(occRuns(fake.runs, "background:webcron").length, 1);
    const [scan] = occRuns(fake.runs, "files:scan");
    assert.match(scan, /"files:scan","admin"/);
    assert.deepEqual(fake.requests, [
      "http://localhost/_playground_autologin.php",
    ]);

    const state = JSON.parse(fake.text(PLAYGROUND_CONFIG_PATH));
    assert.equal(state.manifestVersion, MANIFEST_VERSION);
    assert.equal(state.runtimeId, "php83-nc33");
    assert.deepEqual(state.admin, { username: "admin" });
    assert.ok(publish.has(/^Autologin successful\.$/));
    assert.ok(publish.has(/^Nextcloud is ready\.$/));
    assert.equal(publish.has(/\[warning\]/), false);
  });

  it("throws with the occ output when the install did not complete", async () => {
    const fake = fakeNextcloud({ installSucceeds: false });
    await assert.rejects(
      boot(fake),
      /install failed \(exit 1\):\nSQLite error/,
    );
    assert.equal(fake.files.has(PLAYGROUND_CONFIG_PATH), false);
  });

  it("warns on an unconfirmed config and ignores best-effort occ failures", async () => {
    const fake = fakeNextcloud({ configOk: false, occThrows: true });
    const { result, publish } = await boot(fake, {
      config: { ...baseConfig, autologin: false },
    });
    assert.equal(result.readyPath, "/index.php/apps/files/files");
    assert.ok(publish.has(/Post-install config did not confirm: nope/));
    assert.deepEqual(fake.requests, []);
    assert.ok(fake.files.has(PLAYGROUND_CONFIG_PATH));
  });

  it("reinstalls when the saved state is unreadable or config.php cannot be read", async () => {
    const fake = fakeNextcloud({
      files: { [PLAYGROUND_CONFIG_PATH]: "{not json" },
      dirs: [CONFIG_PHP],
    });
    await boot(fake);
    assert.equal(occRuns(fake.runs, "maintenance:install").length, 1);
  });
});

describe("bootstrapNextcloud reuse", () => {
  it("skips the install and non-reload steps when the bundle version matches", async () => {
    const fake = fakeNextcloud({ files: installedState() });
    const { result, publish } = await boot(fake, {
      blueprint: {
        landingPage: "/index.php/apps/dashboard",
        steps: [{ step: "enableApp", app: "calendar" }],
      },
    });
    assert.equal(result.readyPath, "/index.php/apps/dashboard");
    assert.ok(publish.has(/Skipping install/));
    assert.ok(publish.has(/Skipping enableApp on reload/));
    assert.equal(occRuns(fake.runs, "maintenance:install").length, 0);
    assert.equal(occRuns(fake.runs, "app:enable").length, 0);
    assert.equal(occRuns(fake.runs, "files:scan").length, 0);
    // The autologin session is per boot, so it still runs.
    assert.equal(fake.requests.length, 1);
  });

  it("reinstalls on a clean boot or a different bundle version", async () => {
    for (const [files, clean] of [
      [installedState(), true],
      [installedState("33.0.0:old"), false],
    ]) {
      const fake = fakeNextcloud({ files });
      await boot(fake, { clean });
      assert.equal(occRuns(fake.runs, "maintenance:install").length, 1);
    }
  });
});

describe("bootstrapNextcloud blueprint steps", () => {
  it("does not cache the install when a critical step fails", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    const fake = fakeNextcloud();
    const { publish } = await boot(fake, {
      blueprint: {
        steps: [
          {
            step: "installApp",
            appId: "exe",
            url: "https://apps.test/exe.zip",
          },
        ],
      },
    });
    assert.ok(publish.has(/Step "installApp" failed/));
    assert.ok(publish.has(/not caching the install/));
    assert.equal(fake.files.has(PLAYGROUND_CONFIG_PATH), false);
  });

  it("keeps the session of a blueprint login instead of the admin autologin", async () => {
    const fake = fakeNextcloud({ autologin: '{"ok":true,"uid":"alice"}' });
    const { publish } = await boot(fake, {
      blueprint: {
        steps: [{ step: "login", username: "alice", password: "pw" }],
      },
    });
    assert.equal(fake.requests.length, 1);
    assert.ok(publish.has(/Signing in: alice/));
    assert.equal(publish.has(/Signing in the admin user/), false);
    assert.ok(fake.files.has(PLAYGROUND_CONFIG_PATH));
  });
});

describe("bootstrapNextcloud autologin outcomes", () => {
  for (const [label, options, pattern] of [
    ["non-JSON output", { autologin: "<html>" }, /unexpected output/],
    [
      "a reported error",
      { autologin: '{"ok":false,"error":"bad pass"}' },
      /Autologin failed: bad pass/,
    ],
    [
      "an unexplained failure",
      { autologin: '{"ok":false}' },
      /failed: unknown/,
    ],
    [
      "a request error",
      { requestError: new Error("socket closed") },
      /Autologin error: socket closed/,
    ],
  ]) {
    it(`reports ${label} as a warning and still finishes`, async () => {
      const fake = fakeNextcloud(options);
      const { result, publish } = await boot(fake);
      assert.ok(publish.has(pattern));
      assert.equal(result.readyPath, "/index.php/apps/files/files");
    });
  }
});

describe("core archive fetching", () => {
  function stubAssets() {
    const urls = [];
    mock.method(globalThis, "fetch", async (url) => {
      urls.push(String(url));
      if (String(url).endsWith(".json")) {
        return Response.json({
          ...manifest,
          bundle: { ...manifest.bundle, sha256: undefined },
        });
      }
      return new Response(coreBytes);
    });
    return urls;
  }

  it("prefetches the manifest and core bytes for a runtime", async () => {
    const urls = stubAssets();
    const progress = [];
    const prefetched = await startCoreArchivePrefetch({
      manifestName: "nextcloud-31.json",
      onProgress: (event) => progress.push(event.ratio),
    });
    assert.match(urls[0], /assets\/manifests\/nextcloud-31\.json$/);
    assert.match(urls[1], /assets\/manifests\/nc\.tar\.gz$/);
    assert.deepEqual(prefetched.bytes, coreBytes);
    assert.equal(prefetched.manifest.release, "33.0.1");
    assert.deepEqual(progress, [1]);
  });

  it("fetches the runtime manifest lazily without a prefetch", async () => {
    const urls = stubAssets();
    const fake = fakeNextcloud();
    await boot(fake, { corePrefetch: null, runtimeId: "php83-nc30" });
    assert.match(urls[0], /nextcloud-30\.json$/);
    assert.equal(fake.text("/www/nextcloud/console.php"), "<?php // occ");
    const state = JSON.parse(fake.text(PLAYGROUND_CONFIG_PATH));
    assert.equal(state.manifestVersion, "33.0.1:");
  });
});
