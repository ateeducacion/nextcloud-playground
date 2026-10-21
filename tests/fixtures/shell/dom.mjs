import { register } from "node:module";
import { Window } from "happy-dom";

// Shared DOM harness for tests/cov-shell-*.test.mjs. The shell modules read
// window/document/navigator at import time, so the globals are installed
// before each dynamic import.

export const CODEJAR_URL =
  "https://cdn.jsdelivr.net/npm/codejar@4.3.0/dist/codejar.js";

// blueprint-editor.js loads CodeJar from a CDN. Resolve that URL to a stub
// whose factory the test controls through globalThis.__codeJarFactory; when
// no factory is set the call throws, exercising the "CDN unavailable" path.
const hook = `
export async function resolve(specifier, context, next) {
  if (specifier === ${JSON.stringify(CODEJAR_URL)}) {
    return {
      url: "data:text/javascript,export const CodeJar = (...args) => globalThis.__codeJarFactory(...args);",
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function until(predicate, label) {
  for (let i = 0; i < 2000; i += 1) {
    const value = predicate();
    if (value) return value;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * Fake Location: assignments to href are recorded instead of navigating, the
 * way a page unload would leave the old document in place.
 */
export function makeLocation(href) {
  const loc = {
    navigations: [],
    reloads: 0,
    get href() {
      return href;
    },
    set href(value) {
      loc.navigations.push(String(value));
    },
    get origin() {
      return new URL(href).origin;
    },
    get pathname() {
      return new URL(href).pathname;
    },
    get search() {
      return new URL(href).search;
    },
    reload() {
      loc.reloads += 1;
    },
    setHref(value) {
      href = String(value);
    },
  };
  return loc;
}

/** Install a happy-dom document plus window/navigator stand-ins. */
export function installDom({
  html = "",
  href = "http://localhost:8080/",
} = {}) {
  const win = new Window({
    url: href,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  win.document.body.innerHTML = html;
  const location = makeLocation(href);
  const history = {
    state: null,
    replaced: [],
    replaceState(_state, _title, url) {
      history.replaced.push(String(url));
      location.setHref(String(url));
    },
  };
  const clipboard = { writes: [], fail: false };
  clipboard.writeText = async (text) => {
    if (clipboard.fail) throw new Error("denied");
    clipboard.writes.push(text);
  };
  const navigator = { clipboard };
  const window = {
    document: win.document,
    location,
    history,
    sessionStorage: win.sessionStorage,
    localStorage: win.localStorage,
  };
  defineGlobal("window", window);
  defineGlobal("document", win.document);
  defineGlobal("navigator", navigator);
  return { win, window, document: win.document, location, history, navigator };
}
