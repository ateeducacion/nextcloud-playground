import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScopeKey,
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../src/shared/storage.js";

function createSessionStorage(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  const storage = Object.create(null);

  Object.defineProperties(storage, {
    getItem: {
      value(key) {
        return store.has(key) ? store.get(key) : null;
      },
    },
    setItem: {
      value(key, value) {
        const stringValue = String(value);
        store.set(key, stringValue);
        storage[key] = stringValue;
      },
    },
    removeItem: {
      value(key) {
        store.delete(key);
        delete storage[key];
      },
    },
  });

  for (const [key, value] of store.entries()) {
    storage[key] = value;
  }

  return storage;
}

function withGlobals(globals, fn) {
  const originals = new Map();

  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }

  try {
    return fn();
  } finally {
    for (const [name, descriptor] of originals.entries()) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }
}

describe("shared storage helpers", () => {
  it("builds stable scope keys", () => {
    assert.equal(
      buildScopeKey("scope-123", "state"),
      "nextcloud-playground:scope-123:state",
    );
  });

  it("saves and loads session state", () => {
    const sessionStorage = createSessionStorage();

    withGlobals(
      {
        window: {
          location: { href: "https://example.com/?scope=scope-123" },
          sessionStorage,
        },
      },
      () => {
        saveSessionState("scope-123", { foo: "bar" });
        assert.deepEqual(loadSessionState("scope-123"), { foo: "bar" });
      },
    );
  });

  it("reuses the scope from the query string when present", () => {
    const sessionStorage = createSessionStorage();

    withGlobals(
      {
        window: {
          location: { href: "https://example.com/?scope=from-url" },
          sessionStorage,
        },
        crypto: {
          randomUUID() {
            throw new Error("randomUUID should not be called");
          },
        },
      },
      () => {
        assert.equal(getOrCreateScopeId(), "from-url");
        assert.equal(sessionStorage["nextcloud-playground:active"], "from-url");
      },
    );
  });

  it("generates and persists an active scope when none is present", () => {
    const sessionStorage = createSessionStorage();

    withGlobals(
      {
        window: {
          location: { href: "https://example.com/" },
          sessionStorage,
        },
        crypto: {
          randomUUID() {
            return "generated-scope";
          },
        },
      },
      () => {
        assert.equal(getOrCreateScopeId(), "generated-scope");
        assert.equal(
          sessionStorage["nextcloud-playground:active"],
          "generated-scope",
        );
      },
    );
  });

  it("clears only the keys that belong to a scope", () => {
    const sessionStorage = createSessionStorage({
      "nextcloud-playground:scope-123:state": '{"foo":"bar"}',
      "nextcloud-playground:scope-123:other": "keep?",
      "nextcloud-playground:scope-999:state": '{"baz":"qux"}',
    });

    withGlobals(
      {
        window: {
          location: { href: "https://example.com/" },
          sessionStorage,
        },
      },
      () => {
        clearScopeSession("scope-123");
        assert.equal(
          sessionStorage["nextcloud-playground:scope-123:state"],
          undefined,
        );
        assert.equal(
          sessionStorage["nextcloud-playground:scope-123:other"],
          undefined,
        );
        assert.equal(
          sessionStorage["nextcloud-playground:scope-999:state"],
          '{"baz":"qux"}',
        );
      },
    );
  });
});
