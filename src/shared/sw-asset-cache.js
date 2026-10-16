// Policy for the Service Worker's page-asset cache (sw.js). Ported from
// moodle-playground ADR-0034: a path ending in .js/.png is not a static file
// when PHP serves it through PATH_INFO (WebDAV downloads, previews).
const STATIC_EXTENSION =
  /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpg|jpeg|gif|svg|ico|webp|map)$/iu;

export function isStaticAssetPath(requestPath) {
  return STATIC_EXTENSION.test(requestPath.split("?")[0]);
}

// Cache only complete, non-HTML responses whose headers allow it. A PHP route
// is dynamic content at a stable URL (a user file can change behind it), so it
// needs an explicit max-age from the app, as previews and theming CSS send.
export function isCacheableAssetResponse(requestPath, response) {
  if (response.status !== 200) return false;
  const type = response.headers.get("content-type") || "";
  if (/text\/html|application\/xhtml\+xml/iu.test(type)) return false;
  const cacheControl = (response.headers.get("cache-control") || "")
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim());
  if (cacheControl.some((d) => d === "no-store" || d === "no-cache"))
    return false;
  if (!/\.php(?:\/|$)/iu.test(requestPath.split("?")[0])) return true;
  return cacheControl.some((d) => /^max-age=[1-9]\d*$/u.test(d));
}
