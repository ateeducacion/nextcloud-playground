import { resolveProjectUrl } from "../shared/paths.js";

export async function fetchManifest(manifestName = "latest.json") {
  const url = resolveProjectUrl(`assets/manifests/${manifestName}`);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load Nextcloud manifest: ${response.status}`);
  }
  const manifest = await response.json();
  manifest._manifestUrl = url.toString();
  return manifest;
}

export function buildManifestState(manifest, runtimeId, bundleVersion) {
  return {
    runtimeId,
    bundleVersion,
    release: manifest.release,
    sha256: manifest.bundle?.sha256 || null,
    generatedAt: manifest.generatedAt,
  };
}
