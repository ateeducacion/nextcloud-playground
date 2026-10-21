// node:child_process stand-in. COV_CP = { responses: [{ match, status, stdout, stderr }] }.
// The first response whose `match` occurs in "<cmd> <args...>" answers the call.
import { record, scenario } from "./log.mjs";

const { responses = [] } = scenario("COV_CP");

function answer(command, args, options) {
  const line = [command, ...args].join(" ");
  record({ cp: line, stdio: options?.stdio ?? null });
  return (
    responses.find((r) => line.includes(r.match)) || {
      status: 127,
      stdout: "",
      stderr: `unexpected command: ${line}`,
    }
  );
}

export function spawnSync(command, args, options) {
  const r = answer(command, args, options);
  return {
    status: r.status ?? 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function execFileSync(command, args, options) {
  const r = answer(command, args, options);
  if ((r.status ?? 0) !== 0) throw new Error(r.stderr || "failed");
  return r.stdout ?? "";
}
