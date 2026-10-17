import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "../src/runtime/php-loader.js";

const {
  buildPhpIniEntries,
  writeOpcacheBlacklist,
  OPCACHE_BLACKLIST_PATH,
  OPCACHE_BLACKLIST,
} = __testing;

describe("OPcache file cache configuration", () => {
  const ini = buildPhpIniEntries();

  it("keeps the file cache but validates timestamps on every request", () => {
    assert.equal(ini["opcache.enable"], "1");
    assert.equal(ini["opcache.file_cache_only"], "1");
    assert.equal(ini["opcache.file_cache"], "/internal/shared/opcache");
    // validate_timestamps=0 served stale bytecode for rewritten files on PHP
    // 8.5 (no SAPI whitelist) and whenever the SAPI name makes the cache live.
    assert.equal(ini["opcache.validate_timestamps"], "1");
    assert.equal(ini["opcache.revalidate_freq"], "0");
    assert.equal(ini["opcache.blacklist_filename"], OPCACHE_BLACKLIST_PATH);
    // PHP's default 2 s file_update_protection must stay in force.
    assert.equal(ini["opcache.file_update_protection"], undefined);
  });

  it("blacklists the single path php.run({ code }) compiles", () => {
    assert.equal(OPCACHE_BLACKLIST, "/internal/eval.php\n");
    assert.ok(OPCACHE_BLACKLIST_PATH.startsWith("/internal/shared/"));
  });

  it("writes the blacklist file even when the parent directory exists", () => {
    const written = new Map();
    const php = {
      writeFile(path, data) {
        written.set(path, data);
      },
    };
    const FS = {
      mkdirTree() {
        throw new Error("EEXIST");
      },
    };
    writeOpcacheBlacklist(php, FS);
    assert.equal(written.get(OPCACHE_BLACKLIST_PATH), OPCACHE_BLACKLIST);
  });
});
