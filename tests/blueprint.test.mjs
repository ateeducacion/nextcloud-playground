import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCoreExtractScript,
  buildZipExtractScript,
} from "../src/runtime/install-script.js";
import {
  buildDefaultBlueprint,
  buildEffectivePlaygroundConfig,
  knownStepTypes,
  normalizeBlueprint,
} from "../src/shared/blueprint.js";

const baseConfig = {
  siteTitle: "Test Playground",
  locale: "en",
  timezone: "UTC",
  admin: { username: "admin", email: "admin@example.com", password: "admin" },
  landingPath: "/index.php/login",
};

describe("buildDefaultBlueprint", () => {
  it("produces a Nextcloud-shaped default", () => {
    const bp = buildDefaultBlueprint(baseConfig);
    assert.equal(bp.admin.username, "admin");
    assert.equal(bp.landingPage, "/index.php/login");
    assert.deepEqual(bp.steps, []);
    assert.equal(bp.siteOptions.locale, "en");
  });
});

describe("normalizeBlueprint", () => {
  it("falls back to defaults for empty input", () => {
    const bp = normalizeBlueprint({}, baseConfig);
    assert.equal(bp.admin.username, "admin");
    assert.deepEqual(bp.steps, []);
  });

  it("expands top-level apps into enableApp steps", () => {
    const bp = normalizeBlueprint({ apps: ["text", "activity"] }, baseConfig);
    assert.deepEqual(bp.steps, [
      { step: "enableApp", app: "text" },
      { step: "enableApp", app: "activity" },
    ]);
  });

  it("keeps explicit steps after expanded apps", () => {
    const bp = normalizeBlueprint(
      {
        apps: ["text"],
        steps: [{ step: "createUser", username: "alice", password: "pw" }],
      },
      baseConfig,
    );
    assert.equal(bp.steps.length, 2);
    assert.equal(bp.steps[0].step, "enableApp");
    assert.equal(bp.steps[1].step, "createUser");
    assert.equal(bp.steps[1].username, "alice");
  });

  it("drops malformed step entries", () => {
    const bp = normalizeBlueprint(
      { steps: [null, 42, {}, { step: "runOcc", args: ["status"] }] },
      baseConfig,
    );
    assert.equal(bp.steps.length, 1);
    assert.equal(bp.steps[0].step, "runOcc");
  });

  it("accepts the legacy login.{username,password} shape for admin", () => {
    const bp = normalizeBlueprint(
      { login: { username: "root", password: "secret" } },
      baseConfig,
    );
    assert.equal(bp.admin.username, "root");
    assert.equal(bp.admin.password, "secret");
  });
});

describe("buildEffectivePlaygroundConfig", () => {
  it("merges blueprint values into the effective config", () => {
    const bp = normalizeBlueprint(
      {
        siteOptions: {
          title: "My NC",
          locale: "es",
          timezone: "Europe/Madrid",
        },
        landingPage: "/index.php/apps/dashboard",
        admin: { username: "boss", password: "x", email: "b@e.com" },
      },
      baseConfig,
    );
    const effective = buildEffectivePlaygroundConfig(baseConfig, bp);
    assert.equal(effective.siteTitle, "My NC");
    assert.equal(effective.locale, "es");
    assert.equal(effective.timezone, "Europe/Madrid");
    assert.equal(effective.landingPath, "/index.php/apps/dashboard");
    assert.equal(effective.admin.username, "boss");
  });
});

describe("knownStepTypes", () => {
  it("includes the core provisioning steps", () => {
    const types = knownStepTypes();
    for (const t of [
      "enableApp",
      "createUser",
      "setConfig",
      "installApp",
      "writeFile",
      "runOcc",
    ]) {
      assert.ok(types.includes(t), `expected step type ${t}`);
    }
  });
});

describe("installApp step", () => {
  it("passes installApp fields through normalization unchanged", () => {
    const bp = normalizeBlueprint(
      {
        steps: [
          {
            step: "installApp",
            appId: "exelearning",
            url: "https://example.com/exelearning.zip",
          },
        ],
      },
      baseConfig,
    );
    assert.equal(bp.steps.length, 1);
    assert.equal(bp.steps[0].step, "installApp");
    assert.equal(bp.steps[0].appId, "exelearning");
    assert.equal(bp.steps[0].url, "https://example.com/exelearning.zip");
  });
});

describe("buildZipExtractScript", () => {
  const script = buildZipExtractScript(
    "exelearning",
    "/tmp/exelearning-install.zip",
    "/tmp/exelearning-stage",
  );

  it("extracts with PHP ZipArchive into apps/<appId>", () => {
    assert.match(script, /new ZipArchive\(\)/);
    assert.match(script, /->extractTo\(\$stage\)/);
    assert.match(script, /\/apps\/exelearning'/);
    assert.match(script, /\$zipPath = '\/tmp\/exelearning-install\.zip'/);
    assert.match(script, /\$stage = '\/tmp\/exelearning-stage'/);
  });

  it("declares the sentinel contract (NO_ZIP_EXT / INSTALL_OK / INSTALL_ERR)", () => {
    assert.match(script, /return 'NO_ZIP_EXT'/);
    assert.match(script, /return 'INSTALL_OK ' \. \$count/);
    assert.match(script, /INSTALL_ERR/);
    // ext/zip is probed before use so the caller can fall back to JS.
    assert.match(script, /class_exists\('ZipArchive'\)/);
  });

  it("escapes single quotes in identifiers to keep the PHP literal safe", () => {
    const evil = buildZipExtractScript("a'b", "/tmp/x.zip", "/tmp/s");
    assert.match(evil, /\/apps\/a\\'b'/);
    assert.doesNotMatch(evil, /\/apps\/a'b'/);
  });
});

describe("buildCoreExtractScript", () => {
  const script = buildCoreExtractScript(
    "/tmp/nextcloud-core.zip",
    "/tmp/nextcloud-core-stage",
    "/www/nextcloud",
  );

  it("extracts the core with PHP ZipArchive into the target root", () => {
    assert.match(script, /new ZipArchive\(\)/);
    assert.match(script, /->extractTo\(\$stage\)/);
    assert.match(script, /\$zipPath = '\/tmp\/nextcloud-core\.zip'/);
    assert.match(script, /\$target = '\/www\/nextcloud'/);
  });

  it("descends into a lone wrapping folder, then moves it into place", () => {
    assert.match(script, /count\(\$top\) === 1 && is_dir/);
    assert.match(script, /@rename\(\$src, \$target\)/);
  });

  it("declares the sentinel contract and probes ext/zip", () => {
    assert.match(script, /class_exists\('ZipArchive'\)/);
    assert.match(script, /return 'NO_ZIP_EXT'/);
    assert.match(script, /return 'INSTALL_OK ' \. \$count/);
    assert.match(script, /INSTALL_ERR/);
  });

  it("escapes single quotes in paths to keep the PHP literal safe", () => {
    const evil = buildCoreExtractScript("/tmp/a'b.zip", "/tmp/s", "/www/x");
    assert.match(evil, /\/tmp\/a\\'b\.zip'/);
  });
});

describe("writeFile step", () => {
  it("passes writeFile fields through normalization unchanged", () => {
    const bp = normalizeBlueprint(
      {
        steps: [
          {
            step: "writeFile",
            path: "config/mimetypemapping.json",
            content: '{"elpx":["application/vnd.exelearning.elpx"]}',
          },
        ],
      },
      baseConfig,
    );
    assert.equal(bp.steps.length, 1);
    assert.equal(bp.steps[0].step, "writeFile");
    assert.equal(bp.steps[0].path, "config/mimetypemapping.json");
    assert.match(bp.steps[0].content, /exelearning/);
  });
});
