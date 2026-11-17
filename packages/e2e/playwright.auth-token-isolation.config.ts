import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: "**/auth-token-isolation.spec.ts",
  outputDir: "./test-results/auth-token-isolation",
  webServer: servers.map((server) => ({
    ...server,
    reuseExistingServer:
      server.cwd === "../../apps/api" || server.cwd === "../../apps/web"
        ? false
        : server.reuseExistingServer,
    env: {
      ...server.env,
      ...(server.cwd === "../../apps/api"
        ? {
            AUTH_GITHUB_CLIENT_ID: "synthetic-token-isolation-client",
            AUTH_GITHUB_CLIENT_SECRET: "synthetic-token-isolation-secret",
            AUTH_MAGIC_LINK_ENABLED: "true",
            AUTH_MAGIC_LINK_EMAIL_PROVIDER: "resend",
            AUTH_RESEND_API_KEY: "synthetic-unused-email-key",
            AUTH_RESEND_FROM_EMAIL: "auth@example.test",
            DISABLE_RATE_LIMIT: "true",
          }
        : {}),
    },
  })),
});
