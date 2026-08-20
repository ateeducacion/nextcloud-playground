import { fetchBootAsset } from "../../lib/nextcloud-loader.js";
import { resolveProjectUrl } from "../shared/paths.js";

export async function fetchManifest(manifestName = "latest.json") {
  const url = resolveProjectUrl(`assets/manifests/${manifestName}`);
  // This is the manifest fetch the PHP worker actually performs at boot (the
  // loader's own fetchManifest is the fallback path), so it needs the same
  // phase/URL labelling — otherwise a WebKit "Load failed" arrives bare.
  const response = await fetchBootAsset(url, { cache: "no-cache" }, "manifest");
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
