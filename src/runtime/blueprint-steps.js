import { buildOccScript } from "./install-script.js";

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
