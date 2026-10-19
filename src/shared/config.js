import { resolveProjectUrl } from "./paths.js";

let configPromise;

export async function loadPlaygroundConfig() {
  if (!configPromise) {
    const configUrl = resolveProjectUrl("playground.config.json");
    configPromise = fetch(configUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Unable to load playground config: ${response.status}`,
          );
        }

        return response.json();
      })
      .catch((error) => {
        // Do not memoize a failure: let the next caller retry the fetch.
        configPromise = undefined;
        throw error;
      });
  }

  return configPromise;
}

// OPcache flag: `?opcache=1|0` overrides playground.config.json's "opcache"
// (shipped as true; off when the key is missing). Single decision point for the worker; the shell
// and remote host only forward the raw parameter. See docs/KNOWN-ISSUES.md#opcache.
export function isOpcacheEnabled(param, config = {}) {
  if (param !== null && param !== undefined && param !== "") {
    return !["0", "false", "off", "no"].includes(String(param).toLowerCase());
  }
  return config.opcache === true;
}

// URL `opcache` value that makes isOpcacheEnabled() return `enabled` against
// this config: null when the config default already does (keeps the URL clean).
export function opcacheUrlParam(enabled, config = {}) {
  if (enabled === (config.opcache === true)) {
    return null;
  }
  return enabled ? "1" : "0";
}

export function getDefaultRuntime(config) {
  return (
    config.runtimes.find((runtime) => runtime.default) || config.runtimes[0]
  );
}

import {
  buildEffectivePlaygroundConfig as _buildEffectivePlaygroundConfig,
  normalizeBlueprint as _normalizeBlueprint,
} from "./blueprint.js";

export function buildEffectivePlaygroundConfig(config, blueprint) {
  return _buildEffectivePlaygroundConfig(config, blueprint);
}

export function normalizeBlueprint(input, config) {
  return _normalizeBlueprint(input, config);
}
