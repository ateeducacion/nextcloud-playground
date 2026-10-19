import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCacheableAssetResponse,
  isStaticAssetPath,
  shouldInterceptRequest,
} from "../src/shared/sw-asset-cache.js";

const response = (headers = {}, status = 200) =>
  new Response("x", {
    status,
    headers: { "content-type": "application/javascript", ...headers },
  });

describe("service worker asset cache policy", () => {
  it("only considers paths with a static extension", () => {
    assert.equal(isStaticAssetPath("/core/js/files.js?v=abc"), true);
    assert.equal(isStaticAssetPath("/index.php/apps/files/"), false);
    assert.equal(isStaticAssetPath("/ocs/v2.php/cloud/user"), false);
  });

  it("keeps caching real static files and app-declared cacheable PHP assets", () => {
    assert.equal(
      isCacheableAssetResponse("/core/js/files.js?v=abc", response()),
      true,
    );
    // Previews and theming CSS declare a max-age (cacheFor) themselves.
    for (const [path, cacheControl] of [
      [
        "/index.php/core/preview.png?fileId=4&c=etag",
        "private, max-age=86400, immutable",
      ],
      [
        "/index.php/apps/theming/theme/default.css?v=1",
        "private, max-age=86400, must-revalidate",
      ],
      ["/index.php/css/core/abc-server.css", "max-age=31536000, immutable"],
    ]) {
      assert.equal(
        isCacheableAssetResponse(
          path,
          response({ "cache-control": cacheControl }),
        ),
        true,
        path,
      );
    }
  });

  it("does not freeze user files served by PHP at a stable URL", () => {
    // WebDAV downloads carry no max-age: a replaced file keeps the same URL.
    for (const path of [
      "/remote.php/dav/files/admin/Photos/photo.jpg",
      "/remote.php/webdav/Readme.js",
      "/public.php/dav/files/token/logo.png",
    ]) {
      assert.equal(isCacheableAssetResponse(path, response()), false, path);
    }
  });

  it("never stores HTML, partial/error responses or no-store/no-cache", () => {
    const path = "/core/js/files.js";
    assert.equal(
      isCacheableAssetResponse(path, response({ "content-type": "text/html" })),
      false,
    );
    for (const status of [206, 404, 500]) {
      assert.equal(isCacheableAssetResponse(path, response({}, status)), false);
    }
    for (const cacheControl of ["no-store", "no-cache, must-revalidate"]) {
      assert.equal(
        isCacheableAssetResponse(
          path,
          response({ "cache-control": cacheControl }),
        ),
        false,
      );
    }
    assert.equal(
      isCacheableAssetResponse(
        "/index.php/core/preview.png",
        response({ "cache-control": "max-age=0" }),
      ),
      false,
    );
  });
});

describe("service worker request interception", () => {
  const origin = "https://ateeducacion.github.io";

  it("intercepts same-origin requests", () => {
    assert.equal(
      shouldInterceptRequest(
        new URL(`${origin}/nextcloud-playground/playground/s/r/index.php`),
        origin,
      ),
      true,
    );
  });

  // Firefox never settles a respondWith(fetch(event.request)) pass-through when
  // the response is a cross-origin redirect (raw.githubusercontent.com answers
  // `//owner/...` with a relative 307), which hung blueprint downloads.
  it("leaves cross-origin requests to the browser", () => {
    for (const url of [
      "https://raw.githubusercontent.com//HenarLG/Playground_pruebas/refs/heads/main/local_accessibility.zip",
      "https://github.com/nextcloud/server/archive/refs/heads/master.zip",
      "http://ateeducacion.github.io/nextcloud-playground/",
    ]) {
      assert.equal(shouldInterceptRequest(new URL(url), origin), false, url);
    }
  });
});
