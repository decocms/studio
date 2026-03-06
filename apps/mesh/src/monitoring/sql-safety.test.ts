import { describe, it, expect } from "bun:test";
import { assertSafeJsonPath, assertSafeIdentifier } from "./sql-safety";

describe("sql-safety", () => {
  describe("assertSafeJsonPath", () => {
    it("allows valid JSONPaths", () => {
      expect(() => assertSafeJsonPath("$.usage.total_tokens")).not.toThrow();
      expect(() => assertSafeJsonPath("$.key")).not.toThrow();
      expect(() => assertSafeJsonPath("result")).not.toThrow();
    });

    it("rejects paths with single quotes", () => {
      expect(() => assertSafeJsonPath("$.key'")).toThrow();
    });

    it("rejects paths with semicolons", () => {
      expect(() => assertSafeJsonPath("$.key; DROP TABLE")).toThrow();
    });

    it("rejects paths with SQL comment markers", () => {
      expect(() => assertSafeJsonPath("$.key--comment")).toThrow();
    });

    it("rejects paths with parentheses", () => {
      expect(() => assertSafeJsonPath("$.key) OR 1=1")).toThrow();
    });
  });

  describe("assertSafeIdentifier", () => {
    it("allows valid property keys", () => {
      expect(() => assertSafeIdentifier("thread_id")).not.toThrow();
      expect(() => assertSafeIdentifier("env")).not.toThrow();
      expect(() => assertSafeIdentifier("user_id")).not.toThrow();
    });

    it("rejects keys with SQL metacharacters", () => {
      expect(() => assertSafeIdentifier("key'")).toThrow();
      expect(() => assertSafeIdentifier("key; DROP")).toThrow();
      expect(() => assertSafeIdentifier("key) OR 1=1")).toThrow();
    });
  });
});
