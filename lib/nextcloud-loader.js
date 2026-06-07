import { resolveProjectUrl } from "../src/shared/paths.js";
import { unzipSync } from "fflate";

const CACHE_NAME = "nextcloud-playground-bundles";
const DEFAULT_MANIFEST_URL = resolveProjectUrl(
  "assets/manifests/latest.json",
).toString();

/**
 * Download a resource with streaming progress reporting.
 */
export async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!contentLength || !response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength, ratio: 1 });
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({
      loaded,
      total: contentLength,
      ratio: Math.min(loaded / contentLength, 1),
    });
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Load and normalize a manifest JSON file.
 */
export async function fetchManifest(manifestUrl) {
  const url = manifestUrl || DEFAULT_MANIFEST_URL;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load manifest: ${response.status}`);
  }
  const manifest = await response.json();
  manifest._manifestUrl = url.toString();
  return manifest;
}

/**
 * Compute SHA-256 hex digest of a Uint8Array.
 */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the absolute bundle URL from a manifest.
 */
function resolveBundleUrl(manifest) {
  const bundlePath = manifest.bundle?.path;
  if (!bundlePath) {
    throw new Error("Manifest does not describe a bundle.");
  }
  return new URL(bundlePath, manifest._manifestUrl).toString();
}

/**
 * Resolve the absolute URL of every part of a chunked ("zip-parts") bundle.
 */
function resolvePartUrls(manifest) {
  return (manifest.bundle?.parts || []).map((part) => ({
    ...part,
    url: new URL(part.path, manifest._manifestUrl).toString(),
  }));
}

/**
 * Download a single bundle part directly into a preallocated buffer at the given
 * offset, so reassembling N parts never holds more than one full bundle in memory.
 */
async function fetchPartInto(url, target, baseOffset, onLoaded) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    target.set(buffer, baseOffset);
    onLoaded?.(buffer.byteLength);
    return buffer.byteLength;
  }
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    target.set(value, baseOffset + loaded);
    loaded += value.byteLength;
    onLoaded?.(loaded);
  }
  return loaded;
}

/**
 * Download a chunked bundle: fetch each part (cache-first, in parallel into one
 * preallocated buffer), reassemble byte-identical bytes, and verify the overall
 * plus per-part SHA-256. Large core bundles are split into <=24 MiB parts so the
 * site can be served from hosts with a per-file size cap (Cloudflare Pages).
 */
async function fetchPartsWithCache(manifest, onProgress) {
  const parts = resolvePartUrls(manifest);
  const sizes = parts.map((part) => Number(part.size) || 0);
  const offsets = [];
  let total = 0;
  for (const size of sizes) {
    offsets.push(total);
    total += size;
  }
  const full = new Uint8Array(total);

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable; fall through to network.
  }

  const loadedByPart = new Array(parts.length).fill(0);
  const emit = (extra = {}) => {
    const loaded = loadedByPart.reduce((sum, value) => sum + value, 0);
    onProgress?.({
      loaded,
      total,
      ratio: total ? Math.min(loaded / total, 1) : 0,
      ...extra,
    });
  };

  await Promise.all(
    parts.map(async (part, index) => {
      const offset = offsets[index];
      const expected = sizes[index];

      if (cache) {
        const cached = await cache.match(part.url);
        if (cached) {
          const bytes = new Uint8Array(await cached.arrayBuffer());
          const ok = part.sha256 ? (await sha256Hex(bytes)) === part.sha256 : true;
          if (ok) {
            full.set(bytes, offset);
            loadedByPart[index] = bytes.byteLength;
            emit();
            return;
          }
          await cache.delete(part.url);
        }
      }

      const written = await fetchPartInto(part.url, full, offset, (loaded) => {
        loadedByPart[index] = loaded;
        emit();
      });
      if (expected && written !== expected) {
        throw new Error(
          `Bundle part size mismatch for ${part.url}: expected ${expected}, got ${written}`,
        );
      }
      const slice = full.subarray(offset, offset + written);
      if (part.sha256) {
        const actual = await sha256Hex(slice);
        if (actual !== part.sha256) {
          throw new Error(
            `Bundle part SHA-256 mismatch: expected ${part.sha256}, got ${actual}`,
          );
        }
      }
      loadedByPart[index] = written;
      emit();

      if (cache) {
        try {
          await cache.put(
            part.url,
            new Response(slice, {
              headers: { "content-type": "application/octet-stream" },
            }),
          );
        } catch {
          // Non-fatal — caching is best-effort.
        }
      }
    }),
  );

  const expectedSha = manifest.bundle?.sha256;
  if (expectedSha) {
    const actual = await sha256Hex(full);
    if (actual !== expectedSha) {
      throw new Error(
        `Bundle SHA-256 mismatch: expected ${expectedSha}, got ${actual}`,
      );
    }
  }
  emit({ ratio: 1 });
  return full;
}

/**
 * Download the bundle ZIP with Cache API caching and SHA-256 verification.
 */
export async function fetchBundleWithCache(manifest, onProgress) {
  if (manifest.bundle?.parts?.length) {
    return fetchPartsWithCache(manifest, onProgress);
  }

  const url = resolveBundleUrl(manifest);
  const expectedSha = manifest.bundle?.sha256;

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable (e.g. opaque origin); fall through to network.
  }

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (expectedSha) {
        const actual = await sha256Hex(bytes);
        if (actual === expectedSha) {
          onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
          return bytes;
        }
        // Hash mismatch — discard and re-download.
        await cache.delete(url);
      } else {
        onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
        return bytes;
      }
    }
  }

  const bytes = await fetchWithProgress(url, onProgress);

  if (expectedSha) {
    const actual = await sha256Hex(bytes);
    if (actual !== expectedSha) {
      throw new Error(
        `Bundle SHA-256 mismatch: expected ${expectedSha}, got ${actual}`,
      );
    }
  }

  if (cache) {
    try {
      const resp = new Response(bytes, {
        headers: { "content-type": "application/zip" },
      });
      await cache.put(url, resp);
    } catch {
      // Non-fatal — caching is best-effort.
    }
  }

  return bytes;
}

/**
 * Main entry point: load manifest + download bundle.
 */
export async function resolveBootstrapArchive(options = {}, onProgress) {
  const manifest = await fetchManifest(options.manifestUrl);
  const bytes = await fetchBundleWithCache(manifest, onProgress);
  return { manifest, bytes };
}

/**
 * Sanitize a ZIP entry path to prevent ZIP-slip (path traversal). Normalizes
 * "\\" to "/" (Windows-built archives), strips leading slashes, and drops empty
 * and "." segments. Returns null when the entry contains a ".." segment (so the
 * caller can skip it) — without this a crafted archive could write outside the
 * target root via entries like "../../evil".
 */
export function sanitizeArchivePath(rawPath) {
  const segments = String(rawPath)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * Extract ZIP entries using fflate, normalize paths, strip leading folder.
 */
export function extractZipEntries(zipBytes) {
  const raw = unzipSync(zipBytes);
  const paths = Object.keys(raw);

  // Detect common leading folder to strip (e.g. "nextcloud/" prefix).
  let prefix = "";
  if (paths.length > 0) {
    const first = paths[0];
    const slashIndex = first.indexOf("/");
    if (slashIndex !== -1) {
      const candidate = first.slice(0, slashIndex + 1);
      const allMatch = paths.every((p) => p.startsWith(candidate));
      if (allMatch) {
        prefix = candidate;
      }
    }
  }

  const entries = [];
  for (const [rawPath, data] of Object.entries(raw)) {
    // Skip directory entries (empty data, trailing slash).
    if (rawPath.endsWith("/") && data.byteLength === 0) {
      continue;
    }
    const path = prefix ? rawPath.slice(prefix.length) : rawPath;
    if (!path) continue;
    // Reject ZIP-slip: skip entries that escape the target root via ".." or
    // absolute paths so extraction can never write outside targetRoot.
    const safePath = sanitizeArchivePath(path);
    if (!safePath) continue;
    entries.push({ path: safePath, data });
  }

  return entries;
}

/**
 * Write extracted entries to the Emscripten FS.
 */
export function writeEntriesToPhp(php, entries, targetRoot, onProgress) {
  const FS = php.FS ?? (php.binary && php.binary.FS);

  function ensureDir(dirPath) {
    const segments = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = `${current}/${segment}`;
      const info = FS.analyzePath(current);
      if (!info?.exists) {
        try {
          FS.mkdir(current);
        } catch {
          // Already exists.
        }
      }
    }
  }

  ensureDir(targetRoot);

  const total = entries.length;
  // Collect per-entry failures instead of letting the first one abort the loop
  // silently. A large app (e.g. the ~70MB eXeLearning editor, thousands of
  // files) can exhaust MEMFS/heap mid-extraction; without this a single failed
  // write left a partial tree and the boot carried on as if the install had
  // succeeded (missing files then 404 at runtime). Throwing an aggregated error
  // lets the caller treat the install as failed and re-attempt on the next boot.
  const failures = [];
  for (let i = 0; i < total; i++) {
    const entry = entries[i];
    const fullPath = `${targetRoot}/${entry.path}`.replace(/\/{2,}/g, "/");
    const dir = fullPath.split("/").slice(0, -1).join("/") || "/";
    try {
      ensureDir(dir);
      FS.writeFile(fullPath, entry.data);
    } catch (err) {
      if (failures.length < 10) {
        failures.push(`${entry.path}: ${err?.message || err}`);
      }
    }
    if (i % 500 === 0 || i === total - 1) {
      onProgress?.({
        ratio: (i + 1) / total,
        path: entry.path,
        index: i,
        total,
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to write ${failures.length}${failures.length >= 10 ? "+" : ""} of ${total} entries to ${targetRoot} (likely out of memory). First failures: ${failures.join("; ")}`,
    );
  }
}
