import { SNAPSHOT_VERSION } from "./protocol.js";

const BLUEPRINT_KEY_PREFIX = "nextcloud-playground:blueprint";

function hasWindow() {
  return typeof window !== "undefined";
}

function getBlueprintStorageKey(scopeId) {
  return `${BLUEPRINT_KEY_PREFIX}:${scopeId}`;
}

// --- Inline blueprint URL payloads ----------------------------------------
// Inline blueprints travel in the URL (?blueprint=) as base64url. To keep
// shareable links short, the JSON is gzip-compressed first when the browser
// supports the Compression Streams API; the compressed bytes keep the standard
// gzip magic (0x1f 0x8b) so the decoder can tell a compressed payload from a
// plain one. Plain base64 JSON (older links, or browsers without the API) keeps
// working unchanged — the decoder accepts both base64 and base64url alphabets.

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function bytesFromBase64(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .replace(/\s+/gu, "");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Blueprint data payload is not valid base64.");
  }

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasGzipMagic(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function pipeThroughStream(bytes, transform) {
  const piped = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function gzipBytes(bytes) {
  return pipeThroughStream(bytes, new CompressionStream("gzip"));
}

async function gunzipBytes(bytes) {
  return pipeThroughStream(bytes, new DecompressionStream("gzip"));
}

/**
 * Encode a blueprint object into the compact base64url payload used in
 * ?blueprint= links. Gzips the JSON when the browser supports it (and the
 * result is actually smaller); otherwise emits plain base64url JSON.
 */
export async function encodeBlueprintParam(blueprint) {
  const utf8 = new TextEncoder().encode(JSON.stringify(blueprint));
  if (typeof CompressionStream === "function") {
    try {
      const gzipped = await gzipBytes(utf8);
      if (gzipped.length < utf8.length) {
        return base64UrlFromBytes(gzipped);
      }
    } catch {
      // Compression unavailable at runtime — fall back to plain base64url.
    }
  }
  return base64UrlFromBytes(utf8);
}

/**
 * Decode a ?blueprint= / ?blueprint-data= payload back into its raw object,
 * transparently handling both gzip-compressed and plain base64(url) JSON.
 */
export async function decodeBlueprintParam(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Blueprint data payload is empty.");
  }

  const bytes = bytesFromBase64(text);
  const jsonBytes =
    hasGzipMagic(bytes) && typeof DecompressionStream === "function"
      ? await gunzipBytes(bytes)
      : bytes;

  let json;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    throw new Error("Blueprint data payload is not valid UTF-8.");
  }

  try {
    return JSON.parse(json);
  } catch {
    throw new Error("Blueprint data payload is not valid JSON.");
  }
}

async function parseBlueprintDataParam(value, config) {
  return normalizeBlueprint(await decodeBlueprintParam(value), config);
}

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

const KNOWN_STEPS = new Set([
  "enableApp",
  "disableApp",
  "createUser",
  "createGroup",
  "addUserToGroup",
  "setConfig",
  "installApp",
  "writeFile",
  "unzip",
  "runOcc",
]);

/**
 * Normalize the blueprint `steps` array. Unknown step types are kept as-is so
 * the runtime can warn about them (forward compatibility); malformed entries
 * (non-objects) are dropped.
 */
function normalizeSteps(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const step = String(entry.step || entry.type || "").trim();
      if (!step) {
        return null;
      }
      const normalized = structuredClone(entry);
      normalized.step = step;
      delete normalized.type;
      return normalized;
    })
    .filter(Boolean);
}

/** Convenience: a top-level `apps: [...]` array expands into enableApp steps. */
function appsToSteps(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((app) => String(app || "").trim())
    .filter(Boolean)
    .map((app) => ({ step: "enableApp", app }));
}

export function getBlueprintSchemaUrl() {
  return new URL(
    "../../assets/blueprints/blueprint-schema.json",
    import.meta.url,
  ).toString();
}

export function buildDefaultBlueprint(config) {
  return {
    $schema: getBlueprintSchemaUrl(),
    meta: {
      title: `${config.siteTitle || "Nextcloud Playground"} Blueprint`,
      author: "nextcloud-playground",
      description: "Default Nextcloud Playground blueprint.",
    },
    debug: { enabled: false },
    landingPage: config.landingPath || "/index.php/login",
    siteOptions: {
      title: config.siteTitle || "Nextcloud Playground",
      locale: config.locale || "en",
      timezone: config.timezone || "UTC",
    },
    admin: {
      username: config.admin?.username || "admin",
      password: config.admin?.password || "admin",
      email: config.admin?.email || "admin@example.com",
    },
    steps: [],
  };
}

export function normalizeBlueprint(input, config) {
  const blueprint =
    input && typeof input === "object" && !Array.isArray(input)
      ? structuredClone(input)
      : {};
  const fallback = buildDefaultBlueprint(config);

  return {
    $schema:
      typeof blueprint.$schema === "string"
        ? blueprint.$schema
        : fallback.$schema,
    meta: {
      title: blueprint.meta?.title || fallback.meta.title,
      author: blueprint.meta?.author || fallback.meta.author,
      description: blueprint.meta?.description || fallback.meta.description,
    },
    debug: { enabled: blueprint.debug?.enabled === true },
    landingPage: normalizePath(
      blueprint.landingPage || blueprint.landingPath || fallback.landingPage,
      fallback.landingPage,
    ),
    siteOptions: {
      title: blueprint.siteOptions?.title || fallback.siteOptions.title,
      locale: blueprint.siteOptions?.locale || fallback.siteOptions.locale,
      timezone:
        blueprint.siteOptions?.timezone || fallback.siteOptions.timezone,
    },
    admin: {
      username:
        blueprint.admin?.username ||
        blueprint.login?.username ||
        fallback.admin.username,
      password:
        blueprint.admin?.password ||
        blueprint.login?.password ||
        fallback.admin.password,
      email: blueprint.admin?.email || fallback.admin.email,
    },
    steps: [...appsToSteps(blueprint.apps), ...normalizeSteps(blueprint.steps)],
  };
}

export function buildEffectivePlaygroundConfig(config, blueprint) {
  const normalized = normalizeBlueprint(blueprint, config);

  return {
    ...config,
    siteTitle: normalized.siteOptions.title,
    locale: normalized.siteOptions.locale,
    timezone: normalized.siteOptions.timezone,
    landingPath: normalized.landingPage,
    debug: normalized.debug,
    admin: { ...normalized.admin },
  };
}

/** Names accepted as blueprint step types (exposed for tests/tooling). */
export function knownStepTypes() {
  return [...KNOWN_STEPS];
}

export function exportBlueprintPayload(config, blueprint) {
  return normalizeBlueprint(blueprint, config);
}

export function saveActiveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.setItem(
    getBlueprintStorageKey(scopeId),
    JSON.stringify(blueprint),
  );
}

export function loadActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.sessionStorage.getItem(getBlueprintStorageKey(scopeId));
  return raw ? JSON.parse(raw) : null;
}

export function clearActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.removeItem(getBlueprintStorageKey(scopeId));
}

export async function resolveBlueprintForShell(scopeId, config) {
  if (!hasWindow()) {
    return buildDefaultBlueprint(config);
  }

  const url = new URL(window.location.href);

  // 1. ?blueprint= (inline base64/JSON, or remote URL for backward compat)
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const looksLikeUrl =
      blueprintParam.startsWith("http://") ||
      blueprintParam.startsWith("https://");
    if (looksLikeUrl) {
      const response = await fetch(
        new URL(blueprintParam, window.location.href),
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          `Unable to load blueprint from ${blueprintParam}: ${response.status}`,
        );
      }
      const payload = normalizeBlueprint(await response.json(), config);
      saveActiveBlueprint(scopeId, payload);
      return payload;
    }
    const payload = await parseBlueprintDataParam(blueprintParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 2. ?blueprint-url= (remote URL — primary, matches moodle-playground)
  const blueprintUrlParam = url.searchParams.get("blueprint-url");
  if (blueprintUrlParam) {
    const response = await fetch(
      new URL(blueprintUrlParam, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(
        `Unable to load blueprint from ${blueprintUrlParam}: ${response.status}`,
      );
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 3. ?blueprint-data= (legacy alias for ?blueprint=, kept for backward compat)
  const blueprintDataParam = url.searchParams.get("blueprint-data");
  if (blueprintDataParam) {
    console.warn(
      "[blueprint] ?blueprint-data= is deprecated, use ?blueprint= instead.",
    );
    const payload = await parseBlueprintDataParam(blueprintDataParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // sessionStorage blueprints are not reloaded on bare URL navigations —
  // the ephemeral runtime should boot clean.

  if (config.defaultBlueprintUrl) {
    const response = await fetch(
      new URL(config.defaultBlueprintUrl, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`Unable to load default blueprint: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  const payload = buildDefaultBlueprint(config);
  saveActiveBlueprint(scopeId, payload);
  return payload;
}

export function parseImportedBlueprintPayload(rawPayload, config) {
  if (rawPayload?.version === SNAPSHOT_VERSION) {
    return {
      type: "snapshot",
      runtimeId: rawPayload.runtimeId,
      path: normalizePath(rawPayload.path, config.landingPath || "/"),
    };
  }

  return {
    type: "blueprint",
    blueprint: normalizeBlueprint(rawPayload, config),
  };
}
