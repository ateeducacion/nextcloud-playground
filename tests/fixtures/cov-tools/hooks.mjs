// Loader hooks for tests/cov-tools-*.test.mjs and tests/cov-spike-*.test.mjs:
// when a script under scripts/ or spike/ imports one of the specifiers listed
// in COV_TOOLS_STUBS, hand it the matching fake from this directory instead,
// so the CLI's own logic runs without Cloudflare, browsers, git or PHP WASM.
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const STUBS = JSON.parse(process.env.COV_TOOLS_STUBS || "{}");

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (
      parent.startsWith(`${repo}scripts/`) ||
      parent.startsWith(`${repo}spike/`)
    ) {
      return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
