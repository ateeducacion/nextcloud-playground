import { NEXTCLOUD_DATA_DIR, NEXTCLOUD_ROOT } from "./bootstrap-paths.js";

/** Nextcloud OCS share types: 0 user, 1 group, 3 public link. */
const SHARE_TYPES = {
  user: 0,
  users: 0,
  group: 1,
  groups: 1,
  public: 3,
  link: 3,
  "public-link": 3,
  public_link: 3,
  email: 4,
  mail: 4,
};

/** Nextcloud permission bits: 1 read, 2 update, 4 create, 8 delete, 16 share, 31 all. */
const PERMISSION_BITS = {
  read: 1,
  update: 2,
  write: 2,
  create: 4,
  delete: 8,
  share: 16,
  all: 31,
};

const ABSOLUTE_VFS_PREFIXES = ["/www/", "/persist/", "/tmp/", "/internal/"];

export function stepAppId(step) {
  return String(step?.appId || step?.app || "").trim();
}

export function stepUsername(step, fallback = "") {
  return String(
    step?.username || step?.uid || step?.owner || fallback || "",
  ).trim();
}

export function stepGroupId(step) {
  return String(step?.group || step?.gid || "").trim();
}

export function resolveShareType(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const key = String(value ?? "public")
    .trim()
    .toLowerCase();
  if (Object.hasOwn(SHARE_TYPES, key)) {
    return SHARE_TYPES[key];
  }
  if (/^-?\d+$/.test(key)) {
    return Number(key);
  }
  throw new Error(`Unknown shareType: ${value}`);
}

function permissionBit(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (Object.hasOwn(PERMISSION_BITS, key)) {
    return PERMISSION_BITS[key];
  }
  if (/^-?\d+$/.test(key)) {
    return Number(key);
  }
  throw new Error(`Unknown permissions: ${value}`);
}

export function resolveSharePermissions(value, shareType) {
  if (value === undefined || value === null || value === "") {
    return shareType === 3 ? 1 : 31;
  }
  if (Array.isArray(value)) {
    return value.reduce((acc, item) => acc | permissionBit(item), 0);
  }
  return permissionBit(value);
}

/**
 * Resolve a createShare `path` into `{ owner, userPath }` relative to the
 * owner's files root. Accepts user-relative paths (`/welcome.md`), the
 * documented `/<uid>/files/...` shortcut, and a `data/<uid>/files/...`
 * writeFile target.
 */
export function resolveSharePath(path, defaultOwner = "admin") {
  const raw = String(path || "").trim();
  const fallbackOwner = String(defaultOwner || "admin").trim() || "admin";
  if (!raw) {
    return { owner: fallbackOwner, userPath: "" };
  }

  const dataMatch = raw.match(
    /^(?:\/www\/nextcloud\/)?data\/([^/]+)\/files(?:\/(.*))?$/u,
  );
  if (dataMatch) {
    return { owner: dataMatch[1], userPath: dataMatch[2] || "" };
  }

  const userFiles = raw.match(/^\/?([^/]+)\/files(?:\/(.*))?$/u);
  if (
    userFiles &&
    !["www", "persist", "tmp", "internal", "data"].includes(userFiles[1])
  ) {
    return { owner: userFiles[1], userPath: userFiles[2] || "" };
  }

  return { owner: fallbackOwner, userPath: raw.replace(/^\/+/u, "") };
}

function userFilesFromAbs(absPath) {
  const prefix = `${NEXTCLOUD_DATA_DIR}/`;
  if (!absPath.startsWith(prefix)) {
    return null;
  }
  const rest = absPath.slice(prefix.length);
  const match = rest.match(/^([^/]+)\/files(?:\/|$)/u);
  return match ? match[1] : null;
}

/**
 * Resolve a writeFile `path` into an absolute VFS target. `/<uid>/files/...`
 * is the documented shortcut into the user's data directory; everything else
 * stays relative to the Nextcloud root (or is used as-is when already absolute).
 */
export function resolveWriteFileTarget(path) {
  const raw = String(path || "").trim();
  if (!raw) {
    return { target: "", scanUid: null };
  }

  if (ABSOLUTE_VFS_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
    return { target: raw, scanUid: userFilesFromAbs(raw) };
  }

  const userFiles = raw.match(/^\/?([^/]+)\/files(\/.*)?$/u);
  if (
    userFiles &&
    !["www", "persist", "tmp", "internal", "data"].includes(userFiles[1])
  ) {
    const rest = userFiles[2] || "";
    return {
      target: `${NEXTCLOUD_DATA_DIR}/${userFiles[1]}/files${rest}`,
      scanUid: userFiles[1],
    };
  }

  const target = raw.startsWith("/") ? raw : `${NEXTCLOUD_ROOT}/${raw}`;
  return { target, scanUid: userFilesFromAbs(target) };
}

/** Pull a JSON object out of PHP stdout that may include occ/WASM noise. */
export function parseJsonFromPhpOutput(out) {
  const text = String(out || "");
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
