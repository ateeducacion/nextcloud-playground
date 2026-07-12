import { setPhpIniEntries } from "@php-wasm/universal";
import { resolveBootstrapArchive } from "../../lib/nextcloud-loader.js";
import {
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
} from "../shared/config.js";
import { buildAutologinScript } from "./autologin-script.js";
import { executeBlueprintSteps } from "./blueprint-steps.js";
import {
  NEXTCLOUD_CONFIG_DIR,
  NEXTCLOUD_DATA_DIR,
  NEXTCLOUD_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  PLAYGROUND_PREPEND_PATH,
} from "./bootstrap-paths.js";
import {
  buildOccInstallScript,
  buildOccScript,
  buildPostInstallConfigScript,
} from "./install-script.js";
import { buildManifestState, fetchManifest } from "./manifest.js";
import { buildPhpPrepend } from "./php-prepend.js";
import { mountReadonlyCore } from "./vfs.js";

export {
  buildPhpPrepend,
  NEXTCLOUD_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  PLAYGROUND_PREPEND_PATH,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function ensureDir(php, dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try {
        await php.mkdir(current);
      } catch {}
    }
  }
}

async function writePlaygroundState(php, state) {
  await php.writeFile(
    PLAYGROUND_CONFIG_PATH,
    encoder.encode(JSON.stringify(state, null, 2)),
  );
}

async function readPlaygroundState(php) {
  const about = await php.analyzePath(PLAYGROUND_CONFIG_PATH);
  if (!about?.exists) return null;
  try {
    const raw = await php.readFile(PLAYGROUND_CONFIG_PATH);
    return JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
}

async function isInstalled(php) {
  const about = await php.analyzePath(`${NEXTCLOUD_CONFIG_DIR}/config.php`);
  if (!about?.exists) return false;
  try {
    const raw = await php.readFile(`${NEXTCLOUD_CONFIG_DIR}/config.php`);
    return decoder.decode(raw).includes("'installed' => true");
  } catch {
    return false;
  }
}

/**
 * Build the version-specific manifest filename for a runtime id.
 */
export function manifestNameForRuntime(rawConfig, runtimeId) {
  const runtime = (rawConfig?.runtimes || []).find(
    (entry) => entry.id === runtimeId,
  );
  return runtime?.nextcloudVersion
    ? `nextcloud-${runtime.nextcloudVersion}.json`
    : "latest.json";
}

/**
 * Start downloading the readonly-core manifest + bundle right away so the fetch
 * overlaps the WASM runtime compile in php.refresh() (parallel boot). Resolves
 * to { manifest, bytes }, consumed by bootstrapNextcloud once the live runtime
 * can extract it. The bundle is Cache-API backed, so a failed or duplicated
 * fetch is cheap.
 */
export function startCoreArchivePrefetch({ manifestName, onProgress } = {}) {
  return fetchManifest(manifestName).then((manifest) =>
    resolveBootstrapArchive({ manifest }, onProgress),
  );
}

export async function bootstrapNextcloud({
  config: rawConfig,
  blueprint: rawBlueprint,
  clean,
  corePrefetch = null,
  php,
  publish,
  runtimeId,
}) {
  const blueprint = normalizeBlueprint(rawBlueprint || {}, rawConfig);
  const config = buildEffectivePlaygroundConfig(rawConfig, blueprint);

  publish("Loading Nextcloud manifest.", 0.2);
  // Reuse the manifest + core bytes prefetched in parallel with php.refresh()
  // when available; otherwise fetch lazily.
  const prefetched = corePrefetch ? await corePrefetch : null;
  const manifest =
    prefetched?.manifest ??
    (await fetchManifest(manifestNameForRuntime(rawConfig, runtimeId)));
  const manifestState = buildManifestState(
    manifest,
    runtimeId,
    rawConfig.bundleVersion,
  );
  const manifestVersion = `${manifestState.release || ""}:${manifestState.sha256 || ""}`;

  publish("Mounting Nextcloud readonly core.", 0.25);
  await mountReadonlyCore(php, manifest, {
    root: NEXTCLOUD_ROOT,
    publish,
    bytes: prefetched?.bytes ?? null,
  });

  publish("Creating mutable directory layout.", 0.42);
  for (const dir of [
    NEXTCLOUD_DATA_DIR,
    NEXTCLOUD_CONFIG_DIR,
    "/internal/shared",
    "/tmp",
  ]) {
    await ensureDir(php, dir);
  }

  publish("Writing PHP prepend (posix polyfill).", 0.46);
  await php.writeFile(
    PLAYGROUND_PREPEND_PATH,
    encoder.encode(buildPhpPrepend()),
  );

  // The posix polyfill MUST be active before occ runs. Set it (and Nextcloud's
  // recommended memory limit) directly on the underlying PHP instance.
  await setPhpIniEntries(php._php, {
    auto_prepend_file: PLAYGROUND_PREPEND_PATH,
    memory_limit: "512M",
    max_execution_time: "0",
    "date.timezone": config.timezone || "UTC",
    display_errors: config.debug?.enabled ? "On" : "Off",
    "session.save_path": "/persist/mutable/session",
    upload_tmp_dir: "/tmp",
  });

  const alreadyInstalled = await isInstalled(php);
  const existingState = await readPlaygroundState(php);
  const versionMatch = existingState?.manifestVersion === manifestVersion;
  const skipInstall = alreadyInstalled && versionMatch && !clean;

  if (!skipInstall) {
    publish("Installing Nextcloud (occ maintenance:install, SQLite).", 0.55);
    const installRes = await php.run(buildOccInstallScript(config));
    const installOut = decoder.decode(installRes.bytes || new Uint8Array());
    if (!(await isInstalled(php))) {
      throw new Error(
        `Nextcloud install failed (exit ${installRes.exitCode}):\n${installOut.slice(0, 2000)}`,
      );
    }

    publish("Applying playground configuration.", 0.68);
    const cfgRes = await php.run(buildPostInstallConfigScript(config));
    const cfgOut = decoder.decode(cfgRes.bytes || new Uint8Array());
    if (!cfgOut.includes("CONFIG_OK")) {
      publish(
        `[warning] Post-install config did not confirm: ${cfgOut.slice(0, 300)}`,
        0.7,
      );
    }

    // Switch background jobs off AJAX so the web UI stops pinging cron.php on
    // every page load (cron can't run real jobs in WASM anyway). Best-effort.
    try {
      await php.run(buildOccScript(["occ", "background:webcron"]));
    } catch {}

    // The "installed" marker is written AFTER the blueprint steps run (below),
    // not here: a step like installApp can fail mid-extraction (e.g. a large
    // app exhausting MEMFS). Recording success only once those steps complete
    // means a partial install is not cached as done and is retried next boot.
  } else {
    publish("Existing install matches bundle version. Skipping install.", 0.68);
  }

  let blueprintResult = { executed: 0, criticalFailure: false };
  if (blueprint.steps.length > 0) {
    publish("Applying blueprint steps.", 0.78);
    blueprintResult = await executeBlueprintSteps({ php, blueprint, publish });
  }

  if (!skipInstall) {
    if (blueprintResult.criticalFailure) {
      publish(
        "[warning] A critical blueprint step failed; not caching the install so it is retried on the next reload.",
        0.92,
      );
    } else {
      await writePlaygroundState(php, {
        manifestVersion,
        runtimeId,
        installedAt: new Date().toISOString(),
        admin: { username: config.admin.username },
      });
    }
  }

  if (config.autologin) {
    await performAutologin(php, config, publish);
  }

  // The skeleton (sample files) is copied to the user's home on first login but
  // is not yet in the file cache, so the Files app shows an empty list. Scan it
  // into the database so the sample files appear. Best-effort.
  if (!skipInstall) {
    publish("Indexing sample files.", 0.93);
    try {
      await php.run(
        buildOccScript(["occ", "files:scan", config.admin.username]),
      );
    } catch {}
  }

  const readyPath =
    blueprint.landingPage || config.landingPath || "/index.php/login";

  publish("Nextcloud is ready.", 0.95);
  return { readyPath };
}

/**
 * Establish a logged-in session server-side and let the compat layer capture
 * the session cookie (via php.request). Best-effort: a failure just leaves the
 * user on the login page.
 */
async function performAutologin(php, config, publish) {
  publish("Signing in the admin user automatically.", 0.9);
  const scriptPath = `${NEXTCLOUD_ROOT}/_playground_autologin.php`;
  await php.writeFile(scriptPath, encoder.encode(buildAutologinScript(config)));
  try {
    const response = await php.request(
      new Request("http://localhost/_playground_autologin.php"),
    );
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      publish("[warning] Autologin returned unexpected output.", 0.92);
      return;
    }
    if (result.ok) {
      publish("Autologin successful.", 0.93);
    } else {
      publish(`[warning] Autologin failed: ${result.error || "unknown"}`, 0.92);
    }
  } catch (err) {
    publish(`[warning] Autologin error: ${err?.message || err}`, 0.92);
  }
}
