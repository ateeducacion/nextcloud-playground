import { resolveBootstrapArchive } from "../../lib/nextcloud-loader.js";
import { buildCoreExtractScript } from "./install-script.js";

const decoder = new TextDecoder();

export async function mountReadonlyCore(
  php,
  manifest,
  { root = "/www/nextcloud", publish, bytes = null } = {},
) {
  // Parallel boot: prefer the core bytes the worker downloaded while the WASM
  // runtime was compiling. Fall back to a lazy download when called without
  // them, where the bundle is served from the Cache API so the fetch is cheap.
  let archiveBytes = bytes;
  if (!archiveBytes) {
    const archive = await resolveBootstrapArchive({ manifest }, (progress) => {
      if (publish && progress.ratio !== undefined) {
        publish(
          `Downloading Nextcloud bundle: ${Math.round(progress.ratio * 100)}%`,
          0.3 + progress.ratio * 0.15,
        );
      }
    });
    archiveBytes = archive.bytes;
  }

  // Extract the core with PHP's native ZipArchive instead of decompressing the
  // whole ~167 MB / ~15 496-file archive in JS. libzip inflates + writes one
  // entry at a time (fast at any file count, ~one-entry peak), avoiding both the
  // fflate `unzipSync` heap OOM and the per-entry DecompressionStream overhead
  // of `decodeZip` (which made boot exceed the readiness gate). Write the zip to
  // MEMFS, run the extractor, then fail loud if ext/zip is missing or it errors
  // — the install is not cached, so a reload retries (no JS fallback by design).
  const tmpZip = "/tmp/nextcloud-core.zip";
  const stage = "/tmp/nextcloud-core-stage";
  publish?.("Extracting Nextcloud core…", 0.45);
  await php.writeFile(tmpZip, archiveBytes);
  // Drop the JS reference to the compressed buffer now that MEMFS has its own
  // copy, so the GC can reclaim it while ZipArchive extracts.
  archiveBytes = null;
  const result = await php.run(buildCoreExtractScript(tmpZip, stage, root));
  const out = decoder.decode(result.bytes || new Uint8Array()).trim();
  if (!out.startsWith("INSTALL_OK")) {
    throw new Error(
      `Nextcloud core extraction failed: ${out.slice(0, 200)} ` +
        "(PHP ext/zip is required to mount the core).",
    );
  }
  const written = Number.parseInt(out.slice("INSTALL_OK".length).trim(), 10);

  return { manifest, entries: written };
}

export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}
