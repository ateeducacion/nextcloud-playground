# Core bundle format: streaming `tar.zst`

## Status

Accepted (2026-07-04). Replaces the ZIP core bundle entirely — there is no ZIP
fallback.

## Context

On every cold boot the playground downloads the Nextcloud core bundle, verifies
its SHA-256, and extracts it into the PHP-WASM in-memory filesystem (MEMFS)
before Nextcloud can serve a request. Previously the bundle was a `nextcloud/`
ZIP: the whole archive was written into MEMFS and extracted with PHP's native
`ZipArchive::extractTo()`.

A ZIP compresses each file independently with a small (32 KiB) window, so it
cannot exploit the huge cross-file redundancy in a Nextcloud tree (thousands of
near-identical l10n files, vendored 3rdparty libraries, compiled JS). The core
bundle was ~167 MiB and, being far above Cloudflare Pages' 25 MiB per-file cap,
had to be split into many `.part-NNN` slices for hosting.

## Decision

Ship the core as a single **solid `tar.zst`** — one zstd stream over a
deterministic USTAR tar of the whole tree — and extract it in the browser by
**streaming zstd decode + incremental TAR parsing**, writing each file into
MEMFS as it decodes.

- **Build** (`scripts/build-tar-zst-bundle.mjs` + `scripts/lib/tar-ustar.mjs`):
  walk the staged tree into a deterministic, files-only USTAR tar (USTAR
  `prefix`/`name` split with a GNU `././@LongLink` fallback for long names — no
  PAX, which tar readers silently mishandle), then compress with `node:zlib`
  zstd level 19 + long-distance matching (windowLog 24 — a 16 MiB decode window;
  dropping from wlog 27's 128 MiB costs only ~+0.9% compressed size but shrinks
  the per-client zstddec decode-window allocation 8×). Requires Node ≥ 22.15
  (CI runs Node 24). The tar entries are root-relative, so no wrapper directory
  is stripped at extraction time.
- **Runtime** (`lib/streaming-tar-extract.js`, driven by
  `src/runtime/vfs.js#mountReadonlyCore`): the compressed bytes feed a streaming
  zstd decoder whose output feeds an incremental USTAR/GNU-longlink parser that
  writes each file straight into the docroot via the raw Emscripten module
  (`php._php.mkdirTree` / `php._php.writeFile`). PharData / `phar` is not used.
  A file-count parity tripwire compares the streamed count against the manifest
  so a truncated download can never silently mount a partial core.
- **Manifest** (`scripts/generate-manifest.mjs`): the bundle descriptor is now
  `{ format: "tar.zst", container: "tar", codec: "zstd", path, size, sha256,
  fileCount }`.
- **Chunking** (`scripts/chunk-bundles.mjs`): the core still exceeds the 25 MiB
  per-file cap even as `tar.zst`, so it is split into `<= 24 MiB` parts at deploy
  time. The splitter is format-agnostic — it preserves the original
  `format`/`codec`/`container` and adds `parts`/`partSize`/`totalSize`/`sha256`.
  The loader (`lib/nextcloud-loader.js`) reassembles the parts into byte-identical
  bytes (per-part and overall SHA-256 verified), and the runtime decodes those
  bytes as `tar.zst` exactly as an un-split bundle.

### Why decode in JS (not PHP)

The PHP WASM binary has `zip` and `phar` but no `zstd`/`brotli` extension, so the
decode has to happen in JS. No shipping browser exposes
`DecompressionStream("zstd")`, so a small `zstddec` (libzstd → WASM) decoder is
bundled into the worker and used for the streaming decode.

## Consequences

- **Smaller download → faster cold boot.** The sibling moodle-playground
  experiment (ADRs 0018 and 0019) measured `tar.zst` cutting the core download
  ~50 % versus the ZIP, and — because the smaller download hides behind the WASM
  compile instead of blocking boot — roughly 3× faster cold boot on a real
  network (Cloudflare). It also dropped the hosted-chunk count.
- **Bounded peak memory.** The ~250 MB-class uncompressed tar is never
  materialized. At any instant the runtime holds only a partial 512-byte header,
  the current entry's bytes (bounded by the largest single file), and one decoded
  chunk; the zstddec decoder's own working set is bounded by the 16 MiB zstd
  window (windowLog 24). This is what let the moodle experiment move from
  "defer" (ADR 0018's full-tar materialization was an OOM risk) to "adopt"
  (ADR 0019's streaming extractor).
- **Cross-browser.** The streaming path works on Chrome and Firefox.
- **Simpler.** ZIP is fully replaced; there is no dual-path fallback to maintain.
  A failed extraction is not cached, so a reload simply retries.

## References

- Sibling measurements: moodle-playground ADR 0018 (solid-compression experiment)
  and ADR 0019 (streaming `tar.zst` extraction).
- Code: `lib/streaming-tar-extract.js`, `scripts/lib/tar-ustar.mjs`,
  `scripts/build-tar-zst-bundle.mjs`, `src/runtime/vfs.js`,
  `scripts/chunk-bundles.mjs`.
