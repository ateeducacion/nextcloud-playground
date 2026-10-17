import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createServiceWorkerUnsupportedError,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
  registerClassicServiceWorker,
  SERVICE_WORKER_SCRIPT,
  SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
  SERVICE_WORKER_UNSUPPORTED_MESSAGE,
} from "../src/shared/service-worker-support.js";

function withNavigator(navigatorLike, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: navigatorLike,
    configurable: true,
    writable: true,
  });

  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "navigator", original);
    } else {
      delete globalThis.navigator;
    }
  }
}

describe("isServiceWorkerSupported", () => {
  it("is true when navigator exposes a register() function", () => {
    withNavigator({ serviceWorker: { register: () => {} } }, () => {
      assert.equal(isServiceWorkerSupported(), true);
    });
  });

  it("is false when navigator has no serviceWorker (iOS Safari private mode)", () => {
    withNavigator({}, () => {
      assert.equal(isServiceWorkerSupported(), false);
    });
  });

  it("is false when serviceWorker is present but undefined", () => {
    withNavigator({ serviceWorker: undefined }, () => {
      assert.equal(isServiceWorkerSupported(), false);
    });
  });

  it("is false when register is not callable", () => {
    withNavigator({ serviceWorker: { register: null } }, () => {
      assert.equal(isServiceWorkerSupported(), false);
    });
  });

  it("is false when there is no navigator at all (worker/node context)", () => {
    withNavigator(undefined, () => {
      assert.equal(isServiceWorkerSupported(), false);
    });
  });

  it("does not touch navigator.serviceWorker properties when unsupported", () => {
    let touched = false;
    const navigatorLike = {
      get serviceWorker() {
        touched = true;
        return undefined;
      },
    };
    withNavigator(navigatorLike, () => {
      assert.equal(isServiceWorkerSupported(), false);
    });
    // The getter runs (that is how the check works), but reading `register` off
    // undefined must not throw — that TypeError is the original crash.
    assert.equal(touched, true);
  });
});

describe("createServiceWorkerUnsupportedError", () => {
  it("carries a stable name so callers can distinguish it", () => {
    const error = createServiceWorkerUnsupportedError();
    assert.ok(error instanceof Error);
    assert.equal(error.name, SERVICE_WORKER_UNSUPPORTED_ERROR_NAME);
    assert.equal(error.name, "ServiceWorkerUnsupportedError");
  });

  it("explains the iOS Safari private browsing case to the user", () => {
    const error = createServiceWorkerUnsupportedError();
    assert.equal(error.message, SERVICE_WORKER_UNSUPPORTED_MESSAGE);
    assert.match(error.message, /Service Workers are unavailable/);
    assert.match(error.message, /Private browsing on iOS Safari/);
  });
});

describe("isServiceWorkerUnsupportedError", () => {
  it("recognizes the marker error", () => {
    assert.equal(
      isServiceWorkerUnsupportedError(createServiceWorkerUnsupportedError()),
      true,
    );
  });

  it("rejects a genuine registration failure", () => {
    assert.equal(isServiceWorkerUnsupportedError(new Error("Rejected")), false);
    assert.equal(isServiceWorkerUnsupportedError(new TypeError("nope")), false);
  });

  it("tolerates null / undefined / non-errors", () => {
    assert.equal(isServiceWorkerUnsupportedError(null), false);
    assert.equal(isServiceWorkerUnsupportedError(undefined), false);
    assert.equal(isServiceWorkerUnsupportedError("Rejected"), false);
  });
});

describe("registerClassicServiceWorker", () => {
  const swUrl = new URL(`https://example.test/${SERVICE_WORKER_SCRIPT}`);

  function fakeNavigator(registration) {
    const calls = [];
    return {
      calls,
      serviceWorker: {
        register(url, options) {
          calls.push({ url, options });
          return Promise.resolve(registration);
        },
      },
    };
  }

  // Sentry 144877069: Firefox < 147 (ESR 128/140) cannot run module Service
  // Workers, so sw.js "threw an exception during script evaluation".
  it("registers the classic sw.bundle.js, not a module worker", async () => {
    const nav = fakeNavigator({ update: async () => {} });
    await registerClassicServiceWorker(swUrl, nav);
    assert.equal(SERVICE_WORKER_SCRIPT, "sw.bundle.js");
    assert.equal(nav.calls.length, 1);
    assert.notEqual(nav.calls[0].options.type, "module");
    assert.equal(nav.calls[0].options.scope, "./");
  });

  // Sentry 145244135: update() failing (offline) or a registration without
  // update() must not abort the boot; the installed worker keeps serving.
  it("tolerates a failing update() and a missing registration", async () => {
    const failing = fakeNavigator({
      update: () => Promise.reject(new TypeError("Failed to update")),
    });
    await registerClassicServiceWorker(swUrl, failing);
    await registerClassicServiceWorker(swUrl, fakeNavigator(undefined));
  });

  it("throws the unsupported error without the API", async () => {
    await assert.rejects(registerClassicServiceWorker(swUrl, {}), (error) =>
      isServiceWorkerUnsupportedError(error),
    );
  });
});
