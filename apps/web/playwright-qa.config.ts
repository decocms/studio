import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig, devices } from "@playwright/experimental-ct-react";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const here = fileURLToPath(new URL(".", import.meta.url));

/** QA-only config (local): mounts real settings components, ct/qa tests. */
export default defineConfig({
  testDir: "./ct/qa",
  testMatch: "**/*.qa.tsx",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ctPort: 3131,
    ctTemplateDir: "./ct/playwright",
    launchOptions: { executablePath: "/usr/bin/chromium" },
    ctViteConfig: {
      plugins: [react(), tailwindcss(), tsconfigPaths({ root: "." })],
      resolve: {
        alias: [{ find: "@/", replacement: `${path.join(here, "src")}/` }],
      },
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
