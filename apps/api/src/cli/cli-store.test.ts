import { beforeEach, describe, expect, test } from "bun:test";
import {
  getCliState,
  resetCliStateForTests,
  setDevMode,
  updateService,
} from "./cli-store";

describe("cli-store dev mode services", () => {
  beforeEach(() => {
    resetCliStateForTests();
  });

  test("tracks both Vite and API service ports for the TUI", () => {
    setDevMode();

    updateService({ name: "Vite", status: "ready", port: 4000 });
    updateService({ name: "API", status: "ready", port: 3000 });

    expect(getCliState().services).toEqual(
      expect.arrayContaining([
        { name: "Vite", status: "ready", port: 4000 },
        { name: "API", status: "ready", port: 3000 },
      ]),
    );
  });

  test("tracks only the services dev actually spawns", () => {
    // Dev owns the infrastructure and app processes below; hosted sandboxes
    // are provisioned remotely and are not local TUI services.
    setDevMode();
    expect(getCliState().services.map((s) => s.name)).toEqual([
      "Postgres",
      "NATS",
      "API",
      "Vite",
    ]);
  });
});
