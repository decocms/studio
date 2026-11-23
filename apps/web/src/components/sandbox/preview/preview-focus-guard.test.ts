import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { guardFrameFocus } from "./preview-focus-guard";

beforeAll(() => {
  const happyDOM = (
    window as unknown as {
      happyDOM?: { settings: { disableIframePageLoading: boolean } };
    }
  ).happyDOM;
  if (happyDOM) happyDOM.settings.disableIframePageLoading = true;
});

let activation: { isActive: boolean } | undefined;
Object.defineProperty(window.navigator, "userActivation", {
  configurable: true,
  get: () => activation,
});

afterEach(() => {
  document.body.innerHTML = "";
  activation = undefined;
});

function setup() {
  const field = document.createElement("input");
  const other = document.createElement("input");
  const iframe = document.createElement("iframe");
  iframe.tabIndex = 0;
  document.body.append(field, other, iframe);
  field.focus();
  return { field, other, iframe };
}

/** What a script in the frame calling `focus()` does to Studio's document. */
function frameTakesFocus(iframe: HTMLIFrameElement) {
  iframe.focus();
  window.dispatchEvent(new Event("blur"));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("guardFrameFocus", () => {
  test("gives focus back to the field when the loaded page takes it", async () => {
    const { field, iframe } = setup();
    guardFrameFocus(iframe, 1000);
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(field);
  });

  test("gives it back to the field focused after the guard started", async () => {
    const { other, iframe } = setup();
    guardFrameFocus(iframe, 1000);
    other.focus();
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(other);
  });

  test("gives it back while the user is typing in Studio, even if activated", async () => {
    const { field, iframe } = setup();
    guardFrameFocus(iframe, 1000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    activation = { isActive: true };
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(field);
  });

  test("leaves focus in the page when the user clicked it (activation without Studio input)", async () => {
    const { iframe } = setup();
    guardFrameFocus(iframe, 1000);
    const now = performance.now();
    const realNow = performance.now.bind(performance);
    // Studio's last input is older than an activation lasts.
    performance.now = () => now + 10_000;
    try {
      activation = { isActive: true };
      frameTakesFocus(iframe);
      await wait(5);
      expect(document.activeElement).toBe(iframe);
    } finally {
      performance.now = realNow;
    }
  });

  test("leaves focus in the page when Tab moved it there", async () => {
    const { iframe } = setup();
    guardFrameFocus(iframe, 1000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(iframe);
  });

  test("does nothing when Studio had no focused element", async () => {
    const { field, iframe } = setup();
    field.blur();
    guardFrameFocus(iframe, 1000);
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(iframe);
  });

  test("does nothing when the focused field was removed", async () => {
    const { field, iframe } = setup();
    guardFrameFocus(iframe, 1000);
    field.remove();
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(iframe);
  });

  test("stops guarding once its time is up, and a new call extends it", async () => {
    const { field, iframe } = setup();
    guardFrameFocus(iframe, 30);
    await wait(15);
    guardFrameFocus(iframe, 60);
    await wait(30);
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(field);

    await wait(80);
    field.focus();
    frameTakesFocus(iframe);
    await wait(5);
    expect(document.activeElement).toBe(iframe);
  });
});
