import { resolveProjectUrl } from "./paths.js";

let configPromise;

export async function loadPlaygroundConfig() {
  if (!configPromise) {
    const configUrl = resolveProjectUrl("playground.config.json");
    configPromise = fetch(configUrl, { cache: "no-store" }).then(
      async (response) => {
        if (!response.ok) {
          throw new Error(
            `Unable to load playground config: ${response.status}`,
          );
        }

        return response.json();
      },
    );
  }

  return configPromise;
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
