import { describe, expect, it } from "bun:test";
import { formatServiceLabel } from "./header";

describe("formatServiceLabel", () => {
  it("renders service ports with colon-separated labels", () => {
    expect(
      formatServiceLabel({ name: "Vite", status: "ready", port: 4000 }),
    ).toBe("Vite: 4000");
    expect(
      formatServiceLabel({ name: "API", status: "ready", port: 3000 }),
    ).toBe("API: 3000");
  });

  it("uses a placeholder before a service has a port", () => {
    expect(
      formatServiceLabel({ name: "API", status: "pending", port: 0 }),
    ).toBe("API: ....");
  });
});
