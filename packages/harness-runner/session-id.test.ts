import { describe, expect, test } from "bun:test";
import { sessionIdForThread, uuidV5 } from "./session-id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidV5", () => {
  test("matches the RFC 4122 test vector", () => {
    // Canonical vector: "www.example.com" under the DNS namespace.
    expect(
      uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });
});

describe("sessionIdForThread", () => {
  test("is a well-formed v5 UUID", () => {
    expect(sessionIdForThread("thrd_abc")).toMatch(UUID_RE);
  });

  test("is deterministic — the same thread resumes the same session", () => {
    expect(sessionIdForThread("thrd_abc")).toBe(sessionIdForThread("thrd_abc"));
  });

  test("different threads never share a session", () => {
    expect(sessionIdForThread("thrd_abc")).not.toBe(
      sessionIdForThread("thrd_abd"),
    );
  });
});
