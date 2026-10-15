import { describe, expect, test } from "bun:test";
import { activeMcpTokenUserId } from "./mcp-session";

const now = new Date("2026-01-01T12:00:00.000Z");

describe("activeMcpTokenUserId", () => {
  test("returns the user of an unexpired token", () => {
    expect(
      activeMcpTokenUserId(
        { userId: "user_1", accessTokenExpiresAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe("user_1");
  });

  test("accepts the expiry as an ISO string", () => {
    expect(
      activeMcpTokenUserId(
        { userId: "user_1", accessTokenExpiresAt: "2026-01-01T13:00:00.000Z" },
        now,
      ),
    ).toBe("user_1");
  });

  test("rejects a token that expired or expires exactly now", () => {
    for (const accessTokenExpiresAt of [
      new Date(now.getTime() - 60_000),
      new Date(now.getTime()),
    ]) {
      expect(
        activeMcpTokenUserId({ userId: "user_1", accessTokenExpiresAt }, now),
      ).toBeNull();
    }
  });

  test("rejects missing, malformed, and empty rows", () => {
    for (const row of [
      null,
      undefined,
      {},
      { userId: "user_1" },
      { userId: "user_1", accessTokenExpiresAt: "not a date" },
      { userId: "", accessTokenExpiresAt: new Date(now.getTime() + 1) },
      { accessTokenExpiresAt: new Date(now.getTime() + 1) },
    ]) {
      expect(activeMcpTokenUserId(row, now)).toBeNull();
    }
  });
});
