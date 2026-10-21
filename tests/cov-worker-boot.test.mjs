import assert from "node:assert/strict";
import { it } from "node:test";
import { makePhp, startWorker, tick } from "./fixtures/cov-worker/harness.mjs";

// One worker instance shared by the tests below, in order (module state).
const php = makePhp(async (request) => {
  const body = await request.text();
  return new Response(`${request.method}:${request.url}:${body}`, {
    status: 201,
    statusText: "Created",
    headers: { "x-test": "yes" },
  });
});
const env = await startWorker({
  query: "scope=s1&runtime=php83&instance=i1&opcache=0",
  configure: {
    kind: "configure-blueprint",
    blueprint: { landingPage: "/landing" },
    clean: true,
  },
  stubs: { php: () => php },
});

it("boots with the URL parameters and serves queued PHP requests", async () => {
  assert.deepEqual(env.posted.at(-1), {
    kind: "worker-ready",
    scopeId: "s1",
    runtimeId: "php83",
  });
  assert.equal(env.channels[0].name, "nextcloud-playground-php:s1");

  const get = await env.fetch({ url: "http://localhost/index.php" });
  assert.equal(get.status, 201);
  assert.equal(get.statusText, "Created");
  assert.equal(get.headers["x-test"], "yes");
  assert.equal(get.text, "GET:http://localhost/index.php:");

  const post = await env.fetch({
    url: "http://localhost/login",
    method: "POST",
    body: "user=admin",
  });
  assert.equal(post.text, "POST:http://localhost/login:user=admin");

  // A body on GET/HEAD is dropped instead of making Request() throw.
  const head = await env.fetch({
    url: "http://localhost/status.php",
    method: "HEAD",
    body: "ignored",
  });
  assert.equal(head.status, 201);

  assert.equal(env.createCalls.length, 1);
  const [{ runtime, options }] = env.createCalls;
  assert.equal(runtime.id, "php83");
  assert.deepEqual(options, {
    appBaseUrl: "https://example.test/",
    phpVersion: "8.3",
    scopeId: "s1",
    forceCleanBoot: true,
    phpCorsProxyUrl: "https://proxy.test/",
    opcache: false,
  });

  const [boot] = env.bootstrapCalls;
  assert.deepEqual(boot.blueprint, { landingPage: "/landing" });
  assert.equal(boot.clean, true);
  assert.equal(boot.runtimeId, "php83");
  assert.equal(boot.config.runtimeHost, "example.test");
  assert.equal(boot.config.runtimeBaseUrl, "https://example.test/");
  assert.deepEqual(await boot.corePrefetch, { bytes: "core" });
  boot.publish("Installing", 0.2);

  const progress = env.shell.filter((entry) => entry.kind === "progress");
  assert.ok(progress.length >= 3);
  assert.ok(
    progress.every((entry) => entry.progress === 0.375),
    "progress never moves back below the core download ratio",
  );
  assert.ok(
    env.shell.every(
      (entry) => entry.channel === "nextcloud-playground-shell:s1:i1",
    ),
  );
  const ready = env.message("ready");
  assert.equal(ready.path, "/index.php/apps/dashboard");
  assert.equal(ready.bootstrapped, true);
});

it("serves static assets from MEMFS once booted, bypassing the queue", async () => {
  php.serveStatic = (pathname) => {
    if (pathname === "/core/css/app.css") {
      return new Response("body{}", {
        headers: { "content-type": "text/css" },
      });
    }
    if (pathname === "/boom.css") {
      throw new Error("serveStatic failed");
    }
    if (pathname === "/broken.css") {
      return {
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        arrayBuffer: () => Promise.reject(new Error("read failed")),
      };
    }
    return null;
  };
  const before = php.requests.length;

  const css = await env.fetch({ url: "http://localhost/core/css/app.css" });
  assert.equal(css.text, "body{}");
  assert.equal(css.headers["content-type"], "text/css");
  assert.equal(php.requests.length, before);

  const post = await env.fetch({
    url: "http://localhost/core/css/app.css",
    method: "POST",
    body: "x",
  });
  assert.match(post.text, /^POST:/);

  const missing = await env.fetch({ url: "http://localhost/index.php" });
  assert.match(missing.text, /^GET:/);

  const thrown = await env.fetch({ url: "http://localhost/boom.css" });
  assert.match(thrown.text, /^GET:http:\/\/localhost\/boom\.css/);

  const broken = await env.fetch({ url: "http://localhost/broken.css" });
  assert.equal(broken.status, 500);
  assert.match(broken.text, /Static fast-path failed\./);
  assert.equal(broken.headers["cache-control"], "no-store");

  // An unparsable URL skips the fast-path; Request() then fails non-fatally.
  const invalid = await env.fetch({ url: "not a url" });
  assert.equal(invalid.status, 500);
  assert.match(invalid.text, /TypeError/);
  assert.ok(env.message("error", "TypeError"));
  assert.equal(php.requests.length, before + 3);
});

it("reports PHP info and persistence flushes to the shell", async () => {
  env.selfMessage({ kind: "capture-phpinfo" });
  const info = await env.waitShell("phpinfo", "Captured");
  assert.equal(info.html, "<h1>info</h1>");

  php.run = async () => ({});
  env.shell.length = 0;
  env.selfMessage({ kind: "capture-phpinfo" });
  assert.equal((await env.waitShell("phpinfo", "Captured")).html, "");

  env.selfMessage({ kind: "flush-persistence" });
  const flushed = await env.waitShell("persistence-flushed");
  assert.equal(flushed.detail, "Persistence journal flushed.");
});

it("ignores unrelated bridge and worker messages", async () => {
  const posted = env.posted.length;
  const shell = env.shell.length;
  env.dispatch({ kind: "something-else", id: "x" });
  env.dispatch(null);
  env.selfMessage({ kind: "unknown" });
  env.selfMessage(null);
  await tick();
  assert.equal(env.hasResponse("x"), false);
  assert.equal(env.posted.length, posted);
  assert.equal(env.shell.length, shell);
});

it("keeps the queue usable when the error path itself throws", async () => {
  env.bridgeFailures.count = 2;
  env.send({ url: "http://localhost/lost" });
  const failure = await env.waitShell("error", "request handler failed");
  assert.equal(failure.detail, "[worker] request handler failed: bridge down");
  const next = await env.fetch({ url: "http://localhost/next" });
  assert.equal(next.status, 201);
});

it("warns once the request count reaches the high watermark", async () => {
  let last;
  for (let i = 0; i < 1500; i += 1) {
    last = env.send({ url: `http://localhost/r/${i}` });
  }
  await env.response(last);
  const warning = env.message("log", "[perf] Request count reached 1500");
  assert.equal(warning.level, "warn");
  assert.equal(env.shell.filter((entry) => entry.kind === "log").length, 1);
});
