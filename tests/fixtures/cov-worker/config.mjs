export { isOpcacheEnabled } from "../../../src/shared/config.js";

export async function loadPlaygroundConfig() {
  return globalThis.__workerStubs.loadConfig();
}
