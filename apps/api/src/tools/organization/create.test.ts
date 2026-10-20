import { describe, expect, it } from "bun:test";
import { ORGANIZATION_CREATE } from "./create";

describe("ORGANIZATION_CREATE", () => {
  it("rejects a description over 500 characters", () => {
    const result = ORGANIZATION_CREATE.inputSchema.safeParse({
      slug: "acme",
      name: "Acme",
      description: "x".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("accepts a description at the 500 character limit", () => {
    const result = ORGANIZATION_CREATE.inputSchema.safeParse({
      slug: "acme",
      name: "Acme",
      description: "x".repeat(500),
    });

    expect(result.success).toBe(true);
  });
});
