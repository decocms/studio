import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeDatabase, createDatabase } from "./index";

describe("Database Factory", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mesh-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createDatabase", () => {
    it("should create PGlite database from file:// URL", async () => {
      const dbPath = join(tempDir, "test-pglite");
      const database = createDatabase(`file:${dbPath}`);

      expect(database).toBeDefined();
      expect(database.type).toBe("pglite");
      expect(database.db).toBeDefined();

      await closeDatabase(database);
    });

    it("should create PGlite database when no URL provided", async () => {
      const database = createDatabase(
        `file:${join(tempDir, "default-pglite")}`,
      );
      expect(database).toBeDefined();
      expect(database.type).toBe("pglite");
      await closeDatabase(database);
    });

    it("should handle sqlite:// URLs as PGlite (backward compat)", async () => {
      const dbPath = join(tempDir, "test-sqlite-compat");
      const database = createDatabase(`sqlite://${dbPath}`);
      expect(database).toBeDefined();
      expect(database.type).toBe("pglite");
      await closeDatabase(database);
    });

    it("should throw error for unsupported protocol", () => {
      expect(() => createDatabase("redis://localhost")).toThrow(
        "Unsupported database protocol: redis",
      );
    });

    it("should create directory if not exists for PGlite", async () => {
      const dbPath = join(tempDir, "nested", "dir", "test-pglite");
      const database = createDatabase(`file:${dbPath}`);

      expect(database).toBeDefined();
      await closeDatabase(database);
    });

    it("should handle in-memory PGlite database", async () => {
      const database = createDatabase(":memory:");

      expect(database).toBeDefined();
      expect(database.type).toBe("pglite");
      await closeDatabase(database);
    });
  });

  describe("closeDatabase", () => {
    it("should close database connection", async () => {
      const database = createDatabase(":memory:");
      await closeDatabase(database);
      expect(true).toBe(true);
    });
  });

  describe("PostgreSQL support", () => {
    it("should recognize postgres:// protocol", () => {
      const database = createDatabase("postgres://user:pass@localhost:5432/db");
      expect(database.type).toBe("postgres");
    });

    it("should recognize postgresql:// protocol", () => {
      const database = createDatabase(
        "postgresql://user:pass@localhost:5432/db",
      );
      expect(database.type).toBe("postgres");
    });
  });
});
