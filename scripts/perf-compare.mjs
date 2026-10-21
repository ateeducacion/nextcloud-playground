#!/usr/bin/env node

/**
 * Performance comparison script for Nextcloud Playground deployments.
 *
 * Measures real, user-visible boot times using Playwright against two
 * deployments (baseline vs candidate). It is designed to quantify the impact
 * of performance work (bundle trimming, WASM startup, persistence changes,
 * service worker caching, etc.).
 *
 * Metrics collected per fresh iteration:
 *   - timeToDomContentLoaded
 *   - timeToRuntimeReady (shell gate + WASM runtime ready:
 *       #address-input enabled + #site-frame with scope + #runtime-id-value)
 *   - timeToLoginForm (best-effort detection of the Nextcloud login form
 *       inside the iframe)
 *   - Navigation + paint timings (FCP, resource bytes) from the Performance API
 *
 * Clean boots by default
 * ----------------------
 * By default the script appends a unique `?blueprint-data=...` payload on every
 * iteration. Because blueprintSourceKey changes, the runtime treats it as a
 * completely new site and performs a full reinstall (bundle extract + SQLite
 * `occ maintenance:install`). This is the expensive path that matters most for
 * performance comparisons.
 *
 * Use `--no-clean` to measure warm / cached boots instead.
 *
 * Usage examples
 * --------------
 *
 * # Compare a PR preview (or branch preview) against production
 * node scripts/perf-compare.mjs \
 *   --base=https://nextcloud-playground.pages.dev/ \
 *   --candidate=https://copilot-port-performance-opt.nextcloud-playground.pages.dev/ \
 *   --iterations=5
 *
 * # Compare your local dev server against production
 * node scripts/perf-compare.mjs \
 *   --base=https://nextcloud-playground.pages.dev/ \
 *   --candidate=http://localhost:8085 \
 *   --iterations=3
 *
 * # Warm boot numbers (re-use caches, SW, opcache, etc.)
 * node scripts/perf-compare.mjs ... --no-clean
 *
 * # Headed mode (visible browser) for debugging slow boots
 * node scripts/perf-compare.mjs ... --headed
 *
 * # Machine-readable output (for archiving or future CI)
 * node scripts/perf-compare.mjs ... --json > perf-results.json
 *
 * # Custom labels in the report
 * node scripts/perf-compare.mjs \
 *   --base=https://... --label-base="prod-main" \
 *   --candidate=https://... --label-candidate="pr-123-perf"
 *
 * Flags
 * -----
 *   --base=<url>           Baseline deployment (production or "before"). Required.
 *   --candidate=<url>      Candidate deployment (PR preview, local, "after"). Required.
 *
 *   Aliases (also accepted):
 *     --prod, --preview, --pr, --before, --after
 *
 *   --iterations=N         Boots per deployment (default: 3). Keep small (boots are expensive).
 *   --headed               Run browsers visibly.
 *   --no-clean             Do not force a unique blueprint. Measures warm boots.
 *   --json                 Print a JSON summary at the end (in addition to human output).
 *   --label-base=NAME      Label to use for the baseline in reports.
 *   --label-candidate=NAME Label to use for the candidate in reports.
 *   --help, -h             Show this help and exit.
 *
 * Notes & caveats
 * ---------------
 * - Boots exercise the full cold path by default and are slow (WASM + ~300+ MB
 *   bundle streaming + occ install). 3–5 iterations is usually enough.
 * - Absolute numbers are affected by network, Cloudflare POP, machine load, etc.
 * - For "before vs after" work: run once for cold, re-run with --no-clean for warm.
 * - This script intentionally mirrors the wait logic from tests/e2e/shell.spec.mjs.
 *
 * Adding this script to your workflow
 * -----------------------------------
 *   make perf-compare BASE=... CANDIDATE=... ITERATIONS=5
 *   (see Makefile target)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

function printHelp() {
  console.log(`
Performance comparison for Nextcloud Playground

Usage:
  node scripts/perf-compare.mjs --base=<url> --candidate=<url> [options]

Options:
  --base=<url>             Baseline (e.g. https://nextcloud-playground.pages.dev/)
  --candidate=<url>        Candidate / PR / local (e.g. http://localhost:8085 or preview URL)
  --iterations=N           Number of iterations per deployment (default 3)
  --headed                 Run with visible browser
  --no-clean               Measure warm (cached) boots instead of clean installs
  --json                   Emit JSON summary at the end
  --label-base=NAME        Human label for baseline
  --label-candidate=NAME   Human label for candidate
  --help, -h               Show this message

Examples:
  node scripts/perf-compare.mjs \\
    --base=https://nextcloud-playground.pages.dev/ \\
    --candidate=https://my-pr-slug.nextcloud-playground.pages.dev/ \\
    --iterations=5

  node scripts/perf-compare.mjs \\
    --base=https://nextcloud-playground.pages.dev/ \\
    --candidate=http://localhost:8085 \\
    --no-clean --headed
`);
}

// Flags that take a value, as --flag=value or --flag value; aliases share a field.
const VALUE_FLAGS = {
  base: "base",
  prod: "base",
  before: "base",
  candidate: "candidate",
  preview: "candidate",
  pr: "candidate",
  after: "candidate",
  iterations: "iterations",
  "label-base": "labelBase",
  "label-candidate": "labelCandidate",
};

export function parseArgs(args = process.argv.slice(2)) {
  const out = {
    base: null,
    candidate: null,
    iterations: 3,
    headed: false,
    forceClean: true,
    json: false,
    labelBase: "baseline",
    labelCandidate: "candidate",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === "--help" || a === "-help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--headed") {
      out.headed = true;
      continue;
    }
    if (a === "--no-clean") {
      out.forceClean = false;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }

    const eq = a.indexOf("=");
    const field =
      a.startsWith("--") && VALUE_FLAGS[a.slice(2, eq === -1 ? undefined : eq)];
    if (!field) continue;
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else if (args[i + 1]) value = args[++i];
    else continue;
    // main() rejects anything that is not a positive integer.
    out[field] = field === "iterations" ? Number.parseInt(value, 10) : value;
  }

  return out;
}

export function buildBlueprintData(
  overrides = {},
  salt = Date.now().toString(36),
) {
  const payload = {
    meta: {
      title: `Perf ${salt}`,
      description:
        "Performance comparison run - forces clean boot via unique blueprint key.",
    },
    landingPage: "/index.php/login",
    siteOptions: {
      title: "Perf Test Site",
      locale: "en",
      timezone: "UTC",
    },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function waitForRuntimeReady(page) {
  // Keep in sync with tests/e2e/shell.spec.mjs
  await page.waitForFunction(
    () => {
      const input = document.querySelector("#address-input");
      return input && !input.disabled;
    },
    { timeout: 180_000 },
  );

  await page.waitForFunction(
    () => {
      const frame = document.querySelector("#site-frame");
      return (
        frame?.getAttribute("src") && /scope=/.test(frame.getAttribute("src"))
      );
    },
    { timeout: 180_000 },
  );

  await page.waitForFunction(
    () => {
      const el = document.querySelector("#runtime-id-value");
      return el?.textContent && el.textContent.trim() !== "-";
    },
    { timeout: 180_000 },
  );
}

async function waitForNextcloudLogin(page) {
  const frame = page.frameLocator("#site-frame");
  const candidate = frame
    .locator(
      'input[name="user"], input#user, input[type="text"][name*="user"], form[action*="login"] input',
    )
    .first();

  await candidate.waitFor({ state: "visible", timeout: 120_000 });
}

async function collectPerfSnapshot(page) {
  return page.evaluate(() => {
    const navEntry = performance.getEntriesByType("navigation")[0] || {};
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((p) => p.name === "first-contentful-paint");
    const resources = performance.getEntriesByType("resource");

    let encodedBytes = 0;
    for (const r of resources) {
      if (r.encodedBodySize) encodedBytes += r.encodedBodySize;
    }

    return {
      domContentLoaded: Math.round(navEntry.domContentLoadedEventEnd || 0),
      domComplete: Math.round(navEntry.domComplete || 0),
      loadEventEnd: Math.round(navEntry.loadEventEnd || 0),
      firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
      approxResourceBytes: encodedBytes,
      resourceCount: resources.length,
    };
  });
}

export function stats(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) return { count: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? max;
  return {
    count: nums.length,
    avg: Math.round(avg),
    min: Math.round(min),
    max: Math.round(max),
    p50: Math.round(p50),
    p95: Math.round(p95),
  };
}

export function formatStats(s) {
  return s.count
    ? `avg=${s.avg} p50=${s.p50} p95=${s.p95} (min ${s.min} / max ${s.max})`
    : "no samples";
}

// A 0 ms boot is still a boot: only an error or a missing time is a failure.
export function succeeded(row) {
  return !row.error && row.timeToRuntimeReady != null;
}

export function formatDelta(baseline, candidate) {
  if (typeof baseline !== "number" || typeof candidate !== "number")
    return "n/a";
  const delta = candidate - baseline;
  const pct = baseline === 0 ? 0 : (delta / baseline) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta} ms (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

async function measureOne({ url, label, iter, forceClean, headed }) {
  const tmpBase = path.join(os.tmpdir(), "nc-play-perf");
  await fs.mkdir(tmpBase, { recursive: true });
  const userDataDir = path.join(tmpBase, `iter-${iter}-${Date.now()}`);
  await fs.mkdir(userDataDir, { recursive: true });

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    viewport: { width: 1280, height: 800 },
    userAgent: "NextcloudPlayground-PerfBot/1.0 (Playwright)",
  });

  const context = browser;
  const page = await context.newPage();

  const out = { label, iter, url, forceClean, error: null };

  const targetUrl = forceClean
    ? `${url}${url.includes("?") ? "&" : "?"}blueprint-data=${buildBlueprintData({}, `${label}-${iter}-${Date.now()}`)}`
    : url;

  const t0 = Date.now();
  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 180_000,
    });
    out.timeToDomContentLoaded = Date.now() - t0;

    const tReady0 = Date.now();
    await waitForRuntimeReady(page);
    out.timeToRuntimeReady = Date.now() - t0;
    out.timeToRuntimeReadyFromDom = Date.now() - tReady0;

    let loginTime = null;
    try {
      const _tLogin0 = Date.now();
      await waitForNextcloudLogin(page);
      loginTime = Date.now() - t0;
    } catch (e) {
      out.loginWaitError = String(e.message || e).slice(0, 140);
    }
    out.timeToLoginForm = loginTime;

    out.perf = await collectPerfSnapshot(page);
    out.addressBar = await page
      .locator("#address-input")
      .inputValue()
      .catch(() => null);
  } catch (err) {
    out.error = String(err.message || err).slice(0, 220);
  } finally {
    await context.close().catch(() => {});
    fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

function printIteration(row) {
  const ready =
    row.timeToRuntimeReady != null ? `${row.timeToRuntimeReady}ms` : "ERR";
  const login =
    row.timeToLoginForm != null
      ? `${row.timeToLoginForm}ms`
      : row.loginWaitError
        ? "no-login"
        : "ERR";
  console.log(
    `  [${row.label} #${row.iter}] domCL=${row.timeToDomContentLoaded ?? "n/a"}ms | runtimeReady=${ready} | login=${login}${row.error ? `  ERR:${row.error}` : ""}`,
  );
}

function printStats(label, rows) {
  const ready = stats(rows.map((r) => r.timeToRuntimeReady));
  const login = stats(rows.map((r) => r.timeToLoginForm));
  const dom = stats(rows.map((r) => r.timeToDomContentLoaded));

  console.log(`\n=== ${label} (n=${ready.count}) ===`);
  console.log(`  timeToDomContentLoaded: ${formatStats(dom)}`);
  console.log(`  timeToRuntimeReady:     ${formatStats(ready)}`);
  console.log(`  timeToLoginForm:        ${formatStats(login)}`);
  return { ready, login, dom };
}

function printComparison(
  baselineLabel,
  candidateLabel,
  baselineStats,
  candidateStats,
) {
  console.log(`\n=== COMPARISON (${candidateLabel} - ${baselineLabel}) ===`);
  console.log(
    `  Δ timeToDomContentLoaded (avg): ${formatDelta(baselineStats.dom.avg, candidateStats.dom.avg)}`,
  );
  console.log(
    `  Δ timeToRuntimeReady     (avg): ${formatDelta(baselineStats.ready.avg, candidateStats.ready.avg)}`,
  );
  console.log(
    `  Δ timeToLoginForm        (avg): ${formatDelta(baselineStats.login.avg, candidateStats.login.avg)}`,
  );
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.base || !args.candidate) {
    console.error("Error: --base and --candidate are required.\n");
    printHelp();
    process.exit(1);
  }

  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    console.error("Error: --iterations must be a positive integer.");
    process.exit(1);
  }

  console.log(`Nextcloud Playground Performance Comparison`);
  console.log(`  Baseline  : ${args.base}   (${args.labelBase})`);
  console.log(`  Candidate : ${args.candidate}   (${args.labelCandidate})`);
  console.log(`  Iterations per deployment: ${args.iterations}`);
  console.log(`  Force clean boots (unique blueprint): ${args.forceClean}`);
  console.log(`  Headed: ${args.headed}\n`);

  const baselineRows = [];
  const candidateRows = [];

  // Baseline
  console.log(`--- ${args.labelBase.toUpperCase()} ---`);
  for (let i = 1; i <= args.iterations; i++) {
    const row = await measureOne({
      url: args.base,
      label: args.labelBase,
      iter: i,
      forceClean: args.forceClean,
      headed: args.headed,
    });
    baselineRows.push(row);
    printIteration(row);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Candidate
  console.log(`\n--- ${args.labelCandidate.toUpperCase()} ---`);
  for (let i = 1; i <= args.iterations; i++) {
    const row = await measureOne({
      url: args.candidate,
      label: args.labelCandidate,
      iter: i,
      forceClean: args.forceClean,
      headed: args.headed,
    });
    candidateRows.push(row);
    printIteration(row);
    await new Promise((r) => setTimeout(r, 1500));
  }

  const baselineStats = printStats(args.labelBase.toUpperCase(), baselineRows);
  const candidateStats = printStats(
    args.labelCandidate.toUpperCase(),
    candidateRows,
  );

  printComparison(
    args.labelBase,
    args.labelCandidate,
    baselineStats,
    candidateStats,
  );

  const baselineOk = baselineRows.filter(succeeded).length;
  const candidateOk = candidateRows.filter(succeeded).length;
  console.log(
    `\n  Success rate: ${args.labelBase} ${baselineOk}/${args.iterations}, ${args.labelCandidate} ${candidateOk}/${args.iterations}`,
  );

  console.log("\n=== NOTES ===");
  console.log(
    " - timeToRuntimeReady matches the e2e gate (address-input + scoped iframe + runtime id).",
  );
  console.log(
    " - Default mode forces full reinstall via unique blueprint key (most relevant for perf PRs).",
  );
  console.log(
    " - Re-run with --no-clean for warm-boot / cache-sensitive numbers.",
  );
  console.log(" - Network, Cloudflare edge, and local machine variance apply.");

  if (args.json) {
    const payload = {
      timestamp: new Date().toISOString(),
      targets: {
        baseline: { url: args.base, label: args.labelBase },
        candidate: { url: args.candidate, label: args.labelCandidate },
      },
      iterations: args.iterations,
      forceClean: args.forceClean,
      baseline: baselineStats,
      candidate: candidateStats,
      deltas: {
        timeToDomContentLoaded: formatDelta(
          baselineStats.dom.avg,
          candidateStats.dom.avg,
        ),
        timeToRuntimeReady: formatDelta(
          baselineStats.ready.avg,
          candidateStats.ready.avg,
        ),
        timeToLoginForm: formatDelta(
          baselineStats.login.avg,
          candidateStats.login.avg,
        ),
      },
      raw: {
        baseline: baselineRows,
        candidate: candidateRows,
      },
    };
    console.log("\n=== JSON ===");
    console.log(JSON.stringify(payload, null, 2));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error("Fatal error in perf-compare:", e);
    process.exit(1);
  });
}
