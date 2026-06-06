import {
  resolveConfiguredProxyUrl,
  resolveProjectUrl,
} from "../shared/paths.js";
export const APP_LOCATION = resolveProjectUrl("").href;
export function resolveProxyUrl(config) {
  return resolveConfiguredProxyUrl(config, APP_LOCATION);
}
