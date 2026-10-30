import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutologinScript,
  buildLoginScript,
} from "../src/runtime/autologin-script.js";
import {
  parseJsonFromPhpOutput,
  resolveSharePath,
  resolveSharePermissions,
  resolveShareType,
  resolveWriteFileTarget,
  stepAppId,
  stepGroupId,
  stepUsername,
} from "../src/runtime/blueprint-step-utils.js";
import { runsOnReload } from "../src/runtime/blueprint-steps.js";
import {
  NEXTCLOUD_DATA_DIR,
  NEXTCLOUD_ROOT,
} from "../src/runtime/bootstrap-paths.js";
import {
  buildOccInstallScript,
  buildOccScript,
  buildPostInstallConfigScript,
} from "../src/runtime/install-script.js";
import { buildCreateShareScript } from "../src/runtime/share-script.js";

describe("step field helpers", () => {
  it("return empty strings for missing steps and honour fallbacks", () => {
    assert.equal(stepAppId(undefined), "");
    assert.equal(stepGroupId(null), "");
    assert.equal(stepUsername(undefined), "");
    assert.equal(stepUsername({ owner: " carol " }), "carol");
    assert.equal(stepUsername({}, "admin"), "admin");
  });
});

describe("resolveShareType", () => {
  it("defaults to a public link and maps email aliases", () => {
    assert.equal(resolveShareType(undefined), 3);
    assert.equal(resolveShareType(" Mail "), 4);
    assert.equal(resolveShareType("-1"), -1);
  });
});

describe("resolveSharePermissions", () => {
  it("ORs arrays of names and numbers", () => {
    assert.equal(resolveSharePermissions(["read", "write", 4], 3), 7);
    assert.equal(resolveSharePermissions("ALL", 3), 31);
    assert.equal(resolveSharePermissions(8, 3), 8);
    assert.equal(resolveSharePermissions("16", 3), 16);
    assert.equal(resolveSharePermissions(null, 1), 31);
    assert.equal(resolveSharePermissions("", 3), 1);
  });

  it("rejects unknown permission names", () => {
    assert.throws(
      () => resolveSharePermissions(["read", "fly"], 3),
      /Unknown permissions: fly/,
    );
    assert.throws(
      () => resolveSharePermissions([null], 3),
      /Unknown permissions/,
    );
  });
});

describe("resolveSharePath", () => {
  it("handles empty paths, blank owners and absolute data-dir paths", () => {
    assert.deepEqual(resolveSharePath("", ""), {
      owner: "admin",
      userPath: "",
    });
    assert.deepEqual(resolveSharePath(undefined, "bob"), {
      owner: "bob",
      userPath: "",
    });
    assert.deepEqual(resolveSharePath("/www/nextcloud/data/eve/files"), {
      owner: "eve",
      userPath: "",
    });
    assert.deepEqual(resolveSharePath("/bob/files"), {
      owner: "bob",
      userPath: "",
    });
  });

  it("does not treat VFS roots as user ids", () => {
    assert.deepEqual(resolveSharePath("/tmp/files/x", "admin"), {
      owner: "admin",
      userPath: "tmp/files/x",
    });
  });
});

describe("resolveWriteFileTarget", () => {
  it("returns an empty target for a blank path", () => {
    assert.deepEqual(resolveWriteFileTarget("  "), {
      target: "",
      scanUid: null,
    });
  });

  it("keeps absolute VFS paths and detects user files inside them", () => {
    assert.deepEqual(
      resolveWriteFileTarget(`${NEXTCLOUD_DATA_DIR}/ann/files/a`),
      {
        target: `${NEXTCLOUD_DATA_DIR}/ann/files/a`,
        scanUid: "ann",
      },
    );
    assert.deepEqual(resolveWriteFileTarget("/tmp/x"), {
      target: "/tmp/x",
      scanUid: null,
    });
    assert.deepEqual(
      resolveWriteFileTarget(`${NEXTCLOUD_DATA_DIR}/ann/cache/a`),
      {
        target: `${NEXTCLOUD_DATA_DIR}/ann/cache/a`,
        scanUid: null,
      },
    );
  });

  it("maps the bare /<uid>/files shortcut and root-relative data paths", () => {
    assert.deepEqual(resolveWriteFileTarget("ann/files"), {
      target: `${NEXTCLOUD_DATA_DIR}/ann/files`,
      scanUid: "ann",
    });
    assert.deepEqual(resolveWriteFileTarget("data/ann/files/x"), {
      target: `${NEXTCLOUD_ROOT}/data/ann/files/x`,
      scanUid: "ann",
    });
    assert.deepEqual(resolveWriteFileTarget("/etc/x"), {
      target: "/etc/x",
      scanUid: null,
    });
  });
});

describe("parseJsonFromPhpOutput", () => {
  it("extracts the trailing JSON object and tolerates garbage", () => {
    assert.deepEqual(parseJsonFromPhpOutput('Warning: x\n{"ok":true}\n'), {
      ok: true,
    });
    assert.equal(parseJsonFromPhpOutput(undefined), null);
    assert.equal(parseJsonFromPhpOutput("} {"), null);
    assert.equal(parseJsonFromPhpOutput("{not json}"), null);
  });
});

describe("runsOnReload", () => {
  it("treats steps without a name or path as journaled", () => {
    assert.equal(runsOnReload(undefined), false);
    assert.equal(runsOnReload({ type: "login" }), true);
    assert.equal(runsOnReload({ step: "writeFile" }), true);
    assert.equal(runsOnReload({ step: "unzip", path: "/persist/x" }), false);
    assert.equal(runsOnReload({ step: "unzip" }), true);
  });
});

describe("generated PHP scripts", () => {
  it("escapes credentials in the login script and defaults to admin", () => {
    const script = buildLoginScript({ username: "o'neil", password: "a\\b" });
    assert.match(script, /->login\('o\\'neil', 'a\\\\b'\)/);
    assert.match(buildLoginScript(), /->login\('admin', 'admin'\)/);
    assert.match(
      buildAutologinScript({ admin: { username: "root", password: "pw" } }),
      /->login\('root', 'pw'\)/,
    );
    assert.match(buildAutologinScript({}), /->login\('admin', 'admin'\)/);
  });

  it("resolves server services through the container, not removed \\OC::$server getters", () => {
    // Nextcloud 34 dropped Server::getSession/getUserSession/getRequest/
    // getUserManager (present in 33 at Server.php:1407/1399/1334). Calling them
    // threw inside the try/catch, so autologin silently returned ok:false and
    // the playground landed on the login form. Resolve via the PSR container
    // instead, which SimpleContainer::get has provided across every supported
    // major.
    const scripts = [
      buildLoginScript(),
      buildCreateShareScript({ uid: "admin", path: "f" }),
    ];
    for (const script of scripts) {
      assert.doesNotMatch(script, /\$server->get[A-Z]/);
    }
    assert.match(buildLoginScript(), /get\(\\OCP\\ISession::class\)/);
    assert.match(buildLoginScript(), /get\(\\OCP\\IUserSession::class\)/);
    assert.match(buildLoginScript(), /get\(\\OCP\\IRequest::class\)/);
    assert.match(
      buildCreateShareScript({ uid: "admin", path: "f" }),
      /get\(\\OCP\\IUserManager::class\)/,
    );
  });

  it("builds the occ install argv from config with defaults", () => {
    const argvOf = (script) =>
      JSON.parse(script.match(/\$_SERVER\['argv'\] = (\[.*\]);/)[1]);
    const argv = argvOf(buildOccInstallScript({}));
    assert.deepEqual(argv.slice(6, 14), [
      "--admin-user",
      "admin",
      "--admin-pass",
      "admin",
      "--admin-email",
      "admin@example.com",
      "--data-dir",
      NEXTCLOUD_DATA_DIR,
    ]);
    const custom = argvOf(
      buildOccInstallScript({
        admin: { username: "u", password: "p", email: "e@x" },
      }),
    );
    assert.deepEqual([custom[7], custom[9], custom[11]], ["u", "p", "e@x"]);
    assert.match(buildOccScript(["occ"]), /\$_SERVER\['argc'\] = 1;/);
  });

  it("merges host/base URL and log level into the post-install config", () => {
    const defaults = buildPostInstallConfigScript({});
    assert.match(defaults, /\['localhost', 'localhost'\]/);
    assert.match(defaults, /'overwrite\.cli\.url'\] = 'http:\/\/localhost\/';/);
    assert.match(defaults, /'loglevel'\] = 2;/);
    const debug = buildPostInstallConfigScript({
      runtimeHost: "play.example",
      runtimeBaseUrl: "https://play.example/x/",
      debug: { enabled: true },
    });
    assert.match(debug, /\['localhost', 'play\.example'\]/);
    assert.match(debug, /'loglevel'\] = 0;/);
  });

  it("defaults the share script owner, type and permissions", () => {
    const script = buildCreateShareScript();
    assert.match(script, /\$owner = 'admin';/);
    assert.match(script, /setShareType\(3\)/);
    assert.match(script, /setPermissions\(1\)/);
    assert.match(script, /if \('' !== ''\)/);
  });
});
