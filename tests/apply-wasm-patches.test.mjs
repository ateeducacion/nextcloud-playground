import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/apply-wasm-patches.sh");
const tmp = mkdtempSync(join(tmpdir(), "wasm-patches-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const CLI_PATCH =
  "(in_array(PHP_SAPI, ['wasm', 'uwsgi'], true) && empty($_SERVER['REQUEST_URI']))";

// Minimal copies of the lines each WASM patch targets.
const COMMON = {
  "lib/private/Config.php": [
    "if (!flock($filePointer, LOCK_SH)) {",
    "if (!flock($filePointer, LOCK_EX)) {",
  ].join("\n"),
  "console.php": "\tif ($user !== $configUser) {\n",
  "lib/private/Avatar/Avatar.php":
    "\t\t$box = imagettfbbox($size, $angle, $font, $text);\n",
};

function stage(name, files) {
  const dir = join(tmp, name);
  for (const [path, body] of Object.entries({ ...COMMON, ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const run = (dir) =>
  spawnSync("sh", [script, dir], { encoding: "utf8", cwd: repo });

describe("scripts/apply-wasm-patches.sh", () => {
  it("patches the OC::$CLI check in lib/base.php (Nextcloud <= 34)", () => {
    const dir = stage("nc34", {
      "lib/base.php": "\t\tself::$CLI = (php_sapi_name() == 'cli');\n",
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    const base = readFileSync(join(dir, "lib/base.php"), "utf8");
    assert.ok(base.includes(`(php_sapi_name() == 'cli') || ${CLI_PATCH}`));
  });

  it("patches the OC::$CLI check in lib/OC.php (Nextcloud >= 35)", () => {
    // Nextcloud 35 moved class OC out of lib/base.php into lib/OC.php and
    // switched the SAPI comparison to ===, so the old patch found no marker.
    const dir = stage("nc35", {
      "lib/base.php": "require_once __DIR__ . '/OC.php';\n\\OC::boot();\n",
      "lib/OC.php": "\t\tself::$CLI = (php_sapi_name() === 'cli');\n",
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    const oc = readFileSync(join(dir, "lib/OC.php"), "utf8");
    assert.ok(oc.includes(`(php_sapi_name() === 'cli') || ${CLI_PATCH}`));
  });

  it("keeps Hasher::hash() working without argon2 (Nextcloud >= 35)", () => {
    // Nextcloud 35 maps the algorithm with a match whose arms name
    // PASSWORD_ARGON2ID/PASSWORD_ARGON2I unconditionally. php-wasm has no
    // argon2, so `occ maintenance:install` died with "Undefined constant
    // OC\Security\PASSWORD_ARGON2ID" while hashing the admin password.
    const hasher = [
      "\t\t$version = match ($alg) {",
      "\t\t\tPASSWORD_ARGON2ID => 3,",
      "\t\t\tPASSWORD_ARGON2I => 2,",
      "\t\t\tPASSWORD_BCRYPT => 1,",
      "\t\t};",
      "\t\tif (\\defined('PASSWORD_ARGON2ID')) {",
      "\t\t\t$default = PASSWORD_ARGON2ID;",
      "",
    ].join("\n");
    const dir = stage("hasher", {
      "lib/base.php": "require_once __DIR__ . '/OC.php';\n",
      "lib/OC.php": "\t\tself::$CLI = (php_sapi_name() === 'cli');\n",
      "lib/private/Security/Hasher.php": hasher,
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    const out = readFileSync(
      join(dir, "lib/private/Security/Hasher.php"),
      "utf8",
    );
    assert.match(
      out,
      /\t'argon2id' => 3,\n\t+'argon2i' => 2,\n\t+PASSWORD_BCRYPT => 1,/,
    );
    assert.doesNotMatch(out, /PASSWORD_ARGON2I(D)? =>/);
    // The defined()-guarded uses are left alone.
    assert.match(out, /\$default = PASSWORD_ARGON2ID;/);
  });

  it("applies the Config, console and Avatar patches", () => {
    const dir = stage("common", {
      "lib/base.php": "\t\tself::$CLI = (php_sapi_name() == 'cli');\n",
    });
    assert.equal(run(dir).status, 0);
    const config = readFileSync(join(dir, "lib/private/Config.php"), "utf8");
    assert.match(config, /LOCK_SH\) && !in_array\(PHP_SAPI/);
    assert.match(config, /LOCK_EX\) && !in_array\(PHP_SAPI/);
    assert.match(
      readFileSync(join(dir, "console.php"), "utf8"),
      /\$configUser && !in_array\(PHP_SAPI/,
    );
    assert.match(
      readFileSync(join(dir, "lib/private/Avatar/Avatar.php"), "utf8"),
      /if \(!is_array\(\$box\)\)/,
    );
  });

  it("fails loudly when a patch target is missing its marker", () => {
    const dir = stage("broken", { "lib/base.php": "<?php\n" });
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /patch did not apply/);
  });
});
