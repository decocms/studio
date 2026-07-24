import { describe, expect, it } from "bun:test";
import { type LinkBearerAuthApi, resolveLinkBearer } from "./link-bearer-auth";

const mcpApi = (userId: string | null): LinkBearerAuthApi => ({
  getMcpSession: async ({ headers }) => {
    expect(headers.get("X-MCP-Session-Auth")).toBe("true");
    return userId ? { userId } : null;
  },
  verifyApiKey: async () => null,
});

describe("resolveLinkBearer", () => {
  it("returns userSub from an MCP OAuth session", async () => {
    expect(await resolveLinkBearer("tok", mcpApi("user_1"))).toBe("user_1");
  });

  it("falls back to a Better Auth API key when no MCP session", async () => {
    const api: LinkBearerAuthApi = {
      getMcpSession: async () => null,
      verifyApiKey: async ({ body }) =>
        body.key === "good"
          ? { valid: true, key: { userId: "user_2" } }
          : { valid: false },
    };
    expect(await resolveLinkBearer("good", api)).toBe("user_2");
    expect(await resolveLinkBearer("bad", api)).toBeNull();
  });

  it("returns null when both paths reject (swallows thrown INVALID_API_KEY)", async () => {
    const api: LinkBearerAuthApi = {
      getMcpSession: async () => {
        throw new Error("boom");
      },
      verifyApiKey: async () => {
        throw new Error("INVALID_API_KEY");
      },
    };
    expect(await resolveLinkBearer("x", api)).toBeNull();
  });
});
