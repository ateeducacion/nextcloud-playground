import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveSharePath,
  resolveSharePermissions,
  resolveShareType,
  resolveWriteFileTarget,
  stepAppId,
  stepGroupId,
  stepUsername,
} from "../src/runtime/blueprint-step-utils.js";
import { executeBlueprintSteps } from "../src/runtime/blueprint-steps.js";
import {
  NEXTCLOUD_DATA_DIR,
  NEXTCLOUD_ROOT,
} from "../src/runtime/bootstrap-paths.js";
import { buildCreateShareScript } from "../src/runtime/share-script.js";
import { knownStepTypes, normalizeBlueprint } from "../src/shared/blueprint.js";

const baseConfig = {
  siteTitle: "Test Playground",
  locale: "en",
  timezone: "UTC",
  admin: { username: "admin", email: "admin@example.com", password: "admin" },
  landingPath: "/index.php/login",
};

function encoder() {
  return new TextEncoder();
}

function mockPhp({
  runOut = { ok: true },
  requestOut = { ok: true, uid: "admin" },
} = {}) {
  const runs = [];
  const requests = [];
  const files = [];
  return {
    runs,
    requests,
    files,
    async run(script) {
      runs.push(script);
      return {
        exitCode: 0,
        bytes: encoder().encode(`${JSON.stringify(runOut)}\n`),
      };
    },
    async request(req) {
      requests.push(req);
      return {
        async text() {
          return JSON.stringify(requestOut);
        },
      };
    },
    async writeFile(path, data) {
      files.push({ path, data });
    },
    async analyzePath() {
      return { exists: true };
    },
    async mkdir() {},
  };
}

describe("knownStepTypes", () => {
  it("includes documented login, createShare, and installNextcloud steps", () => {
    const types = knownStepTypes();
    for (const t of ["login", "createShare", "installNextcloud"]) {
      assert.ok(types.includes(t), `expected step type ${t}`);
    }
  });
});

describe("normalizeBlueprint documented steps", () => {
  it("keeps login, createShare, and installNextcloud entries", () => {
    const bp = normalizeBlueprint(
      {
        steps: [
          { step: "installNextcloud", adminUser: "admin", adminPass: "admin" },
          { step: "createShare", path: "/welcome.md", shareType: "public" },
          { step: "login", username: "admin", password: "admin" },
        ],
      },
      baseConfig,
    );
    assert.deepEqual(
      bp.steps.map((s) => s.step),
      ["installNextcloud", "createShare", "login"],
    );
    assert.equal(bp.steps[1].path, "/welcome.md");
    assert.equal(bp.steps[2].username, "admin");
  });
});

describe("documented field aliases", () => {
  it("reads appId as the app identifier", () => {
    assert.equal(stepAppId({ appId: "activity" }), "activity");
    assert.equal(stepAppId({ app: "text" }), "text");
  });

  it("reads uid as the username", () => {
    assert.equal(stepUsername({ uid: "alice" }), "alice");
    assert.equal(stepUsername({ username: "bob" }), "bob");
  });

  it("reads gid as the group id", () => {
    assert.equal(stepGroupId({ gid: "teachers" }), "teachers");
    assert.equal(stepGroupId({ group: "students" }), "students");
  });
});

describe("resolveShareType", () => {
  it("maps the documented public/user/group names onto OCS shareType ints", () => {
    assert.equal(resolveShareType("public"), 3);
    assert.equal(resolveShareType("link"), 3);
    assert.equal(resolveShareType("user"), 0);
    assert.equal(resolveShareType("group"), 1);
  });

  it("accepts numeric shareType values from the OCS API", () => {
    assert.equal(resolveShareType(3), 3);
    assert.equal(resolveShareType("0"), 0);
  });

  it("rejects unknown share types", () => {
    assert.throws(() => resolveShareType("nope"), /unknown shareType/i);
  });
});

describe("resolveSharePermissions", () => {
  it("defaults public shares to read (1) and others to all (31)", () => {
    assert.equal(resolveSharePermissions(undefined, 3), 1);
    assert.equal(resolveSharePermissions(undefined, 0), 31);
  });

  it("accepts the documented named permissions", () => {
    assert.equal(resolveSharePermissions("read", 3), 1);
    assert.equal(resolveSharePermissions(["read", "update", "create"], 1), 7);
    assert.equal(resolveSharePermissions("all", 0), 31);
  });

  it("accepts numeric permission bitmasks", () => {
    assert.equal(resolveSharePermissions(17, 0), 17);
  });
});

describe("resolveSharePath", () => {
  it("treats /welcome.md as a path in the owner's files", () => {
    assert.deepEqual(resolveSharePath("/welcome.md", "admin"), {
      owner: "admin",
      userPath: "welcome.md",
    });
  });

  it("extracts owner and user path from /admin/files/welcome.md", () => {
    assert.deepEqual(resolveSharePath("/admin/files/welcome.md", "admin"), {
      owner: "admin",
      userPath: "welcome.md",
    });
  });

  it("extracts owner and user path from a data-dir writeFile target", () => {
    assert.deepEqual(resolveSharePath("data/alice/files/Reports", "admin"), {
      owner: "alice",
      userPath: "Reports",
    });
  });
});

describe("resolveWriteFileTarget", () => {
  it("maps /admin/files/welcome.md into the user's data directory", () => {
    const resolved = resolveWriteFileTarget("/admin/files/welcome.md");
    assert.equal(
      resolved.target,
      `${NEXTCLOUD_DATA_DIR}/admin/files/welcome.md`,
    );
    assert.equal(resolved.scanUid, "admin");
  });

  it("keeps Nextcloud-root-relative paths for config files", () => {
    const resolved = resolveWriteFileTarget("config/mimetypemapping.json");
    assert.equal(
      resolved.target,
      `${NEXTCLOUD_ROOT}/config/mimetypemapping.json`,
    );
    assert.equal(resolved.scanUid, null);
  });

  it("scans when writing under data/<uid>/files", () => {
    const resolved = resolveWriteFileTarget("data/alice/files/hello.md");
    assert.equal(
      resolved.target,
      `${NEXTCLOUD_ROOT}/data/alice/files/hello.md`,
    );
    assert.equal(resolved.scanUid, "alice");
  });
});

describe("buildCreateShareScript", () => {
  const script = buildCreateShareScript({
    owner: "admin",
    userPath: "welcome.md",
    shareType: 3,
    shareWith: "",
    permissions: 1,
  });

  it("is a PHP open tag script that bootstraps Nextcloud", () => {
    assert.ok(script.startsWith("<?php"));
    assert.match(script, /unset\(\$_SERVER\['REQUEST_URI'\]\)/);
    assert.match(script, /chdir\('\/www\/nextcloud'\)/);
    assert.match(script, /require '\/www\/nextcloud\/lib\/base\.php'/);
  });

  it("creates the share through OCP\\Share\\IManager (no occ sharing command exists)", () => {
    assert.match(script, /OCP\\Share\\IManager/);
    assert.match(script, /->newShare\(\)/);
    assert.match(script, /->createShare\(/);
    assert.match(script, /setShareType\(3\)/);
    assert.match(script, /setPermissions\(1\)/);
    assert.match(script, /\$owner = 'admin'/);
    assert.match(script, /\$userPath = 'welcome.md'/);
    assert.match(script, /getUserFolder\(\$owner\)/);
    assert.match(script, /->get\(\$userPath\)/);
  });

  it("escapes single quotes in owner and path", () => {
    const evil = buildCreateShareScript({
      owner: "a'dmin",
      userPath: "we'lcome.md",
      shareType: 0,
      shareWith: "al'ice",
      permissions: 31,
    });
    assert.match(evil, /\$owner = 'a\\'dmin'/);
    assert.match(evil, /\$userPath = 'we\\'lcome.md'/);
    assert.match(evil, /setSharedWith\('al\\'ice'\)/);
  });
});

describe("executeBlueprintSteps", () => {
  it("treats installNextcloud as an already-installed no-op", async () => {
    const php = mockPhp();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "installNextcloud", adminUser: "admin" }],
      },
      publish() {},
    });
    assert.equal(result.executed, 1);
    assert.equal(php.runs.length, 0);
  });

  it("logs in via php.request so the cookie jar captures the session", async () => {
    const php = mockPhp({ requestOut: { ok: true, uid: "alice" } });
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [{ step: "login", username: "alice", password: "alice-pass" }],
      },
      publish() {},
    });
    assert.equal(result.executed, 1);
    assert.equal(result.loggedInUser, "alice");
    assert.equal(php.requests.length, 1);
    assert.ok(php.files.some((f) => String(f.path).includes("autologin")));
  });

  it("creates a public share by running the Share Manager script", async () => {
    const php = mockPhp({
      runOut: { ok: true, id: "7", token: "abc123", shareType: 3 },
    });
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        admin: { username: "admin" },
        steps: [
          { step: "createShare", path: "/welcome.md", shareType: "public" },
        ],
      },
      publish() {},
    });
    assert.equal(result.executed, 1);
    assert.equal(php.runs.length, 1);
    assert.match(php.runs[0], /createShare/);
    assert.match(php.runs[0], /setShareType\(3\)/);
  });

  it("accepts documented createUser/createGroup aliases (uid/gid/appId)", async () => {
    const php = mockPhp();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "createGroup", gid: "teachers" },
          {
            step: "createUser",
            uid: "alice",
            password: "alice-pass",
            displayName: "Alice",
          },
          { step: "addUserToGroup", uid: "alice", gid: "teachers" },
          { step: "enableApp", appId: "activity" },
        ],
      },
      publish() {},
    });
    assert.equal(result.executed, 4);
    const joined = php.runs.join("\n");
    assert.match(joined, /"group:add","teachers"/);
    assert.match(joined, /"alice"/);
    assert.match(joined, /"group:adduser","teachers","alice"/);
    assert.match(joined, /"app:enable","--force","activity"/);
  });

  it("scans the owner after writing into a user's files directory", async () => {
    const php = mockPhp();
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          {
            step: "writeFile",
            path: "/admin/files/welcome.md",
            contents: "# Welcome",
          },
        ],
      },
      publish() {},
    });
    assert.equal(result.executed, 1);
    assert.ok(
      php.files.some(
        (f) => f.path === `${NEXTCLOUD_DATA_DIR}/admin/files/welcome.md`,
      ),
    );
    assert.ok(php.runs.some((script) => /"files:scan","admin"/.test(script)));
  });

  it("surfaces a failed createShare as a warning instead of silently skipping", async () => {
    const php = mockPhp({ runOut: { ok: false, error: "file not found" } });
    const warnings = [];
    const result = await executeBlueprintSteps({
      php,
      blueprint: {
        steps: [
          { step: "createShare", path: "/missing.md", shareType: "public" },
        ],
      },
      publish(message) {
        warnings.push(message);
      },
    });
    assert.equal(result.executed, 0);
    assert.ok(
      warnings.some((m) => /createShare/.test(m) && /file not found/.test(m)),
    );
  });
});
