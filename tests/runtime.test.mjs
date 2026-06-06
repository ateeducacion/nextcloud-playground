import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOccInstallScript,
  buildOccScript,
  buildPostInstallConfigScript,
} from "../src/runtime/install-script.js";
import { buildPhpPrepend } from "../src/runtime/php-prepend.js";

describe("buildPhpPrepend (posix polyfill)", () => {
  const prepend = buildPhpPrepend();

  it("is a PHP open tag script", () => {
    assert.ok(prepend.startsWith("<?php"));
  });

  it("guards every posix stub with function_exists", () => {
    for (const fn of [
      "posix_getuid",
      "posix_getpwuid",
      "posix_getgrgid",
      "posix_geteuid",
      "posix_kill",
      "posix_setuid",
    ]) {
      assert.ok(
        prepend.includes(`if (!function_exists('${fn}'))`),
        `missing guard for ${fn}`,
      );
    }
  });

  it("returns uid 33 (www-data) from posix_getuid", () => {
    assert.match(prepend, /function posix_getuid\(\)\s*\{\s*return 33;/);
  });
});

describe("buildOccInstallScript", () => {
  const script = buildOccInstallScript({
    admin: { username: "admin", password: "s3cret", email: "a@e.com" },
  });

  it("invokes maintenance:install against sqlite via console.php", () => {
    assert.ok(script.includes("maintenance:install"));
    assert.ok(script.includes('"--database","sqlite"'));
    assert.ok(script.includes("require '/www/nextcloud/console.php'"));
  });

  it("does not require occ directly (shebang would break strict_types)", () => {
    assert.ok(!script.includes("/occ'"));
  });

  it("clears REQUEST_URI so OC::$CLI is true under the wasm SAPI", () => {
    assert.ok(script.includes("unset($_SERVER['REQUEST_URI'])"));
  });
});

describe("buildOccScript env", () => {
  it("emits putenv lines for provided env vars", () => {
    const script = buildOccScript(["occ", "user:add"], { OC_PASS: "pw" });
    assert.ok(script.includes("putenv('OC_PASS=pw')"));
  });
});

describe("buildPostInstallConfigScript", () => {
  const script = buildPostInstallConfigScript({
    runtimeHost: "example.test",
    debug: { enabled: false },
  });

  it("disables WASM-incompatible features", () => {
    assert.ok(script.includes("'enabledPreviewProviders'] = []"));
    assert.ok(script.includes("'filelocking.enabled'] = false"));
    assert.ok(script.includes("'check_data_directory_permissions'] = false"));
  });

  it("adds the playground host to trusted_domains", () => {
    assert.ok(script.includes("example.test"));
  });

  it("confirms with CONFIG_OK", () => {
    assert.ok(script.includes("CONFIG_OK"));
  });
});
