// `node --import` preload for scripts/dev-server.mjs in
// tests/cov-scripts-dev-server.test.mjs: answer upstream fetches locally and
// exit cleanly on SIGTERM so V8 coverage is written. The proxy allowlist comes
// from the shipped playground.config.json.
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes("boom")) throw new Error("socket hang up");
  if (href.includes("missing")) {
    return new Response("nope", { status: 404, statusText: "Not Found" });
  }
  // A byte body carries no content-type, so the proxy has to infer one.
  if (href.includes("bare")) return new Response(new Uint8Array([80, 75]));
  if (href.includes("empty")) return new Response(null, { status: 200 });
  const body = `PK-${init.method}-${init.headers["User-Agent"]}`;
  return new Response(body, {
    headers: {
      "content-type": "application/x-zip",
      "content-disposition": 'attachment; filename="up.zip"',
      "content-length": String(body.length),
    },
  });
};

process.on("SIGTERM", () => process.exit(0));
