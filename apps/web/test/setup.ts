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
  // Snapshot Bun's native stream classes before registration. happy-dom
  // overwrites globalThis.TransformStream / WritableStream with its own
  // implementations, but leaves ReadableStream alone — that mismatch
  // breaks ai-sdk's `stream.pipeThrough(new TransformStream(...))` with
  // a "readable should be ReadableStream" TypeError when component tests
  // and store/stream tests run in the same `bun test` invocation. Pin
  // the native classes back so ai-sdk (and any other native-stream
  // consumer) sees a consistent runtime.
  const NativeReadableStream = globalThis.ReadableStream;
  const NativeWritableStream = globalThis.WritableStream;
  const NativeTransformStream = globalThis.TransformStream;
  // Pass a URL so modules reading window.location at import time
  // (e.g. better-auth/react) don't blow up on `about:blank`.
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
  globalThis.ReadableStream = NativeReadableStream;
  globalThis.WritableStream = NativeWritableStream;
  globalThis.TransformStream = NativeTransformStream;
}
expect.extend(matchers as Parameters<typeof expect.extend>[0]);

// Augment bun:test's `expect()` Matchers with the jest-dom matchers we
// just extended at runtime. The published `@testing-library/jest-dom`
// type augmentations target jest/vitest globals, not bun:test, so
// without this declaration TypeScript reports e.g.
// `Property 'toBeInTheDocument' does not exist on type 'Matchers<HTMLElement>'`.
declare module "bun:test" {
  interface Matchers<T> extends matchers.TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchers
    extends matchers.TestingLibraryMatchers<unknown, void> {}
}

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
