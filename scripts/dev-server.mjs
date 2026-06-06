#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 8080);
const configPath = resolve(repoDir, "playground.config.json");
const playgroundConfig = JSON.parse(await readFile(configPath, "utf8"));
const outboundHttp = playgroundConfig.outboundHttp || {};
const proxyPath =
  String(outboundHttp.proxyPath || "/__addon_proxy__").trim() ||
  "/__addon_proxy__";

const MIME_TYPES = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".zip": "application/zip",
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function jsonResponse(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2), {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept",
    "access-control-expose-headers":
      "Content-Disposition, Content-Type, Content-Length",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
}

function buildCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept",
    "access-control-expose-headers":
      "Content-Disposition, Content-Type, Content-Length",
  };
}

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isAllowedHost(hostname, allowedHosts) {
  const normalizedHost = normalizeHost(hostname);
  return allowedHosts.some((entry) => {
    const normalizedEntry = normalizeHost(entry);
    return (
      normalizedEntry &&
      (normalizedHost === normalizedEntry ||
        normalizedHost.endsWith(`.${normalizedEntry}`))
    );
  });
}

function isNextcloudPluginPage(url) {
  return (
    normalizeHost(url.hostname) === "nextcloud.com" &&
    /^\/plugins\/[^/]+\/?$/u.test(url.pathname)
  );
}

function looksLikePluginDownload(url) {
  const pathname = url.pathname.toLowerCase();
  return (
    pathname.endsWith(".zip") ||
    pathname.includes("/zip/") ||
    pathname.includes("archive/refs/heads/") ||
    pathname.includes("archive/refs/tags/") ||
    /\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)
  );
}

function isSupportedProxyTarget(url) {
  return looksLikePluginDownload(url) || isNextcloudPluginPage(url);
}

function buildDownloadFilename(url) {
  const pathnameParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathnameParts[pathnameParts.length - 1] || "download.zip";
  if (lastPart.toLowerCase().endsWith(".zip")) {
    return sanitizeFilename(lastPart);
  }
  return sanitizeFilename(`${lastPart}.zip`);
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function proxyAddon(req, res, url) {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    jsonResponse(res, 400, { error: 'Missing "url" query parameter.' });
    return;
  }

  let parsedTargetUrl;
  try {
    parsedTargetUrl = new URL(targetUrl);
  } catch (error) {
    jsonResponse(res, 400, { error: "Invalid URL.", details: error.message });
    return;
  }

  if (!["http:", "https:"].includes(parsedTargetUrl.protocol)) {
    jsonResponse(res, 400, {
      error: "Invalid protocol. Only http and https are allowed.",
    });
    return;
  }

  if (
    !isAllowedHost(parsedTargetUrl.hostname, outboundHttp.allowedHosts || [])
  ) {
    jsonResponse(res, 403, {
      error: `Outbound HTTP host "${parsedTargetUrl.hostname}" is not allowed.`,
    });
    return;
  }

  if (!isSupportedProxyTarget(parsedTargetUrl)) {
    jsonResponse(res, 400, {
      error: "The provided URL is not a supported plugin page or ZIP download.",
    });
    return;
  }

  try {
    const upstreamResponse = await fetch(parsedTargetUrl, {
      method: req.method,
      redirect: "follow",
      headers: {
        "User-Agent": "nextcloud-playground-dev-proxy",
        Accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
      },
    });

    if (!upstreamResponse.ok) {
      jsonResponse(res, 502, {
        error: "Upstream server returned an error.",
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
      });
      return;
    }

    const headers = {
      ...buildCorsHeaders(),
      "cache-control": "no-store",
      "content-type":
        upstreamResponse.headers.get("content-type") ||
        (looksLikePluginDownload(parsedTargetUrl)
          ? "application/zip"
          : "text/html; charset=utf-8"),
    };
    const contentDisposition = upstreamResponse.headers.get(
      "content-disposition",
    );
    if (contentDisposition) {
      headers["content-disposition"] = contentDisposition;
    } else if (looksLikePluginDownload(parsedTargetUrl)) {
      headers["content-disposition"] =
        `attachment; filename="${buildDownloadFilename(parsedTargetUrl)}"`;
    }
    const contentLength = upstreamResponse.headers.get("content-length");
    if (contentLength) {
      headers["content-length"] = contentLength;
    }

    res.writeHead(upstreamResponse.status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const body = upstreamResponse.body;
    if (!body) {
      res.end();
      return;
    }

    for await (const chunk of body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    jsonResponse(res, 502, {
      error: "Failed to fetch remote plugin resource.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function safeLocalPath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split("?")[0] || "/");
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const absolute = resolve(repoDir, `.${candidate}`);

  if (!absolute.startsWith(repoDir)) {
    return null;
  }

  return absolute;
}

async function serveStatic(_req, res, url) {
  const targetPath = safeLocalPath(url.pathname);
  if (!targetPath || !existsSync(targetPath)) {
    send(res, 404, "Not found", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  let resolvedPath = targetPath;
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) {
    resolvedPath = join(resolvedPath, "index.html");
  }

  let fileStats;
  try {
    fileStats = await stat(resolvedPath);
  } catch {
    send(res, 404, "Not found", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  const mime =
    MIME_TYPES[extname(resolvedPath).toLowerCase()] ||
    "application/octet-stream";
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": fileStats.size,
    "content-type": mime,
  });
  createReadStream(resolvedPath).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || `127.0.0.1:${port}`}`,
  );

  if (req.method === "OPTIONS" && url.pathname === proxyPath) {
    send(res, 204, "", buildCorsHeaders());
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (url.pathname === proxyPath) {
    await proxyAddon(req, res, url);
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(port, "127.0.0.1", () => {
  log(`Nextcloud playground dev server listening on http://127.0.0.1:${port}`);
});
