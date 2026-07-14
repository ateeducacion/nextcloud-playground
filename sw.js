import { BUILD_VERSION } from "./src/generated/build-version.js";
import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";
import {
  buildSandboxedIframeCompatibilityScript,
  consumeSandboxCompatibility,
  preserveSandboxCompatibilityRedirect,
} from "./src/shared/sandboxed-iframes.js";

const INTERNAL_PROXY_PATH = "/__playground_proxy__";
// Cache-first store for the immutable, hash-named runtime assets under /dist/
// (the multi-MB PHP .wasm + intl .so). Their filenames already encode a content
// hash, so they are safe to serve from cache indefinitely and offline; the cache
// name is keyed by the worker-bundle build so `activate` can drop old
// generations. This is distinct from STATIC_ASSET_CACHE below, which caches the
// scoped, PHP-served page assets.
const STATIC_DIST_CACHE = `fs-dist-${BUILD_VERSION}`;
const CACHEABLE_DIST_RE = /\/dist\/[^/]+\.(?:wasm|so)$/u;
let addonProxyUrlOverride = null;
let playgroundConfigPromise;

const bridges = new Map();
const pending = new Map();
const clientContexts = new Map();
const sandboxedIframeCompatibilityScopes = new Set();

// Static assets served via PHP are cached after the first request to avoid
// re-queuing them through the serial PHP worker on every page navigation.
const STATIC_ASSET_CACHE = "fs-static-assets-v1";
const STATIC_ASSET_RE = /\.(css|js|woff2?|ttf|otf|eot|png|jpg|jpeg|gif|svg|ico|webp|map)$/iu;

function isStaticAssetPath(requestPath) {
  return STATIC_ASSET_RE.test(requestPath.split("?")[0]);
}

function isCacheableDist(pathname) {
  return CACHEABLE_DIST_RE.test(stripAppBasePath(pathname));
}

async function distCacheFirst(request) {
  let cache;
  try {
    cache = await caches.open(STATIC_DIST_CACHE);
  } catch {
    return fetch(request);
  }

  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  // Only store complete 200 responses (cache.put rejects 206 Partial Content).
  if (response.status === 200) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}
const STATIC_PREFIXES = [
  "/assets/",
  "/src/",
  "/vendor/",
  "/php-worker.js",
  "/sw.js",
  "/remote.html",
  "/index.html",
  "/playground.config.json",
  "/favicon.ico",
];

function getAppBasePath() {
  const scopeUrl = new URL(self.registration.scope);
  const pathname = scopeUrl.pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) || "/" : pathname || "/";
}

function stripAppBasePath(pathname) {
  const basePath = getAppBasePath();
  if (basePath === "/") {
    return pathname || "/";
  }

  if (pathname === basePath) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname || "/";
}

function withAppBasePath(pathname) {
  const basePath = getAppBasePath();
  if (basePath === "/") {
    return pathname;
  }

  return `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`.replace(/\/{2,}/gu, "/");
}

function buildErrorResponse(message, status = 500) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nextcloud Playground Error</title><body><pre>${message}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function loadServiceWorkerConfig() {
  if (!playgroundConfigPromise) {
    playgroundConfigPromise = fetch(
      new URL("playground.config.json", self.registration.scope),
      { cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : {}));
  }
  return playgroundConfigPromise;
}

async function handleInternalProxyRequest(request, sourceUrl) {
  const config = await loadServiceWorkerConfig();
  const proxyBaseUrl = addonProxyUrlOverride || config.addonProxyUrl || "";
  if (!proxyBaseUrl) {
    return buildErrorResponse("No addon proxy configured.", 502);
  }
  const upstreamUrl = new URL(proxyBaseUrl);
  upstreamUrl.search = sourceUrl.search;
  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "follow",
  };
  init.headers.delete("host");
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.clone().arrayBuffer();
  }
  const resp = await fetch(upstreamUrl.toString(), init);
  const headers = new Headers(resp.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
}

function ensureBridge(scopeId) {
  if (bridges.has(scopeId)) {
    return bridges.get(scopeId);
  }

  const bridge = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  bridge.addEventListener("message", (event) => {
    const message = event.data;
    if (!message?.id || !pending.has(message.id)) {
      return;
    }

    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timeoutId);

    if (message.kind === "http-response") {
      entry.resolve(new Response(message.response.body, {
        status: message.response.status,
        statusText: message.response.statusText,
        headers: message.response.headers,
      }));
      return;
    }

    entry.resolve(buildErrorResponse(message.error || "Unknown PHP worker error."));
  });

  bridges.set(scopeId, bridge);
  return bridge;
}

function extractScopedRuntime(pathname) {
  const match = stripAppBasePath(pathname).match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (!match) {
    return null;
  }

  return {
    scopeId: match[1],
    runtimeId: match[2],
    requestPath: match[3] || "/",
  };
}

async function resolveScopedRequest(event, url) {
  const strippedPathname = stripAppBasePath(url.pathname);
  const direct = extractScopedRuntime(url.pathname);
  if (direct) {
    return {
      ...direct,
      requestPath: `${direct.requestPath}${url.search}`,
    };
  }

  if (STATIC_PREFIXES.some((prefix) => strippedPathname === prefix || strippedPathname.startsWith(prefix))) {
    return null;
  }

  if (event.request.referrer) {
    const referrerUrl = new URL(event.request.referrer);
    const scopedFromReferrer = extractScopedRuntime(referrerUrl.pathname);
    if (scopedFromReferrer && referrerUrl.origin === url.origin) {
      return {
        scopeId: scopedFromReferrer.scopeId,
        runtimeId: scopedFromReferrer.runtimeId,
        requestPath: `${strippedPathname}${url.search}`,
      };
    }
  }

  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (event.clientId && clientContexts.has(event.clientId)) {
    const scoped = clientContexts.get(event.clientId);
    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
  }

  if (!client) {
    return null;
  }

  const clientUrl = new URL(client.url);
  const scoped = extractScopedRuntime(clientUrl.pathname);
  if (!scoped || clientUrl.origin !== url.origin) {
    return null;
  }

    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
}

// Build the serialized request posted to the PHP worker. The body is the
// already-buffered ArrayBuffer captured synchronously in the fetch handler (see
// the comment there): forwarding the original request's stream instead would
// throw in Firefox, which neuters event.request.body once the handler yields.
async function buildForwardedRequest(originalRequest, forwardedUrl, bufferedBody) {
  return {
    url: forwardedUrl.toString(),
    method: originalRequest.method,
    headers: Object.fromEntries(new Headers(originalRequest.headers).entries()),
    body: bufferedBody ? await bufferedBody : null,
  };
}

function rewriteScopedLocation(response, { origin, scopeId, runtimeId }) {
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const resolved = new URL(location, origin);
  if (resolved.origin !== origin) {
    return response;
  }

  const scopedPath = withAppBasePath(`/playground/${scopeId}/${runtimeId}${stripAppBasePath(resolved.pathname)}`.replace(/\/{2,}/gu, "/"));
  const headers = new Headers(response.headers);
  headers.set("location", `${scopedPath}${resolved.search}${resolved.hash}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getScopedBasePath(scopeId, runtimeId) {
  return withAppBasePath(`/playground/${scopeId}/${runtimeId}`);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlAttributeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&sol;", "/")
    .replaceAll("&colon;", ":");
}

function rewriteHtmlAttributeUrl(rawValue, { origin, scopeId, runtimeId }) {
  const decodedValue = decodeHtmlAttributeEntities(rawValue);
  const scopedBasePath = getScopedBasePath(scopeId, runtimeId);
  const appBasePath = getAppBasePath();

  if (!decodedValue) {
    return decodedValue;
  }

  if (
    decodedValue.startsWith("#")
    || decodedValue.startsWith("javascript:")
    || decodedValue.startsWith("data:")
    || decodedValue.startsWith("mailto:")
    || decodedValue.startsWith("tel:")
    || decodedValue.startsWith("//")
  ) {
    return decodedValue;
  }

  // Genuinely relative URLs ("libs/app.js", "./x", "../y") are resolved by the
  // browser against the document's own path. This rewriter only knows the
  // origin, not that path, so rebasing them to the (scoped) webroot is wrong for
  // any HTML served below the root — e.g. an app streaming a ZIP's index.html at
  // /apps/<app>/asset/<id>/, whose "libs/x" must stay relative to that dir.
  // Only root-relative ("/…") and absolute same-origin URLs need scoping.
  if (
    !decodedValue.startsWith("/")
    && !/^[a-z][a-z0-9+.-]*:/iu.test(decodedValue)
  ) {
    return decodedValue;
  }

  try {
    const absolute = new URL(decodedValue, origin);
    if (absolute.origin !== origin) {
      return decodedValue;
    }

    const absolutePath = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    if (absolute.pathname.startsWith(`${scopedBasePath}/`) || absolute.pathname === scopedBasePath) {
      return absolutePath;
    }

    if (appBasePath !== "/" && (absolute.pathname === appBasePath || absolute.pathname.startsWith(`${appBasePath}/`))) {
      return absolutePath;
    }

    if (!absolute.pathname.startsWith("/")) {
      return decodedValue;
    }

    return `${scopedBasePath}${absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`}`.replace(/\/{2,}/gu, "/");
  } catch {
    return decodedValue;
  }
}

function rewriteHtmlDocument(html, scope) {
  let result = html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action|data-href)=["'])([^"']*)(["'])/giu,
    // rewriteHtmlAttributeUrl returns a *decoded* URL (entities turned back
    // into raw &, ", <, > characters). Re-encode it for HTML attribute context
    // before interpolating it back between the quotes, otherwise a decoded
    // value containing a quote could close the attribute early and inject HTML
    // into the playground iframe (reflected XSS).
    (match, prefix, rawValue, suffix) => `${prefix}${escapeHtml(rewriteHtmlAttributeUrl(rawValue, scope))}${suffix}`,
  );

  // Compatibility navigations are nested app-owned documents. Their HTML URLs
  // were rewritten above, but keep their real parent and their own CSP intact.
  // Injecting an inline script here would be rejected by apps that do not
  // expose Nextcloud's top-level CSP nonce.
  if (scope.sandboxedIframe) {
    return result;
  }

  // Nextcloud uses parent.document.location in its JS for row-click navigation.
  // Inside the playground iframe, parent is remote.html — not the Nextcloud
  // page — so the click navigates remote.html away and breaks everything.
  // Inject a script that makes parent === window so navigation stays in the
  // inner iframe.
  //
  // Nextcloud enforces a strict CSP (script-src 'strict-dynamic' 'nonce-…'), so
  // the injected inline script MUST carry the page's CSP nonce or the browser
  // blocks it (which would silently break navigation). Extract the nonce that
  // Nextcloud emitted (meta[name=csp-nonce] or the first nonce'd <script>).
  const nonce =
    (result.match(/<meta[^>]+name=["']csp-nonce["'][^>]+nonce=["']([^"']+)["']/iu) ||
      result.match(/<script[^>]+nonce=["']([^"']+)["']/iu) ||
      [])[1] || "";
  const nonceAttr = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  // Two playground shims (single nonce'd inline script):
  //  1. parent === window, so Nextcloud's parent.location navigation stays in
  //     the inner iframe.
  //  2. A capture-phase click interceptor that re-scopes root-absolute links.
  //     The app-menu navigation hrefs are rendered client-side from Nextcloud's
  //     initial-state with an empty webroot (e.g. "/index.php/apps/files/"), so
  //     they escape the Service Worker scope and 404. Prefix OC.webroot (which
  //     is correctly scoped) onto any same-tab root-absolute link not already
  //     under it.
  // The parent===window override must apply ONLY to the top Nextcloud document
  // (the one framed directly by remote.html). A nested iframe served below it —
  // e.g. an app that embeds its own iframe and talks to it via
  // window.parent.postMessage (the eXeLearning editor's EmbeddingBridge sends
  // EXELEARNING_READY to window.parent and gates on window.parent !== window) —
  // must keep its real parent, or the handshake posts to itself and the host
  // hangs. Detect the top doc by checking the real parent is remote.html.
  const playgroundShim = `<script${nonceAttr}>(function(){try{var n=false;try{n=!!(window.parent&&window.parent!==window&&/\\/remote\\.html(?:[?#]|$)/.test(window.parent.location.pathname));}catch(e){n=true;}if(n){Object.defineProperty(window,"parent",{get:function(){return window}})}}catch(e){}try{document.addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var t=a.getAttribute("target");if(t&&t!=="_self")return;var h=a.getAttribute("href");if(!h||h.charAt(0)!=="/"||h.charAt(1)==="/")return;var w=(window.OC&&OC.webroot)||"";if(!w||h===w||h.indexOf(w+"/")===0)return;e.preventDefault();window.location.href=w+h},true)}catch(e){}})();</script>`;
  result = result.replace(/<head([^>]*)>/iu, `<head$1>${playgroundShim}`);

  // Nextcloud computes OC.webroot from \OC::$WEBROOT, which is "" because the
  // PHP worker is served at SCRIPT_NAME=/index.php. But the iframe is actually
  // served from the scoped path /playground/<scope>/<runtime>/…, so client-side
  // routers (Vue Router base = generateUrl(...) = OC.webroot + path) never match
  // location.pathname and render an empty <RouterView> — this is why Activity
  // and the Apps settings page show nothing. Rewrite the emitted webroot to the
  // scoped base so generateUrl()/router bases match the real location.
  const scopedBase = getScopedBasePath(scope.scopeId, scope.runtimeId);
  if (sandboxedIframeCompatibilityScopes.has(scope.scopeId)) {
    const sandboxedIframeShim = `<script${nonceAttr}>${buildSandboxedIframeCompatibilityScript(scopedBase)}</script>`;
    result = result.replace(
      /<head([^>]*)>/iu,
      `<head$1>${sandboxedIframeShim}`,
    );
  }
  result = result.replace(
    /var _oc_webroot\s*=\s*"[^"]*";/u,
    `var _oc_webroot=${JSON.stringify(scopedBase)};`,
  );

  return result;
}

// WebDAV (remote.php/dav) multistatus responses embed resource paths as
// <d:href> values. PHP runs unscoped (OC::$WEBROOT === ""), so Sabre emits
// hrefs like "/remote.php/dav/files/admin/…". The browser's webdav client
// (OC.webroot is rewritten to the scoped base) expects hrefs under
// "/playground/<scope>/<runtime>/remote.php/dav/…"; when it strips its scoped
// base from an unscoped href the resulting path no longer matches the request,
// and @nextcloud/files throws "Root node does not match requested path".
// Prefix the scoped base onto every root-absolute href, mirroring the HTML and
// Location rewrites.
function rewriteDavHrefs(xml, { scopeId, runtimeId }) {
  const scopedBase = getScopedBasePath(scopeId, runtimeId);
  return xml.replace(
    /(<d:href>)([^<]*)(<\/d:href>)/giu,
    (match, open, value, close) => {
      if (!value || value.charAt(0) !== "/" || value.charAt(1) === "/") {
        return match;
      }
      if (value === scopedBase || value.startsWith(`${scopedBase}/`)) {
        return match;
      }
      return `${open}${scopedBase}${value}${close}`;
    },
  );
}

async function rewriteScopedBodyResponse(response, scope) {
  const contentType = response.headers.get("content-type") || "";
  const isHtml = /text\/html|application\/xhtml\+xml/iu.test(contentType);
  const isXml = /\/xml\b|\+xml\b/iu.test(contentType);
  if (!isHtml && !isXml) {
    return response;
  }

  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const rewritten = isHtml
    ? rewriteHtmlDocument(body, scope)
    : rewriteDavHrefs(body, scope);

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildScopedUrl(url, { scopeId, runtimeId, requestPath }) {
  const scopedPath = withAppBasePath(
    `/playground/${scopeId}/${runtimeId}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`
      .replace(/\/{2,}/gu, "/"),
  );
  return new URL(`${scopedPath}`, url.origin);
}

function forwardToPhpWorker({ serializedRequest, runtimeId, scopeId }) {
  const bridge = ensureBridge(scopeId);
  const id = createWorkerRequestId();

  return new Promise((resolve) => {
    const timeoutId = self.setTimeout(() => {
      pending.delete(id);
      resolve(buildErrorResponse("PHP worker bridge timed out.", 504));
    }, 180000);

    pending.set(id, { resolve, timeoutId });

    bridge.postMessage({
      kind: "http-request",
      id,
      request: serializedRequest,
    });
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.kind === "configure-service-worker") {
    addonProxyUrlOverride = event.data.addonProxyUrl || null;
    if (event.data.sandboxedIframeCompatibility && event.data.scopeId) {
      sandboxedIframeCompatibilityScopes.add(event.data.scopeId);
    } else if (event.data.scopeId) {
      sandboxedIframeCompatibilityScopes.delete(event.data.scopeId);
    }
    return;
  }
  if (event.data?.kind === "clear-static-cache") {
    caches.delete(STATIC_ASSET_CACHE).catch(() => {});
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop /dist caches from older builds before claiming clients.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("fs-dist-") && name !== STATIC_DIST_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Firefox neuters event.request.body once this handler yields to the event
  // loop, so buffer the body synchronously now — before any await — for the
  // methods that carry one. Reading it later (after the resolveScopedRequest()
  // / broadcastToClients() awaits) throws in Firefox and makes the whole
  // handler reject ("A ServiceWorker intercepted the request and encountered an
  // unexpected error"), which broke every WebDAV/PROPFIND/REPORT with a body —
  // e.g. opening folders in the Nextcloud Files app. The buffered bytes are
  // forwarded to the PHP worker in place of the stream. Cloning leaves
  // event.request intact for the pass-through `fetch(event.request)` branches.
  const bufferedBody = ["GET", "HEAD"].includes(event.request.method)
    ? null
    : event.request.clone().arrayBuffer().catch(() => null);
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
      return fetch(event.request);
    }

    // Cache-first for the immutable runtime assets under /dist/ (WASM + intl .so),
    // so reloads (and offline) don't re-download tens of MB. Range requests are
    // passed through so a partial-content consumer still gets a 206.
    if (
      event.request.method === "GET" &&
      !event.request.headers.has("range") &&
      isCacheableDist(url.pathname)
    ) {
      return distCacheFirst(event.request);
    }

    const strippedPath = stripAppBasePath(url.pathname);
    if (strippedPath.split("?")[0] === INTERNAL_PROXY_PATH) {
      return handleInternalProxyRequest(event.request, url);
    }

    const scopedRequest = await resolveScopedRequest(event, url);
    if (!scopedRequest) {
      return fetch(event.request);
    }

    const { scopeId, runtimeId } = scopedRequest;
    if (event.clientId) {
      clientContexts.set(event.clientId, { scopeId, runtimeId });
    }

    const directScoped = extractScopedRuntime(url.pathname);
    if (!directScoped && event.request.mode === "navigate" && event.request.method === "GET") {
      return Response.redirect(buildScopedUrl(url, scopedRequest), 302);
    }

    const sandboxCompatibility = consumeSandboxCompatibility(
      scopedRequest.requestPath,
    );
    const requestPath = sandboxCompatibility.requestPath;

    const forwardedUrl = new URL(requestPath, `${url.origin}/`);

    await broadcastToClients({
      kind: "sw-debug",
      detail: `Intercepting ${event.request.method} ${url.pathname}`,
    });

    // Serve static assets from cache to avoid saturating the serial PHP worker queue.
    if (event.request.method === "GET" && isStaticAssetPath(requestPath)) {
      const cache = await caches.open(STATIC_ASSET_CACHE);
      const cached = await cache.match(url.toString());
      if (cached) return cached;

      await broadcastToClients({ kind: "sw-debug", detail: `[sw-bridge] cache miss → worker: ${requestPath}` });
      const fresh = await forwardToPhpWorker({
        serializedRequest: await buildForwardedRequest(event.request, forwardedUrl, bufferedBody),
        runtimeId,
        scopeId,
      }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

      if (fresh.ok) {
        cache.put(url.toString(), fresh.clone()).catch(() => {});
      }
      return fresh;
    }

    await broadcastToClients({ kind: "sw-debug", detail: `[sw-bridge] → worker: ${event.request.method} ${requestPath}` });
    const response = await forwardToPhpWorker({
      serializedRequest: await buildForwardedRequest(event.request, forwardedUrl, bufferedBody),
      runtimeId,
      scopeId,
    }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

    const locationScopedResponse = rewriteScopedLocation(response, {
      origin: url.origin,
      scopeId,
      runtimeId,
    });
    const redirectCompatibleResponse = preserveSandboxCompatibilityRedirect(
      locationScopedResponse,
      sandboxCompatibility.compatible,
      url.origin,
    );
    return rewriteScopedBodyResponse(redirectCompatibleResponse, {
      origin: url.origin,
      scopeId,
      runtimeId,
      sandboxedIframe: sandboxCompatibility.compatible,
    });
  })());
});
