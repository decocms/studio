import { describe, expect, test } from "bun:test";
import { resolvePlaywrightDevServerConfig } from "./playwright.config";

describe("resolvePlaywrightDevServerConfig", () => {
  test("uses the Vite origin as the public dev BASE_URL by default", () => {
    const config = resolvePlaywrightDevServerConfig({});

    expect(config.appOrigin).toBe("http://localhost:4000");
    expect(config.webServerCommand).toBe(
      "BASE_URL=http://localhost:4000 PORT=3000 VITE_PORT=4000 bun run dev:servers",
    );
  });

  test("keeps explicit ports and BASE_URL in sync with the app origin", () => {
    const config = resolvePlaywrightDevServerConfig({
      BASE_URL: "http://preview.localhost:4444",
      PORT: "3100",
      VITE_PORT: "4444",
    });

    expect(config.appOrigin).toBe("http://preview.localhost:4444");
    expect(config.webServerCommand).toBe(
      "BASE_URL=http://preview.localhost:4444 PORT=3100 VITE_PORT=4444 bun run dev:servers",
    );
  });
});
