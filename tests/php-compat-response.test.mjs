import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NULL_BODY_STATUSES,
  phpResponseToResponse,
} from "../src/runtime/php-compat.js";

const encoder = new TextEncoder();

function phpResponse(status, body = "ignored payload", headers = {}) {
  return {
    httpStatusCode: status,
    bytes: encoder.encode(body),
    headers,
  };
}

describe("phpResponseToResponse null-body statuses", () => {
  it("drops the body on 204 (Nextcloud WebDAV/OCS no-content replies)", async () => {
    const response = phpResponseToResponse(phpResponse(204));
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.equal(await response.text(), "");
  });

  it("drops the body on 304 (conditional GET)", async () => {
    const response = phpResponseToResponse(phpResponse(304));
    assert.equal(response.status, 304);
    assert.equal(response.body, null);
  });

  it("keeps headers on a null-body response", () => {
    const response = phpResponseToResponse(
      phpResponse(204, "ignored", { etag: ['"abc123"'] }),
    );
    assert.equal(response.headers.get("etag"), '"abc123"');
  });

  it("covers every status the Fetch spec forbids a body on", () => {
    for (const status of [101, 103, 204, 205, 304]) {
      assert.ok(NULL_BODY_STATUSES.has(status), `missing ${status}`);
    }
  });

  it("no longer throws for the statuses a Response can carry", () => {
    // The point of the fix: these used to throw
    // "Response with null body status cannot have body". 101 and 103 are in the
    // set for completeness only — the Response constructor rejects any status
    // outside 200-599, so PHP can never surface them here anyway.
    for (const status of [204, 205, 304]) {
      assert.doesNotThrow(
        () => phpResponseToResponse(phpResponse(status)),
        `status ${status}`,
      );
    }
  });

  it("still carries the body on a normal 200", async () => {
    const response = phpResponseToResponse(phpResponse(200, "hello world"));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello world");
  });

  it("still carries the body on a 404 error page", async () => {
    const response = phpResponseToResponse(phpResponse(404, "not found"));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "not found");
  });
});
