import { describe, expect, test } from "bun:test";
import {
  assertMayMoveCredentials,
  changesCredentialOrigin,
} from "./credential-origin-guard";
import type { ConnectionEntity } from "./schema";

const FROM = "https://mcp.example.com/mcp";

function connection(overrides: Partial<ConnectionEntity> = {}) {
  return {
    id: "conn_1",
    connection_url: FROM,
    connection_token: null,
    connection_headers: null,
    ...overrides,
  } as ConnectionEntity;
}

function ctx(role: string, oauthTokenStored = false) {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => (oauthTokenStored ? { id: "t1" } : undefined),
  };
  return {
    access: { getRole: () => role },
    db: { selectFrom: () => query },
  } as unknown as Parameters<typeof assertMayMoveCredentials>[0];
}

describe("changesCredentialOrigin", () => {
  test("a path change on the same origin is not a move", () => {
    expect(changesCredentialOrigin(FROM, "https://mcp.example.com/v2")).toBe(
      false,
    );
  });

  test("another host, scheme or port is a move", () => {
    for (const to of [
      "https://elsewhere.example/mcp",
      "http://mcp.example.com/mcp",
      "https://mcp.example.com:8443/mcp",
      null,
    ]) {
      expect(changesCredentialOrigin(FROM, to)).toBe(true);
    }
  });

  test("URLs without an origin compare whole", () => {
    expect(changesCredentialOrigin("virtual://a", "virtual://a")).toBe(false);
    expect(changesCredentialOrigin("virtual://a", "virtual://b")).toBe(true);
  });
});

describe("assertMayMoveCredentials", () => {
  const elsewhere = "https://elsewhere.example/mcp";

  test("a member can't move a connection with a stored token, OAuth token or headers", async () => {
    const cases = [
      { conn: connection({ connection_token: "t" }), oauth: false },
      {
        conn: connection({
          connection_headers: { headers: { Authorization: "Bearer x" } },
        }),
        oauth: false,
      },
      { conn: connection(), oauth: true },
    ];
    for (const { conn, oauth } of cases) {
      await expect(
        assertMayMoveCredentials(ctx("user", oauth), conn, elsewhere),
      ).rejects.toThrow(/owners and admins/);
    }
  });

  test("a member can move a connection without credentials, or edit the path", async () => {
    await assertMayMoveCredentials(ctx("user"), connection(), elsewhere);
    await assertMayMoveCredentials(
      ctx("user"),
      connection({ connection_token: "t" }),
      "https://mcp.example.com/v2",
    );
  });

  test("owners and admins can move it", async () => {
    for (const role of ["owner", "admin", "admin,billing-manager"]) {
      await assertMayMoveCredentials(
        ctx(role, true),
        connection({ connection_token: "t" }),
        elsewhere,
      );
    }
  });
});
