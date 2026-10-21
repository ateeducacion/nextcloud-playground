// `node --import` preload: route @playwright/test to fake-playwright.mjs and
// skip perf-compare's 1.5 s pauses between boots.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "@playwright/test") {
    return { url: ${JSON.stringify(new URL("./fake-playwright.mjs", import.meta.url).href)}, shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  realSetTimeout(fn, ms === 1500 ? 0 : ms, ...rest);
