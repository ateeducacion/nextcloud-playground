import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../../", import.meta.url));
const registerUrl = new URL("./register.mjs", import.meta.url).href;

export const FAKES = {
  fs: { "node:fs": "./fake-fs.mjs" },
  childProcess: { "node:child_process": "./fake-child-process.mjs" },
  zlib: { "node:zlib": "./fake-zlib.mjs" },
  playwright: { "@playwright/test": "./fake-playwright.mjs" },
  php: {
    "@php-wasm/universal": "./fake-php.mjs",
    "@php-wasm/node": "./fake-php.mjs",
  },
};

/**
 * Run a repo script in a child Node process with selected fakes. Coverage of
 * the child is collected by c8 through the inherited NODE_V8_COVERAGE.
 * Returns { status, stdout, stderr, calls } where `calls` are the fakes' logs.
 */
export function runScript(
  script,
  { args = [], stubs = {}, env = {}, cwd = repo } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "cov-tools-log-"));
  const log = join(dir, "calls.jsonl");
  const encodedEnv = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", registerUrl, join(repo, script), ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...encodedEnv,
        COV_TOOLS_STUBS: JSON.stringify(stubs),
        COV_TOOLS_LOG: log,
      },
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
  };
}
