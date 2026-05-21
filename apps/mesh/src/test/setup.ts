// Test runtime setup for React component tests. Importing this module
// registers happy-dom globals + jest-dom matchers. Each component test
// MUST also call `setupComponentTest()` at module top-level to enable
// the cross-test DOM cleanup (bun:test doesn't run RTL's cleanup the
// way Jest does, so this is the explicit hook).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

if (!GlobalRegistrator.isRegistered) {
  // Pass a URL so modules reading window.location at import time
  // (e.g. better-auth/react) don't blow up on `about:blank`.
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
}
expect.extend(matchers as Parameters<typeof expect.extend>[0]);

/**
 * Call at module top-level in every React component test file to
 * register the after-each DOM cleanup in that file's scope. The
 * registration must happen synchronously from the test file (not via
 * the side-effect import) because bun:test's hooks are scoped to the
 * importing file, not the importee.
 */
export function setupComponentTest() {
  afterEach(() => {
    cleanup();
    if (typeof document !== "undefined") {
      document.body.innerHTML = "";
    }
  });
}
