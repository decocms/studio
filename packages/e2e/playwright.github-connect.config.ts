import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// This key belongs to no registered app. These tests stop at redirects and
// never exchange codes or mint installation tokens with GitHub.
const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/github-connect.spec.ts",
  outputDir: "./test-results/github-connect",
  webServer: servers.map((server) => ({
    ...server,
    // Reusing a developer's server could exercise a different App configuration.
    reuseExistingServer:
      server.cwd === "../../apps/api" || server.cwd === "../../apps/web"
        ? false
        : server.reuseExistingServer,
    env: {
      ...server.env,
      ...(server.cwd === "../../apps/api"
        ? {
            GITHUB_APP_ID: "1",
            GITHUB_APP_SLUG: "studio-e2e",
            GITHUB_APP_CLIENT_ID: "Iv1.studio-e2e",
            GITHUB_APP_CLIENT_SECRET: "synthetic-e2e-secret",
            GITHUB_APP_PRIVATE_KEY: privateKey,
          }
        : {}),
    },
  })),
});
