import {
  detectArchiveKind,
  extractTarGzEntries,
  extractZipEntries,
  fetchWithProgress,
  writeEntriesToPhp,
} from "../../lib/nextcloud-loader.js";
import { buildLoginScript } from "./autologin-script.js";
import {
  parseJsonFromPhpOutput,
  resolveSharePath,
  resolveSharePermissions,
  resolveShareType,
  resolveWriteFileTarget,
  stepAppId,
  stepGroupId,
  stepUsername,
} from "./blueprint-step-utils.js";
import { NEXTCLOUD_ROOT } from "./bootstrap-paths.js";
import {
  buildOccScript,
  buildUnzipScript,
  buildZipExtractScript,
} from "./install-script.js";
import { buildCreateShareScript } from "./share-script.js";

/**
 * Idempotent `mkdir -p` against the PHP VFS (mirrors bootstrap's ensureDir).
 */
async function ensurePhpDir(php, dirPath) {
  const segments = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try {
        await php.mkdir(current);
      } catch {}
    }
  }
}

/**
 * Re-root extracted ZIP entries to the app directory: the folder that contains
 * `appinfo/info.xml`. `extractZipEntries` already strips a single common
 * leading folder (so a GitHub source archive like `repo-branch/…` arrives with
 * paths starting at `appinfo/…`), but an archive with several top-level entries
 * keeps full paths. Locating `appinfo/info.xml` and slicing its prefix off works
 * for both shapes. Returns null when no app manifest is found.
 */
function reRootEntriesToApp(entries) {
  const marker = entries.find(
    (entry) =>
      entry.path === "appinfo/info.xml" ||
      entry.path.endsWith("/appinfo/info.xml"),
  );
  if (!marker) {
    return null;
  }
  const prefix = marker.path.slice(
    0,
    marker.path.length - "appinfo/info.xml".length,
  );
  if (!prefix) {
    return entries;
  }
  return entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({
      path: entry.path.slice(prefix.length),
      data: entry.data,
    }));
}

/**
 * Execute Nextcloud blueprint steps after install by translating each step to
 * one or more occ commands run in CLI mode through php.run().
 *
 * Supported steps (v1):
 *   - { step: "installNextcloud" }             → no-op (install already ran)
 *   - { step: "login", username, password }    → php.request() session cookie
 *   - { step: "enableApp",  app|appId }        → occ app:enable <app>
 *   - { step: "disableApp", app|appId }        → occ app:disable <app>
 *   - { step: "createUser", username|uid, password, displayName?, email?, groups? }
 *   - { step: "createGroup", group|gid }       → occ group:add <group>
 *   - { step: "addUserToGroup", username|uid, group|gid }
 *   - { step: "setConfig", key, value, app? }  → occ config:system:set | config:app:set
 *   - { step: "installApp", appId, url, enable? } → fetch a ZIP or gzip-tar
 *       (Nextcloud's own app/appstore packaging is always the latter), extract
 *       into apps/<appId>, then occ app:enable --force <appId>
 *   - { step: "writeFile", path, content|url, encoding? } → write a file into
 *       the instance (content inline, or fetched from url; path relative to the
 *       Nextcloud root, or `/<uid>/files/...` into the user's data dir). User
 *       files are followed by occ files:scan.
 *   - { step: "createShare", path, shareType, shareWith?, permissions? }
 *       → OCP\Share\IManager (no stock occ sharing command)
 *   - { step: "unzip", url, destination }      → fetch a ZIP or gzip-tar and
 *       extract it into destination (relative to the Nextcloud root, or
 *       absolute), stripping a single top-level wrapper folder. Overlays a
 *       standalone bundle (e.g. the eXeLearning static editor) into an
 *       already-installed app, mirroring moodle-playground's editor overlay.
 *   - { step: "runOcc", args: [...] }          → occ <args...>
 *
 * Each step is best-effort: a failing step is reported via publish() but does
 * not abort the boot (the playground should still come up).
 */
export async function executeBlueprintSteps({ php, blueprint, publish }) {
  const steps = Array.isArray(blueprint?.steps) ? blueprint.steps : [];
  if (steps.length === 0) {
    return { executed: 0 };
  }

  const decoder = new TextDecoder();
  let executed = 0;
  // Set when a step that the instance can't work without (currently installApp)
  // fails. The caller uses this to avoid caching a partial install as "done".
  let criticalFailure = false;
  let loggedInUser = null;
  const defaultOwner =
    blueprint?.admin?.username || blueprint?.login?.username || "admin";

  async function occ(argv, env = {}) {
    const res = await php.run(buildOccScript(argv, env));
    const out = decoder.decode(res.bytes || new Uint8Array());
    return { ok: (res.exitCode ?? 0) === 0, out, exitCode: res.exitCode ?? 0 };
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const name = step.step || step.type;
    const ratio = 0.78 + (i / steps.length) * 0.07;
    try {
      switch (name) {
        case "installNextcloud":
          // The real install runs in bootstrap before steps. Keep this as an
          // idempotent marker so documented blueprints don't warn/no-op.
          publish("Nextcloud is already installed.", ratio);
          break;
        case "login": {
          const username = stepUsername(step, defaultOwner);
          const password = String(step.password || "password");
          if (!username) {
            publish("[warning] login requires username.", ratio);
            continue;
          }
          if (typeof php.request !== "function") {
            publish(
              "[warning] login requires php.request() (cookie jar).",
              ratio,
            );
            continue;
          }
          publish(`Signing in: ${username}`, ratio);
          const scriptPath = `${NEXTCLOUD_ROOT}/_playground_autologin.php`;
          await php.writeFile(
            scriptPath,
            new TextEncoder().encode(buildLoginScript({ username, password })),
          );
          const response = await php.request(
            new Request("http://localhost/_playground_autologin.php"),
          );
          const text = await response.text();
          const result = parseJsonFromPhpOutput(text);
          if (!result?.ok) {
            throw new Error(result?.error || "login failed");
          }
          loggedInUser = result.uid || username;
          break;
        }
        case "enableApp": {
          const app = stepAppId(step);
          publish(`Enabling app: ${app}`, ratio);
          await occ(["occ", "app:enable", "--force", app]);
          break;
        }
        case "disableApp": {
          const app = stepAppId(step);
          publish(`Disabling app: ${app}`, ratio);
          await occ(["occ", "app:disable", app]);
          break;
        }
        case "createGroup": {
          const group = stepGroupId(step);
          publish(`Creating group: ${group}`, ratio);
          await occ(["occ", "group:add", group]);
          break;
        }
        case "createUser": {
          const username = stepUsername(step);
          publish(`Creating user: ${username}`, ratio);
          const argv = ["occ", "user:add", "--password-from-env"];
          if (step.displayName)
            argv.push("--display-name", String(step.displayName));
          for (const g of step.groups || []) argv.push("--group", String(g));
          argv.push(username);
          await occ(argv, { OC_PASS: String(step.password || "password") });
          if (step.email) {
            await occ([
              "occ",
              "user:setting",
              username,
              "settings",
              "email",
              String(step.email),
            ]);
          }
          break;
        }
        case "addUserToGroup": {
          const username = stepUsername(step);
          const group = stepGroupId(step);
          publish(`Adding ${username} to ${group}`, ratio);
          await occ(["occ", "group:adduser", group, username]);
          break;
        }
        case "setConfig":
          publish(`Setting config: ${step.key}`, ratio);
          if (step.app) {
            await occ([
              "occ",
              "config:app:set",
              String(step.app),
              String(step.key),
              "--value",
              String(step.value),
            ]);
          } else {
            await occ([
              "occ",
              "config:system:set",
              String(step.key),
              "--value",
              String(step.value),
            ]);
          }
          break;
        case "installApp": {
          const appId = String(step.appId || step.app || "").trim();
          const url = String(step.url || "").trim();
          if (!appId || !url) {
            publish("[warning] installApp requires both appId and url.", ratio);
            continue;
          }
          publish(`Downloading app: ${appId}`, ratio);
          // `let` so the compressed buffer can be released as soon as PHP has it.
          let bytes = await fetchWithProgress(url, (progress) => {
            if (progress?.ratio !== undefined) {
              publish(
                `Downloading app ${appId}: ${Math.round(progress.ratio * 100)}%`,
                ratio,
              );
            }
          });
          publish(`Installing app ${appId}.`, ratio);
          // Nextcloud's own app/appstore packaging (`make dist` / `make
          // appstore`) produces a gzip tar, not a ZIP — ZipArchive can't open
          // it, so route by magic bytes instead of assuming ZIP. Packages are
          // a few MB (not the ~70MB eXeLearning editor), so a single in-memory
          // pass is fine; no PHP-side / streaming tier is needed here.
          if (detectArchiveKind(bytes) === "gzip") {
            const allEntries = await extractTarGzEntries(bytes);
            bytes = null;
            const appEntries = reRootEntriesToApp(allEntries) || allEntries;
            const binary = await php.binary;
            const fsHost = binary?.FS ? { FS: binary.FS } : php;
            writeEntriesToPhp(
              fsHost,
              appEntries,
              `${NEXTCLOUD_ROOT}/apps/${appId}`,
            );
          } else {
            // Hand the zip to PHP and extract it there with ZipArchive. libzip
            // inflates + writes one entry at a time, so a big app (the ~70MB /
            // 3000+ file eXeLearning editor) no longer needs the whole tree
            // decompressed in JS at once — the JS path peaked at
            // compressed + full-decompressed-tree + MEMFS copy and OOM'd /
            // partially installed on constrained clients. The zip lives in
            // MEMFS so the JS fallback below can read it back without
            // re-downloading.
            const tmpZip = `/tmp/${appId}-install.zip`;
            const stage = `/tmp/${appId}-stage`;
            await php.writeFile(tmpZip, bytes);
            bytes = null; // released; PHP reads the zip from MEMFS
            const exRes = await php.run(
              buildZipExtractScript(appId, tmpZip, stage),
            );
            const exOut = decoder
              .decode(exRes.bytes || new Uint8Array())
              .trim();
            if (!exOut.includes("INSTALL_OK")) {
              // ext/zip missing or extraction failed: fall back to the JS path,
              // reading the zip back from MEMFS. This re-incurs the higher JS
              // peak, but only when PHP extraction is unavailable.
              publish(
                `[warning] PHP extraction unavailable for ${appId} (${exOut.slice(0, 80)}); using JS fallback.`,
                ratio,
              );
              const fallbackBytes = await php.readFile(tmpZip);
              const allEntries = extractZipEntries(fallbackBytes);
              const appEntries = reRootEntriesToApp(allEntries) || allEntries;
              const binary = await php.binary;
              const fsHost = binary?.FS ? { FS: binary.FS } : php;
              writeEntriesToPhp(
                fsHost,
                appEntries,
                `${NEXTCLOUD_ROOT}/apps/${appId}`,
              );
              try {
                await php.run(`<?php @unlink('${tmpZip}');`);
              } catch {}
            }
          }
          if (step.enable !== false) {
            publish(`Enabling app: ${appId}`, ratio);
            await occ(["occ", "app:enable", "--force", appId]);
          }
          break;
        }
        case "writeFile": {
          const path = String(step.path || "").trim();
          if (!path) {
            publish("[warning] writeFile requires a path.", ratio);
            continue;
          }
          const { target, scanUid } = resolveWriteFileTarget(path);
          const url = String(step.url || "").trim();
          let bytes;
          if (url) {
            publish(`Downloading file: ${path}`, ratio);
            bytes = await fetchWithProgress(url, (progress) => {
              if (progress?.ratio !== undefined) {
                publish(
                  `Downloading ${path}: ${Math.round(progress.ratio * 100)}%`,
                  ratio,
                );
              }
            });
          } else {
            const raw = step.content ?? step.contents ?? "";
            if (step.encoding === "base64") {
              const binary = atob(String(raw).replace(/\s+/g, ""));
              bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            } else {
              bytes = new TextEncoder().encode(String(raw));
            }
          }
          publish(`Writing file: ${path}`, ratio);
          const lastSlash = target.lastIndexOf("/");
          await ensurePhpDir(
            php,
            lastSlash > 0 ? target.slice(0, lastSlash) : "/",
          );
          await php.writeFile(target, bytes);
          if (scanUid) {
            publish(`Indexing files for ${scanUid}.`, ratio);
            await occ(["occ", "files:scan", scanUid]);
          }
          break;
        }
        case "createShare": {
          const rawPath = String(step.path || "").trim();
          if (!rawPath) {
            publish("[warning] createShare requires a path.", ratio);
            continue;
          }
          const resolved = resolveSharePath(
            rawPath,
            stepUsername(step, defaultOwner),
          );
          const shareType = resolveShareType(step.shareType);
          if ((shareType === 0 || shareType === 1) && !step.shareWith) {
            publish(
              "[warning] createShare user/group shares require shareWith.",
              ratio,
            );
            continue;
          }
          const permissions = resolveSharePermissions(
            step.permissions,
            shareType,
          );
          publish(`Creating share: ${rawPath}`, ratio);
          const res = await php.run(
            buildCreateShareScript({
              owner: resolved.owner,
              userPath: resolved.userPath,
              shareType,
              shareWith: step.shareWith || "",
              permissions,
              password: step.password || "",
              expireDate: step.expireDate || "",
              note: step.note || "",
              label: step.label || "",
            }),
          );
          const out = decoder.decode(res.bytes || new Uint8Array());
          const result = parseJsonFromPhpOutput(out);
          if (!result?.ok) {
            throw new Error(
              result?.error || out.slice(0, 300) || "createShare failed",
            );
          }
          break;
        }
        case "unzip": {
          const destRaw = String(step.destination || step.path || "").trim();
          const url = String(step.url || step?.data?.url || "").trim();
          if (!destRaw || !url) {
            publish("[warning] unzip requires a destination and a url.", ratio);
            continue;
          }
          const destination = destRaw.startsWith("/")
            ? destRaw
            : `${NEXTCLOUD_ROOT}/${destRaw}`;
          publish(`Downloading archive: ${destRaw}`, ratio);
          // `let` so the compressed buffer is released as soon as PHP has it.
          let bytes = await fetchWithProgress(url, (progress) => {
            if (progress?.ratio !== undefined) {
              publish(
                `Downloading ${destRaw}: ${Math.round(progress.ratio * 100)}%`,
                ratio,
              );
            }
          });
          publish(`Extracting archive to ${destRaw}.`, ratio);
          // Route by magic bytes: Nextcloud app/appstore packaging produces a
          // gzip tar, which ZipArchive can't open (see installApp above).
          if (detectArchiveKind(bytes) === "gzip") {
            const entries = await extractTarGzEntries(bytes);
            bytes = null;
            const binary = await php.binary;
            const fsHost = binary?.FS ? { FS: binary.FS } : php;
            writeEntriesToPhp(fsHost, entries, destination);
          } else {
            // Same low-memory path as installApp: hand the zip to PHP and
            // extract it there with ZipArchive (one entry at a time) so a big
            // bundle like the ~70MB / 3000+ file eXeLearning editor doesn't
            // OOM constrained clients. The zip stays in MEMFS so the JS
            // fallback can read it back.
            const tmpZip = `/tmp/unzip-${i}.zip`;
            const stage = `/tmp/unzip-${i}-stage`;
            await php.writeFile(tmpZip, bytes);
            bytes = null; // released; PHP reads the zip from MEMFS
            const exRes = await php.run(
              buildUnzipScript(tmpZip, stage, destination),
            );
            const exOut = decoder
              .decode(exRes.bytes || new Uint8Array())
              .trim();
            if (!exOut.includes("UNZIP_OK")) {
              // ext/zip missing or extraction failed: fall back to the JS path,
              // reading the zip back from MEMFS. extractZipEntries strips a
              // single common leading folder (the editor's "static/"),
              // matching the PHP extractor above.
              publish(
                `[warning] PHP extraction unavailable for ${destRaw} (${exOut.slice(0, 80)}); using JS fallback.`,
                ratio,
              );
              const fallbackBytes = await php.readFile(tmpZip);
              const entries = extractZipEntries(fallbackBytes);
              const binary = await php.binary;
              const fsHost = binary?.FS ? { FS: binary.FS } : php;
              writeEntriesToPhp(fsHost, entries, destination);
              try {
                await php.run(`<?php @unlink('${tmpZip}');`);
              } catch {}
            }
          }
          break;
        }
        case "runOcc":
          publish(`Running occ ${(step.args || []).join(" ")}`, ratio);
          await occ(["occ", ...(step.args || []).map(String)]);
          break;
        default:
          publish(`[warning] Unknown blueprint step: ${name}`, ratio);
          continue;
      }
      executed++;
    } catch (err) {
      publish(`[warning] Step "${name}" failed: ${err?.message || err}`, ratio);
      if (name === "installApp") {
        criticalFailure = true;
      }
    }
  }

  return { executed, criticalFailure, loggedInUser };
}
