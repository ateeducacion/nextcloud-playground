// Service Worker availability detection.
//
// The playground cannot run without a Service Worker: every runtime request is
// served by it. `navigator.serviceWorker` is nonetheless absent in perfectly
// ordinary situations — iOS Safari private browsing, non-secure origins, and
// browsers with Service Workers disabled by policy — where touching
// `navigator.serviceWorker.register` throws a TypeError and leaves the user
// with a blank page. Detect the condition up front so callers can report it.

export const SERVICE_WORKER_UNSUPPORTED_ERROR_NAME =
  "ServiceWorkerUnsupportedError";

export const SERVICE_WORKER_UNSUPPORTED_MESSAGE =
  "Service Workers are unavailable in this browser context. Private browsing " +
  "on iOS Safari disables them, and the playground cannot run without one.";

/**
 * True when this context exposes a usable Service Worker registration API.
 */
export function isServiceWorkerSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.register === "function"
  );
}

/**
 * Build the error thrown at every registration site when Service Workers are
 * unavailable. `name` makes it distinguishable from a genuine registration
 * failure, which is a real regression and must be reported differently.
 */
export function createServiceWorkerUnsupportedError() {
  const error = new Error(SERVICE_WORKER_UNSUPPORTED_MESSAGE);
  error.name = SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
  return error;
}

/**
 * True when `error` is the "no Service Worker in this browser" marker — an
 * environment limitation to report as a warning, not an exception.
 */
export function isServiceWorkerUnsupportedError(error) {
  return error?.name === SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
}

// Firefox before 147 (ESR 128/140 included) cannot run module Service Workers:
// sw.js's `import` lines made registration fail with "threw an exception during
// script evaluation". The build bundles sw.js into this classic script at the
// site root (a Service Worker's maximum scope is its own directory).
export const SERVICE_WORKER_SCRIPT = "sw.bundle.js";

/** Register the runtime Service Worker as a classic script for scope "./". */
export async function registerClassicServiceWorker(
  swUrl,
  navigatorLike = globalThis.navigator,
) {
  if (typeof navigatorLike?.serviceWorker?.register !== "function") {
    throw createServiceWorkerUnsupportedError();
  }

  const registration = await navigatorLike.serviceWorker.register(swUrl, {
    scope: "./",
    updateViaCache: "none",
  });
  try {
    await registration?.update();
  } catch {
    // Offline or a transient fetch error: the installed worker keeps serving.
  }
  return registration;
}
