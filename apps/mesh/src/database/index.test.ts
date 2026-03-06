import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { closeDatabase, createDatabase } from "./index";
import type { MeshDatabase, PGliteDatabase } from "./index";

describe("Database Factory", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mesh-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createDatabase", () => {
    it("should create SQLite database from file:// URL", async () => {
      const dbPath = join(tempDir, "test-file.db");
      const database = createDatabase(`file:${dbPath}`);

      expect(database).toBeDefined();
      expect(database.type).toBe("sqlite");
      expect(database.db).toBeDefined();

      // Test that database is functional (will fail without migrations, but db exists)
      try {
        await database.db
          .selectFrom("projects" as never)
          .selectAll()
          .execute();
      } catch (error) {
        // Expected - table doesn't exist without migrations
        expect(error).toBeDefined();
      }

      await closeDatabase(database);
    });

    it("should create SQLite database from sqlite:// URL", async () => {
      const dbPath = join(tempDir, "test-sqlite.db");
      const database = createDatabase(`sqlite://${dbPath}`);

      expect(database).toBeDefined();
      expect(database.type).toBe("sqlite");
      await closeDatabase(database);
    });

    it("should default to SQLite when no URL provided", () => {
      const database = createDatabase();
      expect(database).toBeDefined();
      expect(database.type).toBe("sqlite");
      // Don't close the default instance as it's a singleton
    });

    it("should throw error for unsupported protocol", () => {
      expect(() => createDatabase("redis://localhost")).toThrow(
        "Unsupported database protocol: redis",
      );
    });

    it("should create directory if not exists for SQLite", async () => {
      const dbPath = join(tempDir, "nested", "dir", "test.db");
      const database = createDatabase(`file:${dbPath}`);

      expect(database).toBeDefined();
      await closeDatabase(database);
    });

    it("should handle in-memory SQLite database", async () => {
      const database = createDatabase(":memory:");

      expect(database).toBeDefined();
      expect(database.type).toBe("sqlite");
      await closeDatabase(database);
    });
  });

  describe("closeDatabase", () => {
    it("should close database connection", async () => {
      const database = createDatabase(":memory:");

      // Should not throw
      await closeDatabase(database);
      expect(true).toBe(true);
    });
  });

  describe("PostgreSQL support", () => {
    it("should recognize postgres:// protocol", () => {
      // Don't actually connect, just check protocol recognition
      // This will create a Pool but we can check the type
      const database = createDatabase("postgres://user:pass@localhost:5432/db");
      expect(database.type).toBe("postgres");
      // Note: Pool connection will fail but type detection works
    });

    it("should recognize postgresql:// protocol", () => {
      const database = createDatabase(
        "postgresql://user:pass@localhost:5432/db",
      );
      expect(database.type).toBe("postgres");
    });
  });
});

describe("MeshDatabase types", () => {
  test("PGliteDatabase has type 'pglite' and db but no pool", () => {
    const pglite: PGliteDatabase = {
      type: "pglite",
      db: {} as any,
    };
    const mesh: MeshDatabase = pglite;
    expect(mesh.type).toBe("pglite");
    expect(mesh).not.toHaveProperty("pool");
  });

  test("MeshDatabase discriminated union covers all three types", () => {
    function getDbType(db: MeshDatabase): string {
      switch (db.type) {
        case "sqlite":
          return "sqlite";
        case "postgres":
          return "postgres";
        case "pglite":
          return "pglite";
      }
    }

    const pglite: MeshDatabase = { type: "pglite", db: {} as any };
    expect(getDbType(pglite)).toBe("pglite");
  });
});
