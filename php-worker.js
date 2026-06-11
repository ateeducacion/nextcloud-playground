import { loadPlaygroundConfig } from "./src/shared/config.js";
import {
  createPhpBridgeChannel,
  createShellChannel,
} from "./src/shared/protocol.js";
import {
  bootstrapNextcloud,
  manifestNameForRuntime,
  PLAYGROUND_DB_PATH,
  startCoreArchivePrefetch,
} from "./src/runtime/bootstrap.js";
import { createPhpRuntime } from "./src/runtime/php-loader.js";
import {
  isEmscriptenNetworkError,
  isFatalWasmError,
  isSafeToReplay,
  formatErrorDetail,
  createSnapshotManager,
} from "./src/runtime/crash-recovery.js";

const workerUrl = new URL(self.location.href);
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");

let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
// Synchronous handle to the fully-booted runtime, used by the static fast-path
// (null until bootstrap completes and again after a runtime rotation).
let readyState = null;
let activeBlueprint = null;
let forceCleanBoot = false;

const MAX_REACTIVE_RESTARTS = 20;
const MIN_REQUESTS_BEFORE_RESTART = 10;
let requestCount = 0;
let reactiveRestartCount = 0;

let snapshot = null;

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

snapshot = createSnapshotManager({ postShell });

function respond(payload) {
  bridgeChannel.postMessage(payload);
}

function serializeResponse(response) {
  return response.arrayBuffer().then((body) => ({
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
}

function deserializeRequest(requestLike) {
  const init = {
    method: requestLike.method,
    headers: requestLike.headers,
  };

  if (!["GET", "HEAD"].includes(requestLike.method) && requestLike.body) {
    init.body = requestLike.body;
  }

  return new Request(requestLike.url, init);
}

function buildLoadingResponse(message, status = 503) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nextcloud S Playground</title><body><pre>${message}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function resetRuntime(reason) {
  if (reactiveRestartCount >= MAX_REACTIVE_RESTARTS) {
    postShell({
      kind: "error",
      detail: `[runtime] restart limit reached (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}), not restarting. Reason: ${reason}`,
    });
    return false;
  }

  if (requestCount < MIN_REQUESTS_BEFORE_RESTART) {
    postShell({
      kind: "error",
      detail: `[runtime] crash after only ${requestCount} requests (minimum ${MIN_REQUESTS_BEFORE_RESTART}), likely a fundamental bug — not restarting. Reason: ${reason}`,
    });
    return false;
  }

  reactiveRestartCount += 1;
  requestCount = 0;
  runtimeStatePromise = null;
  readyState = null;

  postShell({
    kind: "progress",
    title: "Runtime rotation",
    detail: `[runtime] restart (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}): ${reason}`,
    progress: 0.01,
  });

  return true;
}

async function getRuntimeState() {
  if (runtimeStatePromise) {
    return runtimeStatePromise;
  }

  runtimeStatePromise = (async () => {
    const config = await loadPlaygroundConfig();
    // The page is served from this worker's origin (e.g. localhost:8085 or
    // ateeducacion.github.io). Nextcloud rejects untrusted hosts with a 400
    // page, so register the real host in trusted_domains at install time.
    try {
      config.runtimeHost = self.location.host;
      config.runtimeBaseUrl = `${self.location.origin}/`;
    } catch {}
    const runtime =
      config.runtimes.find((entry) => entry.id === runtimeId) ||
      config.runtimes[0];
    const php = createPhpRuntime(runtime, {
      appBaseUrl:
        typeof __APP_ROOT__ !== "undefined"
          ? __APP_ROOT__
          : new URL("./", self.location.href).toString(),
      phpVersion: runtime.phpVersion || runtime.phpVersionLabel,
      scopeId,
      forceCleanBoot,
      phpCorsProxyUrl: config.phpCorsProxyUrl || null,
    });

    // Monotonic progress: the parallel core download and the bootstrap steps
    // interleave, so clamp the reported progress so the bar never goes backward.
    let maxProgress = 0;
    const publishProgress = (title, detail, progress) => {
      if (typeof progress === "number") {
        maxProgress = Math.max(maxProgress, progress);
      }
      postShell({ kind: "progress", title, detail, progress: maxProgress });
    };

    // Parallel boot: start downloading the readonly-core manifest + bundle now
    // so the fetch overlaps the WASM runtime compile in php.refresh().
    const corePrefetch = startCoreArchivePrefetch({
      manifestName: manifestNameForRuntime(config, runtimeId),
      onProgress: (p) => {
        if (p?.ratio !== undefined) {
          publishProgress(
            "Downloading Nextcloud core",
            `Downloading Nextcloud core: ${Math.round(p.ratio * 100)}%`,
            0.3 + p.ratio * 0.15,
          );
        }
      },
    });
    // Keep a handler attached so a prefetch failure during refresh doesn't raise
    // an unhandledrejection; the real error still surfaces where it is awaited.
    corePrefetch.catch(() => {});

    publishProgress(
      "Refreshing PHP runtime",
      `Booting ${runtime.label}.`,
      0.12,
    );

    await php.refresh();

    // Restore saved snapshot if recovering from a crash
    if (snapshot.hasPendingRestore) {
      const restoreResult = await snapshot.restore(php);
      if (restoreResult?.restored) {
        postShell({
          kind: "trace",
          detail: "[snapshot] restored state onto fresh runtime",
        });
      }
    }

    const publish = (detail, progress) => {
      publishProgress("Bootstrapping Nextcloud", detail, progress);
    };

    let bootstrapState;
    try {
      bootstrapState = await bootstrapNextcloud({
        config,
        blueprint: activeBlueprint,
        clean: forceCleanBoot,
        corePrefetch,
        php,
        publish,
        runtimeId,
      });
    } catch (error) {
      runtimeStatePromise = null;
      throw error;
    }

    postShell({
      kind: "ready",
      bootstrapped: true,
      detail: `Nextcloud bootstrapped for ${runtime.label}.`,
      path:
        bootstrapState.readyPath ||
        activeBlueprint?.landingPage ||
        config.landingPath,
    });

    // Expose the booted runtime to the static fast-path now that it can serve.
    readyState = { php };
    return readyState;
  })();

  return runtimeStatePromise;
}

async function executePhpRequest(state, serializedRequest) {
  return state.php.request(deserializeRequest(serializedRequest));
}

async function respondError(id, message, status) {
  const response = buildLoadingResponse(message, status);
  respond({
    kind: "http-response",
    id,
    response: await serializeResponse(response),
  });
}


/**
 * Serve an existing static asset straight from MEMFS, bypassing the serialized
 * request queue so a slow page render doesn't hold up its own CSS/JS/images.
 * Only kicks in for GET once the runtime is fully booted; returns false (and
 * does not respond) for anything that should go through the PHP pipeline, so
 * the caller falls back to the queue.
 */
function tryServeStaticFastPath(data) {
  if (!readyState || (data.request?.method || "GET") !== "GET") {
    return false;
  }

  let pathname;
  try {
    pathname = new URL(data.request.url).pathname;
  } catch {
    return false;
  }

  let response;
  try {
    response = readyState.php.serveStatic(pathname);
  } catch {
    return false;
  }
  if (!response) {
    return false;
  }

  serializeResponse(response)
    .then((serialized) => {
      respond({ kind: "http-response", id: data.id, response: serialized });
    })
    .catch(async () => {
      await respondError(data.id, "Static fast-path failed.", 500);
    });
  return true;
}

function installBridgeListener() {
  bridgeChannel.addEventListener("message", (event) => {
    const data = event.data;

    if (data?.kind !== "http-request") {
      return;
    }

    if (tryServeStaticFastPath(data)) {
      return;
    }

    requestQueue = requestQueue.then(async () => {
      const isRetry = Boolean(data._retried);

      try {
        requestCount += 1;
        const state = await getRuntimeState();
        const response = await executePhpRequest(state, data.request);
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        // Errno 23 (EHOSTUNREACH): outbound curl calls in WASM cannot
        // reach the host on Firefox/Safari.  Notify the shell so it can
        // show a user-friendly warning.
        if (isEmscriptenNetworkError(error)) {
          const requestUrl = data.request?.url || "";
          const pagePath =
            new URL(requestUrl, "http://localhost").pathname || "/";
          postShell({
            kind: "wasm-network-error",
            detail: `Page "${pagePath}" failed — a network call could not complete in this browser's WebAssembly runtime.`,
            path: pagePath,
          });
        }

        if (!isFatalWasmError(error)) {
          const detail = formatErrorDetail(error);
          await respondError(data.id, detail, 500);
          postShell({ kind: "error", detail });
          return;
        }

        // --- Fatal WASM error path ---
        try {
          const currentState = await runtimeStatePromise;
          if (currentState?.php?._php) {
            await snapshot.hydrate(currentState.php, PLAYGROUND_DB_PATH);
          }
        } catch (hydrateErr) {
          postShell({
            kind: "error",
            detail: `[runtime] snapshot hydration failed: ${hydrateErr.message}`,
          });
        }

        const didReset = resetRuntime(`fatal WASM error: ${error.message}`);
        const canReplay = isSafeToReplay(data.request);

        if (isRetry || !canReplay || !didReset) {
          const detail = formatErrorDetail(error);
          const status = didReset || isRetry ? 503 : 500;
          const message = isRetry
            ? `Runtime crashed again on retry. Manual reload required.\n\n${detail}`
            : !canReplay
              ? `Runtime restarting after crash. Non-idempotent request was not retried.\n\n${detail}`
              : `Runtime restart limit reached.\n\n${detail}`;
          await respondError(data.id, message, status);
          return;
        }

        // Automatic retry on fresh runtime
        postShell({
          kind: "progress",
          title: "Crash recovery",
          detail: "[runtime] replaying request on fresh runtime…",
          progress: 0.02,
        });

        try {
          const freshState = await getRuntimeState();
          const retryResponse = await executePhpRequest(
            freshState,
            data.request,
          );
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(retryResponse),
          });
        } catch (retryError) {
          if (isFatalWasmError(retryError)) {
            resetRuntime(`fatal WASM error on retry: ${retryError.message}`);
          }
          const detail = formatErrorDetail(retryError);
          await respondError(
            data.id,
            `Runtime crashed again on retry. Manual reload required.\n\n${detail}`,
            503,
          );
        }
      }
    });
  });
}

async function capturePhpInfo() {
  try {
    const state = await getRuntimeState();
    const response = await state.php.run(
      "<?php ob_start(); phpinfo(); echo ob_get_clean();",
    );
    postShell({
      kind: "phpinfo",
      detail: "Captured PHP runtime diagnostics.",
      html: response.text || "",
    });
  } catch (error) {
    postShell({
      kind: "phpinfo",
      detail: `Failed to capture PHP info: ${formatErrorDetail(error)}`,
      html: `<!doctype html><meta charset="utf-8"><pre>${formatErrorDetail(error)}</pre>`,
    });
  }
}

function installMessageListener() {
  self.addEventListener("message", (event) => {
    const data = event.data;

    if (data?.kind === "capture-phpinfo") {
      void capturePhpInfo();
      return;
    }

    if (data?.kind !== "configure-blueprint") {
      return;
    }

    activeBlueprint = data.blueprint || null;
    forceCleanBoot = data.clean === true;

    self.postMessage({
      kind: "worker-ready",
      scopeId,
      runtimeId,
    });
  });
}

try {
  bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  installBridgeListener();
  installMessageListener();

  respond({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });

  self.postMessage({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });
} catch (error) {
  self.postMessage({
    kind: "worker-startup-error",
    scopeId,
    runtimeId,
    detail: formatErrorDetail(error),
  });
  throw error;
}
