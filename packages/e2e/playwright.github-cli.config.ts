import { copyFileSync, mkdirSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const home = (process.env.GITHUB_CLI_E2E_HOME ??= mkdtempSync(
  join(tmpdir(), "studio-gh-cli-"),
));
const bin = join(home, "bin");
mkdirSync(bin, { recursive: true });
copyFileSync(
  fileURLToPath(new URL("./fixtures/github-cli.ts", import.meta.url)),
  join(bin, "gh"),
);
chmodSync(join(bin, "gh"), 0o755);
const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/github-cli.spec.ts",
  fullyParallel: false,
  workers: 1,
  outputDir: "./test-results/github-cli",
  webServer: servers.map((server) => ({
    ...server,
    reuseExistingServer: server.cwd ? false : server.reuseExistingServer,
    env: {
      ...server.env,
      ...(server.cwd === "../../apps/api"
        ? {
            DECOCMS_LOCAL_MODE: "true",
            DISABLE_RATE_LIMIT: "true",
            GH_CONFIG_DIR: home,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: "synthetic-ambient-token-must-not-be-used",
            GITHUB_APP_ID: "",
            GITHUB_APP_PRIVATE_KEY: "",
            GITHUB_APP_CLIENT_ID: "",
            GITHUB_APP_CLIENT_SECRET: "",
            GITHUB_APP_SLUG: "",
          }
        : {}),
    },
  })),
});
