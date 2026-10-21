import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import zlib from "node:zlib";
import { readUstarTar } from "../scripts/lib/tar-ustar.mjs";
import {
  defaultVersion,
  findVersion,
  NEXTCLOUD_VERSIONS,
} from "../src/shared/nextcloud-versions.js";
import { FAKES, repo, runScript } from "./fixtures/cov-tools/run.mjs";

const tmp = mkdtempSync(join(tmpdir(), "cov-tools-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("src/shared/nextcloud-versions.js", () => {
  it("flags exactly one default entry and returns it", () => {
    assert.equal(NEXTCLOUD_VERSIONS.filter((v) => v.default).length, 1);
    assert.equal(defaultVersion().default, true);
    assert.equal(
      defaultVersion(),
      NEXTCLOUD_VERSIONS.find((v) => v.default),
    );
  });

  it("finds versions by numeric or string major", () => {
    assert.equal(findVersion(31)?.release, "latest-31");
    assert.equal(findVersion("33")?.major, "33");
    assert.equal(findVersion("29"), undefined);
  });

  it("falls back to the first entry when none is flagged default", () => {
    const flagged = NEXTCLOUD_VERSIONS.filter((v) => v.default);
    for (const v of flagged) v.default = false;
    try {
      assert.equal(defaultVersion(), NEXTCLOUD_VERSIONS[0]);
    } finally {
      for (const v of flagged) v.default = true;
    }
  });
});

describe("scripts/generate-manifest.mjs", () => {
  it("writes a tar.zst manifest with the bundle hash, size and relative path", () => {
    const dir = join(tmp, "manifest");
    mkdirSync(join(dir, "bundles"), { recursive: true });
    const bundle = join(dir, "bundles", "nextcloud-33.tar.zst");
    writeFileSync(bundle, "bundle-bytes");
    const manifest = join(dir, "manifests", "nextcloud-33.json");
    mkdirSync(join(dir, "manifests"));
    const run = runScript("scripts/generate-manifest.mjs", {
      args: [
        "positional-ignored",
        "--manifest",
        manifest,
        "--bundle",
        bundle,
        "--channel",
        "stable",
        "--release",
        "latest-33",
        "--sourceRepository",
        "nextcloud/server",
        "--sourceBranch",
        "stable33",
        "--sourceCommit",
        "abc123",
        "--fileCount",
        "42",
      ],
    });
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(manifest, "utf8");
    assert.ok(text.endsWith("}\n"));
    const json = JSON.parse(text);
    assert.equal(json.schemaVersion, 2);
    assert.ok(!Number.isNaN(Date.parse(json.generatedAt)));
    assert.equal(json.channel, "stable");
    assert.equal(json.release, "latest-33");
    assert.deepEqual(json.source, {
      repository: "nextcloud/server",
      branch: "stable33",
      commit: "abc123",
    });
    assert.deepEqual(json.bundle, {
      format: "tar.zst",
      container: "tar",
      codec: "zstd",
      path: "../bundles/nextcloud-33.tar.zst",
      size: 12,
      sha256: sha(Buffer.from("bundle-bytes")),
      fileCount: 42,
    });
  });

  it("defaults fileCount to 0", () => {
    const bundle = join(tmp, "b.tar.zst");
    writeFileSync(bundle, "x");
    const manifest = join(tmp, "m.json");
    const run = runScript("scripts/generate-manifest.mjs", {
      args: ["--manifest", manifest, "--bundle", bundle],
    });
    assert.equal(run.status, 0, run.stderr);
    const json = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(json.bundle.fileCount, 0);
    assert.equal(json.bundle.path, "b.tar.zst");
  });

  it("rejects a flag without a value", () => {
    const run = runScript("scripts/generate-manifest.mjs", {
      args: ["--manifest", "--bundle", "x"],
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Missing value for --manifest/);
    const last = runScript("scripts/generate-manifest.mjs", {
      args: ["--manifest"],
    });
    assert.match(last.stderr, /Missing value for --manifest/);
  });
});

describe("scripts/build-tar-zst-bundle.mjs", () => {
  const stage = join(tmp, "stage");
  mkdirSync(join(stage, "core", "deep"), { recursive: true });
  mkdirSync(join(stage, "empty"));
  writeFileSync(join(stage, "index.php"), "<?php echo 1;");
  writeFileSync(join(stage, "core", "deep", "a.txt"), "hello");
  symlinkSync(join(stage, "index.php"), join(stage, "link.php"));

  it("packs regular files (not symlinks) into a deterministic tar", () => {
    const out = join(tmp, "identity.tar.zst");
    const run = runScript("scripts/build-tar-zst-bundle.mjs", {
      args: [stage, out],
      stubs: FAKES.zlib,
      env: { COV_ZLIB: "identity" },
    });
    assert.equal(run.status, 0, run.stderr);
    const tar = readFileSync(out);
    const stats = JSON.parse(run.stdout);
    assert.deepEqual(stats, {
      fileCount: 2,
      dirCount: 0,
      bytes: tar.length,
      sha256: sha(tar),
      uncompressedBytes: "<?php echo 1;".length + "hello".length,
    });
    const files = readUstarTar(tar).filter((e) => e.type !== "dir");
    assert.deepEqual(
      files.map((e) => [e.name, Buffer.from(e.data).toString()]),
      [
        ["core/deep/a.txt", "hello"],
        ["index.php", "<?php echo 1;"],
      ],
    );
    const zstd = run.calls.find((c) => c.zstd);
    const { constants } = zstd;
    assert.deepEqual(zstd.zstd.params, {
      [constants.ZSTD_c_compressionLevel]: 19,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [constants.ZSTD_c_windowLog]: 24,
    });
    // Same input → byte-identical output (mtime pinned to 0).
    const again = join(tmp, "identity-2.tar.zst");
    runScript("scripts/build-tar-zst-bundle.mjs", {
      args: [stage, again],
      stubs: FAKES.zlib,
      env: { COV_ZLIB: "identity" },
    });
    assert.equal(sha(readFileSync(again)), stats.sha256);
  });

  it("produces a real zstd stream when node:zlib supports it", {
    skip: typeof zlib.zstdDecompressSync !== "function",
  }, () => {
    const out = join(tmp, "real.tar.zst");
    const run = runScript("scripts/build-tar-zst-bundle.mjs", {
      args: [stage, out],
    });
    assert.equal(run.status, 0, run.stderr);
    const names = readUstarTar(zlib.zstdDecompressSync(readFileSync(out)))
      .filter((e) => e.type !== "dir")
      .map((e) => e.name);
    assert.deepEqual(names, ["core/deep/a.txt", "index.php"]);
  });

  it("refuses to run without native zstd", () => {
    const run = runScript("scripts/build-tar-zst-bundle.mjs", {
      args: [stage, join(tmp, "never.tar.zst")],
      stubs: FAKES.zlib,
      env: { COV_ZLIB: "missing" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Node >= 22\.15/);
  });

  it("prints usage without both arguments", () => {
    const run = runScript("scripts/build-tar-zst-bundle.mjs", {
      args: [stage],
      stubs: FAKES.zlib,
      env: { COV_ZLIB: "identity" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Usage: build-tar-zst-bundle\.mjs/);
  });
});

describe("scripts/cleanup-cloudflare-pages.mjs", () => {
  const deployments = [
    { Id: "d1", Environment: "production", Branch: "main", Source: "s1" },
    { Id: "d2", Environment: "production", Branch: "main", Source: "s2" },
    { Id: "d3", Environment: "preview", Branch: "feature/x", Source: "s3" },
    { Id: "d4", Environment: "preview", Branch: "feature/x", Source: "s4" },
    { Id: "d5", Environment: "preview", Branch: "feature/y", Source: "s5" },
  ];
  const baseEnv = {
    CLOUDFLARE_PAGES_PROJECT: "nc-pg",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_PAGES_BRANCH: "",
    CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "",
    CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "",
  };
  const listResponse = {
    match: "npx wrangler pages deployment list --project-name nc-pg --json",
    status: 0,
    stdout: JSON.stringify(deployments),
  };
  const run = (env, responses) =>
    runScript("scripts/cleanup-cloudflare-pages.mjs", {
      stubs: FAKES.childProcess,
      env: { ...baseEnv, ...env, COV_CP: { responses } },
    });

  it("requires the project and account", () => {
    const noProject = run({ CLOUDFLARE_PAGES_PROJECT: "" }, []);
    assert.notEqual(noProject.status, 0);
    assert.match(noProject.stderr, /CLOUDFLARE_PAGES_PROJECT is required/);
    const noAccount = run({ CLOUDFLARE_ACCOUNT_ID: "" }, []);
    assert.match(noAccount.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
    assert.deepEqual(noAccount.calls, []);
  });

  it("keeps the newest deployment per environment/branch and deletes the rest", () => {
    const result = run({}, [
      listResponse,
      { match: "delete d2", status: 0 },
      { match: "delete d4", status: 1, stdout: "out", stderr: "boom" },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const deletes = result.calls.filter((c) => c.cp.includes(" delete "));
    assert.deepEqual(
      deletes.map((c) => c.cp),
      [
        "npx wrangler pages deployment delete d2 --project-name nc-pg --force",
        "npx wrangler pages deployment delete d4 --project-name nc-pg --force",
      ],
    );
    assert.match(result.stdout, /Deleted d2 \(production\/main\/s2\)/);
    assert.match(
      result.stdout,
      /Skipped d4 \(preview\/feature\/x\/s4\): wrangler pages deployment delete d4 .*failed\nout\nboom/,
    );
  });

  it("deletes every deployment of a closed branch, dry-run only logs", () => {
    const result = run(
      {
        CLOUDFLARE_PAGES_BRANCH: "feature/x",
        CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "true",
        CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "true",
      },
      [listResponse],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "[dry-run] Would delete d2 (production/main/s2)",
      "[dry-run] Would delete d3 (preview/feature/x/s3)",
      "[dry-run] Would delete d4 (preview/feature/x/s4)",
    ]);
  });

  it("reports when nothing is stale", () => {
    const result = run({}, [
      {
        ...listResponse,
        stdout: JSON.stringify([deployments[0], deployments[4]]),
      },
    ]);
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /No stale Cloudflare Pages deployments found for nc-pg\./,
    );
  });

  it("fails when the deployment list cannot be fetched", () => {
    const result = run({}, [
      { match: "list", status: 1, stderr: "auth error" },
    ]);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /wrangler pages deployment list .* failed\nauth error/,
    );
  });
});

describe("scripts/write-build-version.mjs", () => {
  const VERSION = "20260101.120000-abcdef12";
  const stubs = { ...FAKES.fs, ...FAKES.childProcess };

  it("prints only the version with --print-version", () => {
    const run = runScript("scripts/write-build-version.mjs", {
      args: ["--print-version"],
      stubs,
      env: {
        BUILD_VERSION: VERSION,
        COV_FS: { intercept: ["mkdirSync", "writeFileSync"] },
        COV_CP: { responses: [] },
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${VERSION}\n`);
    assert.ok(!run.calls.some((c) => c.fs));
  });

  it("writes the JS module and JSON metadata from git state", () => {
    const run = runScript("scripts/write-build-version.mjs", {
      stubs,
      env: {
        BUILD_VERSION: "",
        BUILD_SHA: "",
        COV_FS: { intercept: ["mkdirSync", "writeFileSync"] },
        COV_CP: {
          responses: [
            { match: "git rev-parse HEAD", stdout: "0123456789abcdef\n" },
            { match: "git status --porcelain", stdout: " M file\n" },
          ],
        },
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const writes = run.calls.filter((c) => c.fs === "writeFileSync");
    assert.deepEqual(
      writes.map((c) => c.args[0]),
      [
        resolve(repo, "src/generated/build-version.js"),
        resolve(repo, "assets/build-version.json"),
      ],
    );
    const json = JSON.parse(writes[1].args[1]);
    assert.equal(json.gitSha, "01234567");
    assert.equal(json.dirty, true);
    assert.match(writes[0].args[1], /export const BUILD_VERSION = /);
    assert.ok(writes[0].args[1].includes(JSON.stringify(json.buildVersion)));
    assert.deepEqual(
      run.calls.filter((c) => c.fs === "mkdirSync").map((c) => c.args[0]),
      [resolve(repo, "src/generated"), resolve(repo, "assets")],
    );
    assert.equal(run.stdout, `Wrote build metadata ${json.buildVersion}\n`);
    assert.match(json.buildVersion, /-01234567-dirty$|01234567.*dirty/);
  });

  it("falls back to 'nogit' when git is unavailable", () => {
    const run = runScript("scripts/write-build-version.mjs", {
      args: ["--print-version"],
      stubs,
      env: {
        BUILD_VERSION: "",
        BUILD_SHA: "",
        COV_CP: {
          responses: [{ match: "git", status: 128, stderr: "no repo" }],
        },
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nogit/);
    assert.doesNotMatch(run.stdout, /dirty/);
  });
});

describe("scripts/prepare-runtime.mjs and sync-browser-deps.mjs", () => {
  it("creates the cache, asset and vendor directories", () => {
    const run = runScript("scripts/prepare-runtime.mjs", {
      stubs: FAKES.fs,
      env: { COV_FS: { intercept: ["mkdirSync"] } },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      run.calls.map((c) => [c.args[0], c.args[1]]),
      [
        ".cache",
        ".cache/nextcloud-source",
        "assets/nextcloud",
        "assets/manifests",
        "vendor",
      ].map((p) => [resolve(repo, p), { recursive: true }]),
    );
    assert.equal(
      run.stdout,
      "Prepared cache, asset, and vendor directories.\n",
    );
  });

  it("replaces vendor/fflate with a fresh copy of node_modules/fflate", () => {
    const run = runScript("scripts/sync-browser-deps.mjs", {
      stubs: FAKES.fs,
      env: { COV_FS: { intercept: ["mkdirSync", "rmSync", "cpSync"] } },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      run.calls.map((c) => [c.fs, ...c.args]),
      [
        ["mkdirSync", resolve(repo, "vendor"), { recursive: true }],
        [
          "rmSync",
          resolve(repo, "vendor/fflate"),
          { recursive: true, force: true },
        ],
        [
          "cpSync",
          resolve(repo, "node_modules/fflate"),
          resolve(repo, "vendor/fflate"),
          { recursive: true },
        ],
      ],
    );
    assert.equal(run.stdout, "Synced browser dependencies into vendor/.\n");
  });
});

describe("scripts/generate-screenshot.mjs", () => {
  it("waits for the Files frame, then captures a 2x screenshot", () => {
    const run = runScript("scripts/generate-screenshot.mjs", {
      stubs: FAKES.playwright,
      env: {
        PLAYWRIGHT_BASE_URL: "http://pg.test/",
        COV_PW: { frameAfter: 2 },
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const out = resolve(repo, ".github/screenshot.png");
    assert.deepEqual(
      run.calls.map((c) => c.pw),
      [
        "launch",
        "newPage",
        "setDefaultTimeout",
        "goto",
        "waitForFunction",
        "waitForTimeout",
        "waitForTimeout",
        "waitForSelector",
        "waitForTimeout",
        "screenshot",
        "close",
      ],
    );
    const byName = Object.fromEntries(run.calls.map((c) => [c.pw, c]));
    assert.deepEqual(byName.newPage.options, {
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    assert.equal(byName.goto.url, "http://pg.test/");
    assert.equal(byName.waitForFunction.result, true);
    assert.equal(
      byName.waitForSelector.selector,
      "[data-cy-files-list-row], .files-list__table",
    );
    assert.equal(byName.screenshot.path, out);
    assert.equal(run.stdout, `Saved screenshot to ${out}\n`);
  });

  it("gives up when the Files frame never appears", () => {
    const run = runScript("scripts/generate-screenshot.mjs", {
      stubs: FAKES.playwright,
      env: { PLAYWRIGHT_BASE_URL: "", COV_PW: { frameAfter: null } },
    });
    assert.notEqual(run.status, 0);
    assert.match(
      run.stderr,
      /Timed out waiting for the Nextcloud Files frame\./,
    );
    assert.equal(
      run.calls.find((c) => c.pw === "goto").url,
      "http://127.0.0.1:8085",
    );
    assert.equal(
      run.calls.filter((c) => c.pw === "waitForTimeout").length,
      120,
    );
    assert.ok(!run.calls.some((c) => c.pw === "screenshot"));
  });
});
