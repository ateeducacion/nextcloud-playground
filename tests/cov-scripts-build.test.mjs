import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildWorkers,
  phpVersionsToBundle,
  stripUnusedPhpVersions,
} from "../scripts/esbuild.worker.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const MIB = 1024 * 1024;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cov-scripts-build-"));
  temps.push(dir);
  return dir;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runChunk(site) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(repoDir, "scripts/chunk-bundles.mjs"), site],
      { cwd: repoDir, maxBuffer: 16 * MIB },
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

describe("scripts/chunk-bundles.mjs", () => {
  it("splits oversized bundles once and rewrites every manifest", async () => {
    const site = tempDir();
    const manifests = join(site, "assets/manifests");
    const big = Buffer.alloc(25 * MIB + 7, 0xab);
    big.write("tar-zst-head");
    write(join(site, "assets/nextcloud/big.tar.zst"), big);
    write(join(site, "assets/nextcloud/small.tar.zst"), "small");
    const bundle = {
      path: "../nextcloud/big.tar.zst",
      format: "tar.zst",
      sha256: sha256(big).toUpperCase(),
    };
    write(
      join(manifests, "33.json"),
      JSON.stringify({ release: "33", bundle }),
    );
    write(
      join(manifests, "latest.json"),
      JSON.stringify({
        bundle: { ...bundle, format: undefined, fileName: "nc.tar.zst" },
      }),
    );
    const chunked = { bundle: { parts: [{ path: "x.part-000" }] } };
    write(join(manifests, "chunked.json"), JSON.stringify(chunked));
    write(
      join(manifests, "missing.json"),
      JSON.stringify({ bundle: { path: "../nextcloud/gone.tar.zst" } }),
    );
    write(
      join(manifests, "small.json"),
      JSON.stringify({ bundle: { path: "../nextcloud/small.tar.zst" } }),
    );
    write(join(manifests, "nobundle.json"), "{}");
    write(join(manifests, "notes.txt"), "not a manifest");

    const { code, stdout } = await runChunk(site);
    assert.equal(code, 0);
    assert.match(stdout, /33\.json \(tar\.zst\) -> 2 parts \(25 MiB\)/);
    assert.match(stdout, /latest\.json \(unknown\) -> 2 parts/);
    assert.match(stdout, /OK — all files within the 25 MiB per-file limit/);

    const nc = join(site, "assets/nextcloud");
    assert.deepEqual(readdirSync(nc).sort(), [
      "big.tar.zst.part-000",
      "big.tar.zst.part-001",
      "small.tar.zst",
    ]);
    const part0 = readFileSync(join(nc, "big.tar.zst.part-000"));
    const part1 = readFileSync(join(nc, "big.tar.zst.part-001"));
    assert.equal(part0.length, 24 * MIB);
    assert.ok(Buffer.concat([part0, part1]).equals(big));

    const rewritten = JSON.parse(
      readFileSync(join(manifests, "33.json"), "utf8"),
    );
    assert.equal(rewritten.release, "33");
    assert.deepEqual(rewritten.bundle, {
      format: "tar.zst",
      sha256: sha256(big),
      fileName: "big.tar.zst",
      size: big.length,
      totalSize: big.length,
      partSize: 24 * MIB,
      parts: [
        {
          path: "../nextcloud/big.tar.zst.part-000",
          size: part0.length,
          sha256: sha256(part0),
        },
        {
          path: "../nextcloud/big.tar.zst.part-001",
          size: part1.length,
          sha256: sha256(part1),
        },
      ],
    });
    const latest = JSON.parse(
      readFileSync(join(manifests, "latest.json"), "utf8"),
    );
    assert.equal(latest.bundle.fileName, "nc.tar.zst");
    assert.deepEqual(latest.bundle.parts, rewritten.bundle.parts);
    assert.deepEqual(
      JSON.parse(readFileSync(join(manifests, "chunked.json"), "utf8")),
      chunked,
    );
  });

  it("fails without deleting anything when the manifest sha256 disagrees", async () => {
    const site = tempDir();
    const file = join(site, "assets/nextcloud/big.zip");
    write(file, Buffer.alloc(25 * MIB + 1));
    write(
      join(site, "assets/manifests/a.json"),
      JSON.stringify({
        bundle: { path: "../nextcloud/big.zip", sha256: "deadbeef" },
      }),
    );
    const { code, stderr } = await runChunk(site);
    assert.equal(code, 1);
    assert.match(
      stderr,
      /chunk-bundles: big\.zip: sha256 mismatch vs manifest \([0-9a-f]{64} != deadbeef\)/,
    );
    assert.ok(existsSync(file));
  });

  it("fails when a non-bundle file is still over the cap", async () => {
    const site = tempDir();
    write(join(site, "media/huge.bin"), Buffer.alloc(25 * MIB + 1));
    const { code, stdout, stderr } = await runChunk(site);
    assert.equal(code, 1);
    assert.match(stdout, /no oversized bundles to split/);
    assert.match(
      stderr,
      /still exceed the 25 MiB per-file limit:\n {2}25\.0 MiB {2}.*huge\.bin/,
    );
  });
});

describe("scripts/esbuild.worker.mjs", () => {
  const phpWebVersion = JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("@php-wasm/web/package.json"),
      "utf8",
    ),
  ).version;

  function fixtureRepo(runtimes) {
    const dir = tempDir();
    write(join(dir, "playground.config.json"), JSON.stringify({ runtimes }));
    write(
      join(dir, "php-worker.js"),
      [
        'import * as dropped from "@php-wasm/web-7-4";',
        'import loader from "@php-wasm/web-8-3/php_8_3.js";',
        'import icu from "./shared/icu.dat";',
        "export { dropped, icu, loader };",
      ].join("\n"),
    );
    write(
      join(dir, "node_modules/@php-wasm/web-8-3/php_8_3.js"),
      'const dependencyFilename = new URL("./php_8_3.wasm", import.meta.url).href;\nexport default dependencyFilename;\n',
    );
    write(
      join(dir, "node_modules/@php-wasm/web-8-3/php_8_3.wasm"),
      Buffer.from([0, 97, 115, 109]),
    );
    write(join(dir, "sw.js"), "self.swMarker = 42;\n");
    write(join(dir, "dist/stale.txt"), "old build");
    return dir;
  }

  it("reads the offered PHP versions from playground.config.json", () => {
    const dir = tempDir();
    write(
      join(dir, "playground.config.json"),
      JSON.stringify({
        runtimes: [
          { phpVersion: "8.3" },
          { phpVersion: "8.3" },
          { phpVersion: "8.4" },
          {},
        ],
      }),
    );
    assert.deepEqual(phpVersionsToBundle(dir), {
      keepVersions: ["8-3", "8-4"],
      dropVersions: ["5-2", "7-4", "8-0", "8-1", "8-2", "8-5"],
    });
    write(join(dir, "playground.config.json"), "{}");
    assert.deepEqual(phpVersionsToBundle(dir).keepVersions, []);
    assert.equal(phpVersionsToBundle(dir).dropVersions.length, 8);
    assert.deepEqual(phpVersionsToBundle(repoDir).keepVersions, ["8-3"]);
  });

  it("registers no stub hooks when every version is offered", () => {
    const calls = [];
    const api = {
      onResolve: () => calls.push("resolve"),
      onLoad: () => calls.push("load"),
    };
    stripUnusedPhpVersions([]).setup(api);
    assert.deepEqual(calls, []);
  });

  it("bundles the worker and service worker with the PHP plugins applied", async () => {
    const dir = fixtureRepo([{ phpVersion: "8.3" }]);
    const logged = [];
    const realLog = console.log;
    console.log = (msg) => logged.push(msg);
    let kept;
    try {
      kept = await buildWorkers(dir);
    } finally {
      console.log = realLog;
    }
    assert.deepEqual(kept, ["8-3"]);
    assert.deepEqual(logged, [
      "Built dist/php-worker.bundle.js (bundled PHP runtimes: 8-3)",
    ]);

    const dist = readdirSync(join(dir, "dist"));
    assert.ok(!dist.includes("stale.txt"), "dist/ is cleaned first");
    assert.ok(
      dist.some((f) => /^php_8_3-[A-Z0-9]+\.wasm$/.test(f)),
      dist.join(),
    );
    const bundle = readFileSync(join(dir, "dist/php-worker.bundle.js"), "utf8");
    assert.match(
      bundle,
      /^const __APP_ROOT__ = new URL\("\.\.\/", import\.meta\.url\)\.href;/,
    );
    assert.match(
      bundle,
      /PHP runtime not bundled in this build: @php-wasm\/web-7-4/,
    );
    assert.match(bundle, /PHP intl not bundled in this build/);
    assert.ok(
      bundle.includes(
        `https://unpkg.com/@php-wasm/web@${phpWebVersion}/shared/icu.dat`,
      ),
    );
    assert.doesNotMatch(bundle, /new URL\("\.\/php_8_3\.wasm"/);
    assert.match(
      readFileSync(join(dir, "sw.bundle.js"), "utf8"),
      /^\(\(\) => \{[\s\S]*swMarker = 42/,
    );
  });

  it("fails when an offered PHP version emits no .wasm", async () => {
    const dir = fixtureRepo([{ phpVersion: "8.3" }, { phpVersion: "8.2" }]);
    await assert.rejects(
      buildWorkers(dir),
      /No \.wasm emitted for PHP 8-2; check phpWasmUrlToImport/,
    );
  });
});
