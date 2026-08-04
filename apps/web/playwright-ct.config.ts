import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig, devices } from "@playwright/experimental-ct-react";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const here = fileURLToPath(new URL(".", import.meta.url));
const stub = (rel: string) => path.join(here, "ct", "harness", "stubs", rel);

/**
 * Playwright Component Testing config for the sections-editor form widgets.
 *
 * These tests mount the real SchemaForm / field components in a browser with
 * synthetic JSON-Schema fixtures — no app server, no sandbox dev server. The
 * goal is a regression guard on widget rendering + edit behavior: given a CMS
 * JSON Schema, the right widget renders and editing it produces the right
 * serialized value.
 *
 * Test files are `*.ct.tsx` under ./ct/tests so they never collide with:
 *   - `bun test` (unit) — globs `*.test.ts` / `*.spec.ts` under src/ + packages/
 *   - `playwright test` (e2e) — the `@decocms/e2e` workspace (packages/e2e)
 */
export default defineConfig({
  testDir: "./ct/tests",
  testMatch: "**/*.ct.tsx",
  snapshotDir: "./ct/__snapshots__",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? "line" : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    ctPort: 3120,
    ctTemplateDir: "./ct/playwright",
    ctViteConfig: {
      plugins: [
        // No babel-plugin-react-compiler here: it's a build-time optimization,
        // not a correctness requirement. The components are valid React 19
        // without it, and dropping it keeps the CT bundle fast and avoids
        // pulling compiler edge cases into the test harness.
        react(),
        tailwindcss(),
        tsconfigPaths({ root: "." }),
      ],
      resolve: {
        // Sever the I/O boundary of ImageField/FileField. Both statically
        // import these modules (transitively pulling in @/sdk's
        // MCP client + @tanstack/react-router), and call useProjectContext()
        // at mount — which throws without the full app provider tree. The
        // stubs let us test the fields' own render/paste/remove logic
        // deterministically. The real S3 upload path stays an e2e concern.
        alias: [
          {
            find: /^@\/hooks\/use-file-configs$/,
            replacement: stub("use-file-configs.ts"),
          },
          {
            find: /^@\/hooks\/use-file-picker$/,
            replacement: stub("use-file-picker.ts"),
          },
          {
            find: /^@\/components\/file-picker\/file-picker-dialog$/,
            replacement: stub("file-picker-dialog.tsx"),
          },
          // FieldLabel (nearly every field widget) reads the
          // field_description_tooltips org flag via useOrgFlag, which also
          // calls useProjectContext() — same problem as above.
          {
            find: /^@\/hooks\/use-organization-settings$/,
            replacement: stub("use-organization-settings.ts"),
          },
          // General `@/* -> src/*` alias. MUST come after the stub aliases
          // above so Vite (first-match-wins) resolves those first. Matches
          // only `@/`-prefixed ids, so `@deco/ui`, `@tanstack/*` etc. are
          // untouched.
          { find: "@/", replacement: `${path.join(here, "src")}/` },
        ],
      },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
