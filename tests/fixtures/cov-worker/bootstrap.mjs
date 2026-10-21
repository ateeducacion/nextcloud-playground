export { PLAYGROUND_DB_PATH } from "../../../src/runtime/bootstrap-paths.js";

export function manifestNameForRuntime(_config, runtimeId) {
  return `${runtimeId}.json`;
}

export function startCoreArchivePrefetch(options) {
  return globalThis.__workerStubs.prefetch(options);
}

export async function bootstrapNextcloud(options) {
  return globalThis.__workerStubs.bootstrap(options);
}
