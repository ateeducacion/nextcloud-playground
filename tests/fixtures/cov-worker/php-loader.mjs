export function createPhpRuntime(runtime, options) {
  return globalThis.__workerStubs.createPhp(runtime, options);
}
