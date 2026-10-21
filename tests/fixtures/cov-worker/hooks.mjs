// Loader hooks for tests/cov-worker-*.test.mjs: when php-worker.js imports its
// runtime collaborators, hand it the controllable stubs in this directory so
// the worker's own request/crash logic runs without PHP WASM.
const STUBS = {
  "./src/shared/config.js": "config.mjs",
  "./src/runtime/bootstrap.js": "bootstrap.mjs",
  "./src/runtime/php-loader.js": "php-loader.mjs",
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (
    stub &&
    context.parentURL &&
    new URL(context.parentURL).pathname.endsWith("/php-worker.js")
  ) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
