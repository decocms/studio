// Test runtime setup for React component tests. Importing this module
// for its side effects registers happy-dom globals (document, window,
// fetch, etc.) and the @testing-library/jest-dom custom matchers on
// bun:test's expect. Import this from any *.test.tsx file that renders
// React components. We deliberately do NOT wire this through a global
// bunfig preload so that workspace tests under packages/** keep running
// against Node natives.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

if (!GlobalRegistrator.isRegistered) {
  // Pass a concrete URL so modules that read window.location at import time
  // (e.g. better-auth/react createAuthClient, which derives its baseURL from
  // window.location.origin) don't blow up on the default `about:blank`.
  GlobalRegistrator.register({ url: "http://localhost:4000/" });
}
// Cast bridges @testing-library/jest-dom matchers into bun:test's expect.extend signature.
expect.extend(matchers as Parameters<typeof expect.extend>[0]);

// bun:test doesn't auto-call RTL's cleanup() the way Jest does, so DOM from one
// component test was leaking into later tests in the run, e.g. a popover
// trigger from agent-model-trigger.test persisting into agent-section.test and
// breaking getByText queries. Mirror Jest's implicit behavior by registering
// afterEach -> cleanup().
export const __studioTestCleanup = () => {
  cleanup();
  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
};

// The afterEach hook below registers in whichever test file imports this
// setup module first (bun:test caches the module across all files in a run).
// For every OTHER test file in the run, we use a Bun.plugin onLoad transform
// that prepends an afterEach registration to the test source so each file's
// own scope gets the hook. The two together cover every test file regardless
// of load order.
afterEach(__studioTestCleanup);

try {
  Bun.plugin({
    name: "studio-test-cleanup-injector",
    setup(build) {
      const SENTINEL = "/* __studio_test_cleanup_injected__ */";
      // Reference setup.ts by absolute path so injected files don't need to
      // resolve it relative to their own location.
      const setupPath = JSON.stringify(import.meta.path);
      build.onLoad({ filter: /\.test\.tsx?$/ }, async (args) => {
        const file = Bun.file(args.path);
        const original = await file.text();
        if (original.includes(SENTINEL)) {
          return { contents: original, loader: args.loader };
        }
        // Only transform test files that already opt into happy-dom by
        // importing this setup module; leaving Node-native tests untouched.
        if (!original.includes("test/setup")) {
          return { contents: original, loader: args.loader };
        }
        const prelude =
          `${SENTINEL}\n` +
          `import { afterEach as __studioAfterEach } from "bun:test";\n` +
          `import { __studioTestCleanup } from ${setupPath};\n` +
          `__studioAfterEach(__studioTestCleanup);\n`;
        return { contents: prelude + original, loader: args.loader };
      });
    },
  });
} catch {
  // Plugin registration failures fall back to the afterEach above. The
  // build.onLoad hook is best-effort: if Bun.plugin isn't available in the
  // current host, only the first test file in a run still gets cleanup, but
  // tests run in isolation pass either way.
}
