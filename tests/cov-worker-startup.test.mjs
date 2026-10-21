import assert from "node:assert/strict";
import { it } from "node:test";
import { startWorker } from "./fixtures/cov-worker/harness.mjs";

it("posts a startup error when the message listener cannot install", async () => {
  const { imported, posted } = await startWorker({
    query: "scope=boot&runtime=php83",
    stubs: {
      selfAddEventListener() {
        throw new Error("no listeners in this realm");
      },
    },
  });
  await assert.rejects(imported, /no listeners in this realm/);
  assert.equal(posted[0].kind, "worker-startup-error");
  assert.equal(posted[0].scopeId, "boot");
  assert.equal(posted[0].runtimeId, "php83");
  assert.match(posted[0].detail, /no listeners in this realm/);
});
