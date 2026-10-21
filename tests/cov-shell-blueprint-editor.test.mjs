import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeBlueprintParam } from "../src/shared/blueprint.js";
import {
  CODEJAR_URL,
  installDom,
  makeLocation,
  tick,
  until,
} from "./fixtures/shell/dom.mjs";

const EDITOR_HTML = `
  <div id="mount" class="is-hidden"></div>
  <textarea id="textarea"></textarea>
  <p id="status"></p>
  <button id="run" disabled></button>
  <button id="copy" title="Copy blueprint JSON" aria-label="Copy"><svg></svg></button>`;

installDom({ html: EDITOR_HTML });
const { initBlueprintEditor } = await import(
  "../src/shell/blueprint-editor.js"
);

function fakeCodeJar() {
  const jars = [];
  globalThis.__codeJarFactory = (mount, highlight, options) => {
    const jar = {
      mount,
      highlight,
      options,
      code: "",
      updateCode(text) {
        jar.code = text;
        mount.textContent = text;
      },
      toString: () => jar.code,
      onUpdate(callback) {
        jar.listener = callback;
      },
      type(text) {
        jar.code = text;
        jar.listener(text);
      },
    };
    jars.push(jar);
    return jar;
  };
  return jars;
}

function elements(withMount = true) {
  document.body.innerHTML = EDITOR_HTML;
  return {
    mount: withMount ? document.querySelector("#mount") : null,
    textarea: document.querySelector("#textarea"),
    statusEl: document.querySelector("#status"),
    runButton: document.querySelector("#run"),
    copyButton: document.querySelector("#copy"),
  };
}

const VALID = JSON.stringify({ landingPage: "/apps/files", steps: [] });

describe("initBlueprintEditor without CodeJar", () => {
  it("validates the fallback textarea as the user types", () => {
    globalThis.__codeJarFactory = undefined;
    const els = elements(false);
    els.textarea.value = "";
    const editor = initBlueprintEditor(els);

    assert.equal(els.textarea.readOnly, false);
    assert.equal(els.statusEl.textContent, "Blueprint cannot be empty.");
    assert.ok(els.statusEl.classList.contains("is-invalid"));
    assert.equal(els.runButton.disabled, true);

    els.textarea.value = VALID;
    els.textarea.dispatchEvent(new window.document.defaultView.Event("input"));
    assert.equal(editor.getCode(), VALID);
    assert.ok(els.statusEl.classList.contains("is-valid"));
    assert.match(els.statusEl.textContent, /Valid blueprint · 0 steps/u);
    assert.equal(els.runButton.disabled, false);

    editor.setLocked(true);
    assert.equal(els.runButton.disabled, true);
    editor.setLocked(false);
    assert.equal(els.runButton.disabled, false);
  });

  it("rejects JSON that is not an object and reports the schema stage", () => {
    const els = elements(false);
    const editor = initBlueprintEditor(els);
    editor.setCode("[1, 2]");
    const result = editor.getValidationResult();
    assert.equal(result.valid, false);
    assert.equal(result.stage, "schema");
    assert.match(els.statusEl.textContent, /must be a JSON object/u);
    editor.setCode(null);
    assert.equal(els.textarea.value, "");
    assert.equal(
      editor.getValidationResult().message,
      "Blueprint cannot be empty.",
    );
  });

  it("normalizes against the live config", () => {
    const els = elements(false);
    let config;
    const editor = initBlueprintEditor(els, { getConfig: () => config });
    editor.setCode("{}");
    assert.equal(
      editor.getValidationResult().blueprint.landingPage,
      "/index.php/login",
    );
    config = { landingPath: "/apps/dashboard" };
    editor.setCode("{}");
    assert.equal(
      editor.getValidationResult().blueprint.landingPage,
      "/apps/dashboard",
    );
  });

  it("works without optional status, run and copy elements", () => {
    const { textarea } = elements(false);
    const editor = initBlueprintEditor({ mount: null, textarea });
    editor.setCode(VALID);
    editor.setLocked(true);
    assert.equal(editor.getValidationResult().valid, true);
    const bare = initBlueprintEditor({ mount: null, textarea: null });
    bare.setCode(VALID);
    assert.equal(bare.getCode(), VALID);
  });

  it("keeps the textarea editable when the CodeJar module fails", async () => {
    globalThis.__codeJarFactory = undefined;
    const els = elements(true);
    const editor = initBlueprintEditor(els);
    // Let the editor's own import of the stub settle before asserting.
    await import(CODEJAR_URL);
    await tick();
    await tick();
    assert.ok(els.mount.classList.contains("is-hidden"));
    assert.ok(!els.textarea.classList.contains("is-hidden"));
    editor.setCode(VALID);
    assert.equal(editor.getCode(), VALID);
  });
});

describe("initBlueprintEditor with CodeJar", () => {
  it("hands editing to CodeJar and keeps the textarea in sync", async () => {
    const jars = fakeCodeJar();
    const els = elements(true);
    els.textarea.value = VALID;
    els.textarea.focus();
    const focused = [];
    els.mount.focus = () => focused.push("mount");
    const editor = initBlueprintEditor(els);
    const jar = await until(
      () => jars.find((candidate) => candidate.mount === els.mount),
      "CodeJar",
    );
    await until(() => !els.mount.classList.contains("is-hidden"), "mount");

    assert.deepEqual(jar.options, { tab: "  " });
    assert.ok(els.textarea.classList.contains("is-hidden"));
    assert.deepEqual(focused, ["mount"], "focus moves to the CodeJar mount");
    // highlightForCodeJar turns the JSON into highlighted markup.
    assert.match(els.mount.innerHTML, /<span/u);
    jar.highlight(els.mount);

    jar.type('{"steps":[{"step":"enableApp","app":"calendar"}]}');
    assert.equal(els.textarea.value, jar.code);
    assert.match(els.statusEl.textContent, /1 step$/u);

    // Textarea input is ignored once CodeJar owns editing.
    els.textarea.value = "not json";
    els.textarea.dispatchEvent(
      new els.textarea.ownerDocument.defaultView.Event("input"),
    );
    assert.equal(editor.getValidationResult().valid, true);

    editor.setCode(VALID);
    assert.equal(jar.code, VALID);
    assert.equal(editor.getCode(), VALID);
  });

  it("does not steal focus when the textarea was not focused", async () => {
    const jars = fakeCodeJar();
    const els = elements(true);
    els.textarea.blur();
    let focused = false;
    els.mount.focus = () => {
      focused = true;
    };
    initBlueprintEditor({ ...els, textarea: null });
    await until(
      () => jars.find((candidate) => candidate.mount === els.mount),
      "CodeJar",
    );
    await until(() => !els.mount.classList.contains("is-hidden"), "mount");
    assert.equal(focused, false);
  });
});

describe("Run and Copy buttons", () => {
  it("encodes the blueprint into the URL on Run", async () => {
    globalThis.__codeJarFactory = undefined;
    const els = elements(false);
    const location = makeLocation(
      "http://localhost:8080/?blueprint-url=x&blueprint-data=y&debug=1",
    );
    els.textarea.value = VALID;
    initBlueprintEditor(els, { location });
    els.runButton.click();
    assert.equal(els.runButton.disabled, true);
    assert.ok(els.statusEl.classList.contains("is-running"));
    assert.match(els.statusEl.textContent, /restarting playground/u);
    await until(() => location.navigations[0], "navigation");
    const url = new URL(location.navigations[0]);
    assert.equal(url.searchParams.get("debug"), "1");
    assert.equal(url.searchParams.has("blueprint-url"), false);
    assert.equal(url.searchParams.has("blueprint-data"), false);
    const decoded = await decodeBlueprintParam(
      url.searchParams.get("blueprint"),
    );
    assert.equal(decoded.landingPage, "/apps/files");
  });

  it("does nothing on Run while the blueprint is invalid", async () => {
    const els = elements(false);
    const location = makeLocation("http://localhost:8080/");
    initBlueprintEditor(els, { location }).setCode("{");
    els.runButton.disabled = false;
    els.runButton.click();
    await tick();
    assert.deepEqual(location.navigations, []);
    assert.match(els.statusEl.textContent, /Invalid JSON/u);
  });

  it("runs without a status element", async () => {
    const els = elements(false);
    const location = makeLocation("http://localhost:8080/");
    els.textarea.value = VALID;
    initBlueprintEditor({ ...els, statusEl: null }, { location });
    els.runButton.click();
    await until(() => location.navigations[0], "navigation");
  });

  it("copies the code and flashes a checkmark, then restores the button", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const els = elements(false);
    els.textarea.value = VALID;
    const original = els.copyButton.innerHTML;
    initBlueprintEditor(els);
    els.copyButton.click();
    await until(() => navigator.clipboard.writes.length, "clipboard");
    await tick();
    assert.equal(navigator.clipboard.writes.pop(), VALID);
    assert.equal(els.copyButton.getAttribute("title"), "Copied!");
    assert.equal(els.copyButton.getAttribute("aria-label"), "Copied!");
    assert.match(els.copyButton.innerHTML, /M3 8.5/u);
    t.mock.timers.tick(1200);
    assert.equal(els.copyButton.innerHTML, original);
    assert.equal(els.copyButton.getAttribute("title"), "Copy blueprint JSON");
    assert.equal(els.copyButton.getAttribute("aria-label"), "Copy");
  });

  it("leaves the copy button alone when the clipboard rejects", async () => {
    const els = elements(false);
    els.copyButton.removeAttribute("title");
    els.copyButton.removeAttribute("aria-label");
    navigator.clipboard.fail = true;
    initBlueprintEditor(els);
    els.copyButton.click();
    await tick();
    await tick();
    navigator.clipboard.fail = false;
    assert.equal(els.copyButton.getAttribute("title"), null);
    assert.equal(els.copyButton.innerHTML, "<svg></svg>");
  });
});
