import { describe, expect, it } from "bun:test";
import { getCliState, setDevMode, updateService } from "./cli-store";

describe("cli-store dev mode services", () => {
  it("tracks both Vite and API service ports for the TUI", () => {
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
});
