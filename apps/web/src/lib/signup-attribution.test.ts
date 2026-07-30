import { beforeEach, describe, expect, test } from "bun:test";
import { captureSignupAttribution } from "./signup-attribution";

// Minimal in-memory cookie jar stubbing `document.cookie`, so this stays a
// pure unit test (no happy-dom cookie-attribute parsing needed).
function installCookieJar() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return Array.from(store, ([k, v]) => `${k}=${v}`).join("; ");
      },
      set cookie(pair: string) {
        const [name, value] = (pair.split(";")[0] ?? "").split("=");
        if (name) store.set(name, value ?? "");
      },
    },
  });
  return store;
}

describe("captureSignupAttribution", () => {
  beforeEach(() => {
    installCookieJar();
  });

  test("sets ref and src cookies when both present", () => {
    captureSignupAttribution({ ref: "wa8hcxfm", src: "wa" });
    expect(document.cookie).toContain(`studio_signup_ref=wa8hcxfm`);
    expect(document.cookie).toContain(`studio_signup_src=wa`);
  });

  test("no-ops when neither param is present", () => {
    captureSignupAttribution({});
    expect(document.cookie).toBe("");
  });

  test("first touch wins: does not overwrite an existing cookie", () => {
    captureSignupAttribution({ ref: "first" });
    captureSignupAttribution({ ref: "second" });
    expect(document.cookie).toContain("studio_signup_ref=first");
    expect(document.cookie).not.toContain("second");
  });
});
