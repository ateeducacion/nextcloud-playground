export const SHELL_CHANNEL_PREFIX = "nextcloud-playground-shell";
export const PHP_BRIDGE_CHANNEL_PREFIX = "nextcloud-playground-php";
export const SNAPSHOT_VERSION = 1;

export function createShellChannel(scopeId, instanceId) {
  return `${SHELL_CHANNEL_PREFIX}:${scopeId}${instanceId ? `:${instanceId}` : ""}`;
}

export function createPhpBridgeChannel(scopeId) {
  return `${PHP_BRIDGE_CHANNEL_PREFIX}:${scopeId}`;
}

export function createWorkerRequestId() {
  return globalThis.crypto.randomUUID();
}

/**
 * Format an error into a human-readable string for display/logging.
 */
export function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    // Chromium's stack starts with "Name: message"; Firefox and Safari list
    // only the frames, so the message would be lost.
    const head = `${error.name}: ${error.message}`;
    if (!error.stack || error.stack.startsWith(head)) {
      return String(error.stack || head);
    }
    return `${head}\n${error.stack}`.trim();
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Wrap an error in a minimal HTML page, escaping it so the text never
 * becomes markup.
 */
export function formatErrorHtml(error) {
  return `<!doctype html><meta charset="utf-8"><pre>${escapeHtml(formatErrorDetail(error))}</pre>`;
}

/**
 * Escape text for an HTML element body.
 */
export function escapeHtml(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
