import { resolveBootstrapArchive } from "../../lib/nextcloud-loader.js";

export async function mountReadonlyCore(
  php,
  manifest,
  { root = "/www/nextcloud", publish, bytes = null } = {},
) {
  // Parallel boot: prefer the core bytes the worker downloaded while the WASM
  // runtime was compiling. Fall back to a lazy download when called without
  // them, where the bundle is served from the Cache API so the fetch is cheap.
  // For a chunked (oversized) bundle resolveBootstrapArchive reassembles the
  // parts into the whole tar.zst before returning — transparent here.
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

  // Stream the solid tar.zst core into MEMFS one entry at a time: a streaming
  // zstd decode feeds an incremental USTAR/GNU-longlink parser that writes each
  // file straight under `root` (creating parent dirs on the way). The full
  // ~250 MB-class uncompressed tar is never materialized — peak memory stays
  // bounded to about one file — and it works on Chrome and Firefox (no browser
  // exposes DecompressionStream("zstd"), so a small zstddec WASM decoder is
  // bundled). This fully replaces the old ZIP path (no fallback by design); the
  // install is not cached, so a reload retries on any failure.
  const { createDecodedTarStream, extractTarStreamToPhp } = await import(
    "../../lib/streaming-tar-extract.js"
  );
  publish?.("Extracting Nextcloud core…", 0.45);
  const stream = await createDecodedTarStream(archiveBytes, "zstd");
  // Drop the JS reference to the compressed buffer; the decode stream owns it now.
  archiveBytes = null;
  const stats = await extractTarStreamToPhp(stream, php, root);

  // Parity tripwire: the streamed file count must match the manifest, so a
  // truncated/short download can never silently mount a partial core.
  if (
    manifest?.bundle?.fileCount &&
    stats.fileCount !== manifest.bundle.fileCount
  ) {
    throw new Error(
      `core tar file-count parity mismatch: ${stats.fileCount} != ${manifest.bundle.fileCount}`,
    );
  }

  return { manifest, entries: stats.fileCount };
}
