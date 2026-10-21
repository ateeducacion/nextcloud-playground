// Stand-in for @playwright/test used by tests/cov-scripts-*.test.mjs (see
// playwright-preload.mjs). No browser is launched: every call is appended to
// the JSON-lines file in $FAKE_PW_LOG, and browser-side callbacks
// (waitForFunction/evaluate) run in Node against a fake DOM/performance.
import { appendFileSync } from "node:fs";

const record = (entry) => {
  if (process.env.FAKE_PW_LOG) {
    appendFileSync(process.env.FAKE_PW_LOG, `${JSON.stringify(entry)}\n`);
  }
};

const fakeDocument = {
  querySelector(selector) {
    if (selector === "#address-input") return { disabled: false };
    if (selector === "#site-frame") {
      return { getAttribute: () => "./remote.html?scope=abc" };
    }
    if (selector === "#runtime-id-value") return { textContent: " php83 " };
    return null;
  },
};

const fakeEntries = {
  navigation: [
    { domContentLoadedEventEnd: 10.4, domComplete: 20.6, loadEventEnd: 30.2 },
  ],
  paint: [{ name: "first-contentful-paint", startTime: 12.7 }],
  resource: [{ encodedBodySize: 100 }, { encodedBodySize: 0 }, {}],
};

function makePage() {
  // URL markers pick the scenario: "goto-fail" rejects navigation,
  // "no-login" never shows the login form.
  let target = "";
  return {
    async goto(href, options) {
      target = href;
      record({ call: "goto", href, options });
      if (href.includes("goto-fail")) throw new Error("net::ERR_FAILED");
      // Take measurable time: perf-compare treats a 0 ms boot as a failure.
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async waitForFunction(fn) {
      globalThis.document = fakeDocument;
      try {
        if (!fn()) throw new Error("predicate false");
      } finally {
        delete globalThis.document;
      }
    },
    frameLocator(selector) {
      record({ call: "frameLocator", selector });
      return {
        locator: () => ({
          first: () => ({
            async waitFor() {
              if (target.includes("no-login")) throw new Error("timeout");
            },
          }),
        }),
      };
    },
    async evaluate(fn) {
      const original = performance.getEntriesByType;
      performance.getEntriesByType = (type) => fakeEntries[type] || [];
      try {
        return fn();
      } finally {
        performance.getEntriesByType = original;
      }
    },
    locator: () => ({ inputValue: async () => "/index.php/login" }),
    async setContent(html) {
      record({ call: "setContent", html });
    },
    async screenshot(options) {
      record({ call: "screenshot", options });
    },
  };
}

export const chromium = {
  async launch(options) {
    record({ call: "launch", options });
    return {
      async newPage(options) {
        record({ call: "newPage", options });
        return makePage();
      },
      async close() {
        record({ call: "close" });
      },
    };
  },
  async launchPersistentContext(userDataDir, options) {
    record({ call: "launchPersistentContext", userDataDir, options });
    if (process.env.FAKE_PW_LAUNCH_FAIL) {
      throw new Error("browser launch failed");
    }
    return {
      newPage: async () => makePage(),
      async close() {
        record({ call: "contextClose" });
      },
    };
  },
};
