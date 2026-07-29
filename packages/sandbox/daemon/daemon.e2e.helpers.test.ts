import { describe, expect, it } from "bun:test";

import { buildDaemonEnv } from "./daemon.e2e.helpers";

describe("daemon e2e helper environment", () => {
  it("forces replacement binaries onto headless token storage", () => {
    const env = buildDaemonEnv(
      "/tmp/daemon-e2e",
      43120,
      { LOCAL_API_TOKEN_STORE: "keychain" },
      { LOCAL_API_TOKEN_STORE: "keychain" },
    );

    expect(env.LOCAL_API_TOKEN_STORE).toBe("memory");
  });
});
