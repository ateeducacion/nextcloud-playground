import {
  extractZipEntries,
  fetchWithProgress,
  writeEntriesToPhp,
} from "../../lib/nextcloud-loader.js";
import { NEXTCLOUD_ROOT } from "./bootstrap-paths.js";
import { buildOccScript } from "./install-script.js";

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
 *   - { step: "enableApp",  app }              → occ app:enable <app>
 *   - { step: "disableApp", app }              → occ app:disable <app>
 *   - { step: "createUser", username, password, displayName?, email?, groups? }
 *   - { step: "createGroup", group }           → occ group:add <group>
 *   - { step: "addUserToGroup", username, group } → occ group:adduser <group> <username>
 *   - { step: "setConfig", key, value, app? }  → occ config:system:set | config:app:set
 *   - { step: "installApp", appId, url, enable? } → fetch ZIP, extract into
 *       apps/<appId>, then occ app:enable --force <appId>
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
        case "enableApp":
          publish(`Enabling app: ${step.app}`, ratio);
          await occ(["occ", "app:enable", "--force", String(step.app)]);
          break;
        case "disableApp":
          publish(`Disabling app: ${step.app}`, ratio);
          await occ(["occ", "app:disable", String(step.app)]);
          break;
        case "createGroup":
          publish(`Creating group: ${step.group}`, ratio);
          await occ(["occ", "group:add", String(step.group)]);
          break;
        case "createUser": {
          publish(`Creating user: ${step.username}`, ratio);
          const argv = ["occ", "user:add", "--password-from-env"];
          if (step.displayName)
            argv.push("--display-name", String(step.displayName));
          for (const g of step.groups || []) argv.push("--group", String(g));
          argv.push(String(step.username));
          await occ(argv, { OC_PASS: String(step.password || "password") });
          if (step.email) {
            await occ([
              "occ",
              "user:setting",
              String(step.username),
              "settings",
              "email",
              String(step.email),
            ]);
          }
          break;
        }
        case "addUserToGroup":
          publish(`Adding ${step.username} to ${step.group}`, ratio);
          await occ([
            "occ",
            "group:adduser",
            String(step.group),
            String(step.username),
          ]);
          break;
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
          const bytes = await fetchWithProgress(url, (progress) => {
            if (progress?.ratio !== undefined) {
              publish(
                `Downloading app ${appId}: ${Math.round(progress.ratio * 100)}%`,
                ratio,
              );
            }
          });
          const allEntries = extractZipEntries(bytes);
          const appEntries = reRootEntriesToApp(allEntries) || allEntries;
          const binary = await php.binary;
          const fsHost = binary?.FS ? { FS: binary.FS } : php;
          publish(
            `Installing app ${appId} (${appEntries.length} files).`,
            ratio,
          );
          writeEntriesToPhp(
            fsHost,
            appEntries,
            `${NEXTCLOUD_ROOT}/apps/${appId}`,
          );
          if (step.enable !== false) {
            publish(`Enabling app: ${appId}`, ratio);
            await occ(["occ", "app:enable", "--force", appId]);
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
    }
  }

  return { executed };
}
