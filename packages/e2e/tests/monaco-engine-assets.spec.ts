/**
 * E2E: the code editor engine is served by this app, from its own origin.
 *
 * Regression this spec exists for: the engine was loaded from a CDN, which the
 * desktop shell's `script-src 'self'` refuses, so every code surface rendered a
 * permanent spinner over file content that had already arrived. Nothing failed
 * anywhere else — the browser build worked, so unit tests, types and lint were
 * all green while the packaged app was unusable.
 *
 * What this asserts is the half a browser can see: the engine files ship with
 * the app and answer on a same-origin path, in whichever mode the suite runs
 * (dev server locally, built `dist` under `preview` in CI). The desktop CSP
 * half lives in the native boot smoke's `monacoEngineBoots` check, and "no
 * component bypasses the shared loader" in `monaco-imports.test.ts`.
 *
 * The engine path is inlined rather than imported — this suite owns its
 * contract (see ban-e2e-app-imports). A version bump changes it on purpose.
 */

import type { APIRequestContext } from "@playwright/test";
import { expect, newApiContext, test } from "../fixtures/test";

const MONACO_VS_PATH = "/monaco/0.52.0/vs";

/** Entry points the loader and its workers fetch by absolute path. */
const REQUIRED_FILES = [
  { path: "loader.js", type: /javascript/ },
  { path: "editor/editor.main.js", type: /javascript/ },
  { path: "editor/editor.main.css", type: /css/ },
  { path: "base/worker/workerMain.js", type: /javascript/ },
  { path: "language/typescript/tsWorker.js", type: /javascript/ },
];

test.describe("monaco engine assets", () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    api = await newApiContext(playwright);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  for (const file of REQUIRED_FILES) {
    test(`serves ${file.path}`, async () => {
      const response = await api.get(`${MONACO_VS_PATH}/${file.path}`);

      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(file.type);
      expect((await response.body()).byteLength).toBeGreaterThan(1000);
    });
  }

  test("answers a missing engine file with 404, never index.html", async () => {
    const response = await api.get(`${MONACO_VS_PATH}/nope.js`);

    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"] ?? "").not.toMatch(/html/);
  });
});
