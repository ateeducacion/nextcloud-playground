import { appendFileSync } from "node:fs";

// Append one JSON line per observed call to the file named by COV_TOOLS_LOG.
export function record(entry) {
  if (process.env.COV_TOOLS_LOG) {
    appendFileSync(process.env.COV_TOOLS_LOG, `${JSON.stringify(entry)}\n`);
  }
}

export function scenario(name) {
  return JSON.parse(process.env[name] || "{}");
}
