// Test runtime setup for React component tests. Importing this module
// for its side effects registers happy-dom globals (document, window,
// fetch, etc.) and the @testing-library/jest-dom custom matchers on
// bun:test's expect. Import this from any *.test.tsx file that renders
// React components. We deliberately do NOT wire this through a global
// bunfig preload so that workspace tests under packages/** keep running
// against Node natives.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

if (!GlobalRegistrator.isRegistered) {
  // Pass a concrete URL so modules that read window.location at import time
  // (e.g. better-auth/react createAuthClient, which derives its baseURL from
  // window.location.origin) don't blow up on the default `about:blank`.
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
}
// Cast bridges @testing-library/jest-dom matchers into bun:test's expect.extend signature.
expect.extend(matchers as Parameters<typeof expect.extend>[0]);
