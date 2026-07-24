import { describe, expect, it } from "bun:test";

describe("getSettings auto-init database URL fallback", () => {
  it("falls back to the local default when DATABASE_URL is set but empty", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const { getSettings } = await import("./index");
      expect(getSettings().databaseUrl).toBe(
        "postgresql://postgres:postgres@localhost:5432/postgres",
      );
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});
