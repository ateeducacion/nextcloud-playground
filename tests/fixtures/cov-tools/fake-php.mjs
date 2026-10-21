// @php-wasm/universal + @php-wasm/node stand-in for the spike harnesses.
// COV_PHP = { results: [...], files: { path: text } }: each php.run() takes the
// next result ({ text, httpStatusCode, headers, errors, exitCode } or
// { throw: message }); readFileAsBuffer serves `files` or throws ENOENT.
import { record, scenario } from "./log.mjs";

const { results = [], files = {} } = scenario("COV_PHP");
const encoder = new TextEncoder();

export const __private__dont__use = Symbol("private");

export async function loadNodeRuntime(version, options) {
  record({ php: "loadNodeRuntime", version, extensions: options.extensions });
  return { version };
}

export function createNodeFsMountHandler(hostPath) {
  return { hostPath };
}

export async function setPhpIniEntries(_php, entries) {
  record({ php: "ini", entries });
}

export class PHP {
  constructor(runtime) {
    this.runtime = runtime;
    const written = [];
    this.written = written;
    const dirs = new Set(["/"]);
    this[__private__dont__use] = {
      FS: {
        mkdirTree: (path) => dirs.add(path),
        analyzePath: (path) => ({ exists: dirs.has(path) }),
        mkdir: (path) => dirs.add(path),
        writeFile: (path) => {
          written.push(path);
          record({ php: "FS.writeFile", path });
        },
      },
    };
  }
  mkdirTree(path) {
    record({ php: "mkdirTree", path });
  }
  async mount(path, handler) {
    record({ php: "mount", path, hostPath: handler.hostPath });
  }
  writeFile(path, data) {
    record({ php: "writeFile", path, size: data.length });
  }
  readFileAsBuffer(path) {
    if (files[path] === undefined) throw new Error(`ENOENT ${path}`);
    return encoder.encode(files[path]);
  }
  async run(request) {
    record({
      php: "run",
      scriptPath: request.scriptPath ?? null,
      code: request.code ? request.code.slice(0, 200) : null,
      method: request.method ?? null,
      body: request.body ?? null,
      headers: request.headers ?? null,
      server: request.$_SERVER ?? null,
    });
    const next = results.shift() ?? {};
    if (next.throw) throw new Error(next.throw);
    return {
      bytes: encoder.encode(next.text ?? ""),
      httpStatusCode: next.httpStatusCode ?? 200,
      headers: next.headers ?? {},
      errors: next.errors ?? "",
      exitCode: next.exitCode ?? 0,
    };
  }
}
