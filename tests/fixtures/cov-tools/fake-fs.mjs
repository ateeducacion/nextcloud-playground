// node:fs stand-in. COV_FS = { intercept: [names], files: { path: text | { base64 } } }.
// Intercepted calls are logged and not applied; `files` are virtual reads.
import * as fs from "node:fs";
import { record, scenario } from "./log.mjs";

const { intercept = [], files = {} } = scenario("COV_FS");

function wrap(name, real) {
  return (...args) => {
    if (!intercept.includes(name)) return real(...args);
    record({
      fs: name,
      args: args.map((a) => (ArrayBuffer.isView(a) ? { bytes: a.length } : a)),
    });
    return undefined;
  };
}

export const cpSync = wrap("cpSync", fs.cpSync);
export const mkdirSync = wrap("mkdirSync", fs.mkdirSync);
export const rmSync = wrap("rmSync", fs.rmSync);
export const writeFileSync = wrap("writeFileSync", fs.writeFileSync);
export const readdirSync = fs.readdirSync;
export const statSync = fs.statSync;

export function readFileSync(path, options) {
  const virtual = files[String(path)];
  if (virtual === undefined) return fs.readFileSync(path, options);
  const buffer =
    typeof virtual === "string"
      ? Buffer.from(virtual)
      : Buffer.from(virtual.base64, "base64");
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding ? buffer.toString(encoding) : buffer;
}
