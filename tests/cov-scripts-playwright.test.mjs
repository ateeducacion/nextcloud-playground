import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildBlueprintData,
  formatDelta,
  parseArgs,
  stats,
} from "../scripts/perf-compare.mjs";

// perf-compare.mjs and generate-og-image.mjs drive Playwright. The CLI tests
// run them as child processes with @playwright/test swapped for a recording
// fake (fixtures/cov-scripts), so no browser starts and nothing is fetched.
const repoDir = fileURLToPath(new URL("..", import.meta.url));
const preload = fileURLToPath(
  new URL("./fixtures/cov-scripts/playwright-preload.mjs", import.meta.url),
);

let workDir;
before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-scripts-pw-"));
});
after(() => rm(workDir, { recursive: true, force: true }));

let runs = 0;
function runScript(script, args = [], env = {}) {
  runs += 1;
  const log = join(workDir, `calls-${runs}.jsonl`);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", preload, script, ...args],
      { cwd: repoDir, env: { ...process.env, ...env, FAKE_PW_LOG: log } },
      async (error, stdout, stderr) => {
        const text = await readFile(log, "utf8").catch(() => "");
        const calls = text.trim()
          ? text
              .trim()
              .split("\n")
              .map((l) => JSON.parse(l))
          : [];
        resolve({ code: error ? error.code : 0, stdout, stderr, calls });
      },
    );
  });
}

describe("perf-compare parseArgs", () => {
  it("defaults to three clean headless iterations", () => {
    assert.deepEqual(parseArgs([]), {
      base: null,
      candidate: null,
      iterations: 3,
      headed: false,
      forceClean: true,
      json: false,
      labelBase: "baseline",
      labelCandidate: "candidate",
      help: false,
    });
  });

  it("reads --flag=value forms and boolean flags", () => {
    const out = parseArgs([
      "--base=https://a.test/",
      "--candidate=https://b.test/",
      "--iterations=5",
      "--label-base=prod",
      "--label-candidate=pr",
      "--headed",
      "--no-clean",
      "--json",
      "-help",
    ]);
    assert.equal(out.base, "https://a.test/");
    assert.equal(out.candidate, "https://b.test/");
    assert.equal(out.iterations, 5);
    assert.equal(out.labelBase, "prod");
    assert.equal(out.labelCandidate, "pr");
    assert.equal(out.headed, true);
    assert.equal(out.forceClean, false);
    assert.equal(out.json, true);
    assert.equal(out.help, true);
  });

  it("reads space-separated values", () => {
    const out = parseArgs([
      "--base",
      "A",
      "--candidate",
      "B",
      "--iterations",
      "2",
      "--label-base",
      "L1",
      "--label-candidate",
      "L2",
      "-h",
      "--help",
    ]);
    assert.deepEqual(
      [
        out.base,
        out.candidate,
        out.iterations,
        out.labelBase,
        out.labelCandidate,
        out.headed,
        out.help,
      ],
      ["A", "B", 2, "L1", "L2", true, true],
    );
  });

  it("accepts the prod/preview/pr/before/after aliases", () => {
    const pairs = [
      [["--prod=P"], "base", "P"],
      [["--prod", "P"], "base", "P"],
      [["--before=P"], "base", "P"],
      [["--before", "P"], "base", "P"],
      [["--preview=C"], "candidate", "C"],
      [["--preview", "C"], "candidate", "C"],
      [["--pr=C"], "candidate", "C"],
      [["--pr", "C"], "candidate", "C"],
      [["--after=C"], "candidate", "C"],
      [["--after", "C"], "candidate", "C"],
    ];
    for (const [argv, key, value] of pairs) {
      assert.equal(parseArgs(argv)[key], value, argv.join(" "));
    }
  });

  it("keeps the default iterations for non-numeric values", () => {
    assert.equal(parseArgs(["--iterations=lots"]).iterations, 3);
    assert.equal(parseArgs(["--iterations", "x"]).iterations, 3);
  });

  it("ignores a valueless trailing flag", () => {
    assert.equal(parseArgs(["--label-candidate"]).labelCandidate, "candidate");
  });
});

describe("perf-compare helpers", () => {
  it("summarises numeric samples and ignores the rest", () => {
    assert.deepEqual(stats([300, null, 100, Number.NaN, 200]), {
      count: 3,
      avg: 200,
      min: 100,
      max: 300,
      p50: 200,
      p95: 300,
    });
    assert.deepEqual(stats([undefined]), { count: 0 });
  });

  it("formats signed deltas with percentages", () => {
    assert.equal(formatDelta(100, 150), "+50 ms (+50.0%)");
    assert.equal(formatDelta(200, 150), "-50 ms (-25.0%)");
    assert.equal(formatDelta(0, 10), "+10 ms (0.0%)");
    assert.equal(formatDelta(undefined, 10), "n/a");
  });

  it("encodes a unique blueprint that lands on the login page", () => {
    const decoded = JSON.parse(
      Buffer.from(
        buildBlueprintData({ locale: "es" }, "salt1"),
        "base64url",
      ).toString(),
    );
    assert.equal(decoded.meta.title, "Perf salt1");
    assert.equal(decoded.landingPage, "/index.php/login");
    assert.equal(decoded.locale, "es");
    assert.notEqual(buildBlueprintData(), buildBlueprintData({}, "other"));
  });
});

describe("perf-compare CLI", () => {
  it("prints help and exits 0", async () => {
    const { code, stdout, calls } = await runScript(
      "scripts/perf-compare.mjs",
      ["--help"],
    );
    assert.equal(code, 0);
    assert.match(stdout, /Performance comparison for Nextcloud Playground/);
    assert.equal(calls.length, 0);
  });

  it("requires both deployments", async () => {
    const { code, stderr, stdout } = await runScript(
      "scripts/perf-compare.mjs",
      ["--base=x"],
    );
    assert.equal(code, 1);
    assert.match(stderr, /--base and --candidate are required/);
    assert.match(stdout, /Usage:/);
  });

  it("measures clean boots of both deployments and prints a JSON report", async () => {
    const { code, stdout, calls } = await runScript(
      "scripts/perf-compare.mjs",
      [
        "--base=https://base.test/?x",
        "--candidate=https://no-login.test/",
        "--iterations=1",
        "--json",
        "--label-base=prod",
      ],
    );
    assert.equal(code, 0);
    const gotos = calls.filter((c) => c.call === "goto").map((c) => c.href);
    assert.match(gotos[0], /^https:\/\/base\.test\/\?x&blueprint-data=/);
    assert.match(gotos[1], /^https:\/\/no-login\.test\/\?blueprint-data=/);
    const launch = calls.find((c) => c.call === "launchPersistentContext");
    assert.equal(launch.options.headless, true);
    assert.equal(calls.filter((c) => c.call === "contextClose").length, 2);
    assert.match(
      stdout,
      /\[prod #1\] domCL=\d+ms \| runtimeReady=\d+ms \| login=\d+ms/,
    );
    assert.match(stdout, /\[candidate #1\] .*login=no-login/);
    assert.match(stdout, /Success rate: prod 1\/1, candidate 1\/1/);
    const json = JSON.parse(stdout.slice(stdout.indexOf("=== JSON ===") + 12));
    assert.equal(json.iterations, 1);
    assert.equal(json.forceClean, true);
    assert.equal(json.raw.baseline[0].addressBar, "/index.php/login");
    assert.deepEqual(json.raw.baseline[0].perf, {
      domContentLoaded: 10,
      domComplete: 21,
      loadEventEnd: 30,
      firstContentfulPaint: 13,
      approxResourceBytes: 100,
      resourceCount: 3,
    });
    assert.equal(json.raw.candidate[0].timeToLoginForm, null);
    assert.equal(json.raw.candidate[0].loginWaitError, "timeout");
    assert.equal(json.deltas.timeToLoginForm, "n/a");
  });

  it("reports failed boots and warm, headed runs", async () => {
    const { code, stdout, calls } = await runScript(
      "scripts/perf-compare.mjs",
      [
        "--prod",
        "https://goto-fail.test/",
        "--pr",
        "https://ok.test/",
        "--iterations=-2",
        "--no-clean",
        "--headed",
      ],
    );
    assert.equal(code, 0);
    const gotos = calls.filter((c) => c.call === "goto").map((c) => c.href);
    assert.deepEqual(gotos, ["https://goto-fail.test/", "https://ok.test/"]);
    assert.equal(
      calls.find((c) => c.call === "launchPersistentContext").options.headless,
      false,
    );
    assert.match(stdout, /Iterations per deployment: 1/);
    assert.match(
      stdout,
      /runtimeReady=ERR \| login=ERR {2}ERR:net::ERR_FAILED/,
    );
    assert.match(stdout, /Success rate: baseline 0\/1, candidate 1\/1/);
    assert.doesNotMatch(stdout, /=== JSON ===/);
  });
});

describe("perf-compare CLI failures", () => {
  it("exits 1 when the browser cannot start", async () => {
    const { code, stderr } = await runScript(
      "scripts/perf-compare.mjs",
      [
        "--base=https://a.test/",
        "--candidate=https://b.test/",
        "--iterations=1",
      ],
      { FAKE_PW_LAUNCH_FAIL: "1" },
    );
    assert.equal(code, 1);
    assert.match(
      stderr,
      /Fatal error in perf-compare: Error: browser launch failed/,
    );
  });
});

describe("generate-og-image CLI", () => {
  it("renders the 1200x630 social card into og-image.png", async () => {
    const { code, calls } = await runScript("scripts/generate-og-image.mjs");
    assert.equal(code, 0);
    assert.deepEqual(
      calls.map((c) => c.call),
      ["launch", "newPage", "setContent", "screenshot", "close"],
    );
    assert.deepEqual(calls[1].options, {
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    assert.match(calls[2].html, /<h1>Nextcloud <span>Playground<\/span><\/h1>/);
    assert.equal(calls[3].options.path, join(repoDir, "og-image.png"));
  });
});
