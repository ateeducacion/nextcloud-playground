#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

// @php-wasm/web 3.1.22+ references the ICU data file via the source-layout
// path `../intl/shared/icu.dat`, but the published tarball ships the file at
// `./shared/icu.dat` (no sibling `intl` package exists on npm). Without a
// resolver hook, esbuild fails with "Could not resolve ../intl/shared/icu.dat"
// when bundling the worker. See WordPress/wordpress-playground#2776.
const phpWasmWebDir = dirname(require.resolve("@php-wasm/web/package.json"));
const phpWasmIcuDataPlugin = {
  name: "php-wasm-icu-data",
  setup(b) {
    b.onResolve({ filter: /(^|\/)intl\/shared\/icu\.dat$/ }, () => ({
      path: `${phpWasmWebDir}/shared/icu.dat`,
    }));
  },
};

await build({
  entryPoints: ["php-worker.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "php-worker.bundle",
  assetNames: "[name]-[hash]",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  banner: {
    js: `const __APP_ROOT__ = new URL("../", import.meta.url).href;`,
  },
  plugins: [phpWasmIcuDataPlugin],
  loader: {
    ".wasm": "file",
    ".so": "file",
    ".dat": "file",
  },
  // Node.js built-ins referenced by Emscripten-generated code (conditional,
  // never executed in browser). Mark them as external to avoid resolution errors.
  external: [
    "worker_threads",
    "events",
    "fs",
    "path",
    "crypto",
    "os",
    "url",
    "child_process",
    "net",
    "tls",
    "http",
    "https",
    "stream",
    "zlib",
    "util",
    "assert",
    "buffer",
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

console.log("Built dist/php-worker.bundle.js");
