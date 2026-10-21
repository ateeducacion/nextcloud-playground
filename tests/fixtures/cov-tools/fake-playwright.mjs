// @playwright/test stand-in. COV_PW = { frameAfter: n | null } — the Nextcloud
// Files frame appears after n waitForTimeout calls (never when null).
import { record, scenario } from "./log.mjs";

const { frameAfter = 0 } = scenario("COV_PW");

export const chromium = {
  async launch() {
    record({ pw: "launch" });
    let waits = 0;
    const frame = (url) => ({
      url: () => url,
      async waitForSelector(selector, options) {
        record({ pw: "waitForSelector", selector, timeout: options.timeout });
      },
    });
    const page = {
      setDefaultTimeout: (ms) => record({ pw: "setDefaultTimeout", ms }),
      async goto(url, options) {
        record({ pw: "goto", url, waitUntil: options.waitUntil });
      },
      async waitForFunction(fn, _arg, options) {
        globalThis.document = {
          querySelector: (sel) =>
            sel === "#site-frame" ? { src: "/remote.html?scope=abc" } : null,
        };
        record({
          pw: "waitForFunction",
          result: fn(),
          timeout: options.timeout,
        });
      },
      frames() {
        const frames = [frame("http://x/remote.html")];
        if (frameAfter !== null && waits >= frameAfter) {
          frames.push(
            frame("http://x/playground/abc/php83/index.php/apps/files/"),
          );
        }
        return frames;
      },
      async waitForTimeout(ms) {
        waits += 1;
        record({ pw: "waitForTimeout", ms });
      },
      async screenshot(options) {
        record({ pw: "screenshot", path: options.path });
      },
    };
    return {
      async newPage(options) {
        record({ pw: "newPage", options });
        return page;
      },
      async close() {
        record({ pw: "close" });
      },
    };
  },
};
