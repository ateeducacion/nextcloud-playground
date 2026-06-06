import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../lib/nextcloud-loader.js";

describe("sanitizeArchivePath", () => {
  it("rejects ZIP-slip entries containing '..'", () => {
    assert.equal(sanitizeArchivePath("../evil.php"), null);
    assert.equal(sanitizeArchivePath("a/../../evil"), null);
  });

  it("strips leading slashes and '.' segments, normalizes backslashes", () => {
    assert.equal(sanitizeArchivePath("/index.php"), "index.php");
    assert.equal(
      sanitizeArchivePath("./nextcloud/lib/base.php"),
      "nextcloud/lib/base.php",
    );
    assert.equal(
      sanitizeArchivePath("nextcloud\\lib\\base.php"),
      "nextcloud/lib/base.php",
    );
  });

  it("returns null for empty / root-only paths", () => {
    assert.equal(sanitizeArchivePath(""), null);
    assert.equal(sanitizeArchivePath("/"), null);
  });
});
