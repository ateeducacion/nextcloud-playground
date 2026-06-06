import { createSpawnHandler } from "@php-wasm/util";

/**
 * Nextcloud occasionally shells out via proc_open()/exec()/popen() — to locate
 * binaries (\OC\BinaryFinder), generate previews (ffmpeg/libreoffice), run
 * antivirus, or in admin "setup checks". Emscripten cannot fork/exec, and the
 * php-wasm runtime throws an UNCATCHABLE JavaScript error ("popen(), proc_open()
 * etc. are unsupported on this PHP instance") that aborts the entire request —
 * which is why the Activity, Apps and Admin pages render blank.
 *
 * This handler intercepts every spawn attempt and returns empty output with a
 * non-zero (command-not-found) exit code, so Nextcloud sees the external
 * command as unavailable and degrades gracefully instead of crashing.
 */
export function createPlaygroundSpawnHandler() {
  return createSpawnHandler(async (_command, processApi) => {
    try {
      processApi.notifySpawn?.();
    } catch {}
    // Let PHP catch up with the (empty) streams before they close — required
    // by createSpawnHandler, otherwise the streams are gone before PHP reads.
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      processApi.stdout("");
    } catch {}
    try {
      processApi.stderr(
        "command not available in the WebAssembly playground\n",
      );
    } catch {}
    processApi.exit(127);
  });
}
