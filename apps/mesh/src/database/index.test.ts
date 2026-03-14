import { describe, expect, it } from "bun:test";
import { createDatabase } from "./index";

describe("Database Factory", () => {
  describe("createDatabase", () => {
    it("should create PostgreSQL database from postgresql:// URL", () => {
      const database = createDatabase(
        "postgresql://user:pass@localhost:5432/db",
      );
      expect(database).toBeDefined();
      expect(database.type).toBe("postgres");
      expect(database.db).toBeDefined();
      expect(database.pool).toBeDefined();
    });

    it("should create PostgreSQL database from postgres:// URL", () => {
      const database = createDatabase("postgres://user:pass@localhost:5432/db");
      expect(database.type).toBe("postgres");
    });

    it("should use default DATABASE_URL when no URL provided", () => {
      const database = createDatabase();
      expect(database).toBeDefined();
      expect(database.type).toBe("postgres");
    });
  });
});
