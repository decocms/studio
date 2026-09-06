import { describe, expect, it } from "bun:test";
import { extractConnectionData } from "./extract-connection-data";
import type { RegistryItem } from "@/components/store/types";

const packageOnlyItem: RegistryItem = {
  id: "reg-1",
  title: "Jira MCP",
  server: {
    name: "jira-mcp",
    packages: [{ identifier: "mcp-jira-server" }],
  },
};

describe("extractConnectionData", () => {
  // Every real caller (use-connect-app, add-connection-dialog, ...) invokes
  // this with only `remoteIndex: 0` — never `packageIndex`. A package-only
  // registry item (no `remotes`) must still resolve to a usable STDIO
  // connection instead of falling through to the empty-URL "Fallback" branch.
  it("resolves a package-only item to a STDIO connection when called the way every caller calls it", () => {
    const data = extractConnectionData(packageOnlyItem, "org-1", "user-1", {
      remoteIndex: 0,
    });

    expect(data.connection_type).toBe("STDIO");
    expect(data.connection_headers).toMatchObject({
      command: "npx",
      args: ["-y", "mcp-jira-server"],
    });
  });

  it("still prefers the remote when both remotes and packages are present", () => {
    const item: RegistryItem = {
      ...packageOnlyItem,
      server: {
        ...packageOnlyItem.server,
        remotes: [{ type: "http", url: "https://example.com/mcp" }],
      },
    };

    const data = extractConnectionData(item, "org-1", "user-1", {
      remoteIndex: 0,
    });

    expect(data.connection_type).toBe("HTTP");
    expect(data.connection_url).toBe("https://example.com/mcp");
  });

  // Registry oauth_config is untrusted third-party _meta; a non-URL endpoint must not survive.
  it("drops oauth_config when an endpoint isn't a valid URL", () => {
    const item: RegistryItem = {
      ...packageOnlyItem,
      _meta: {
        "mcp.studio": {
          oauth_config: {
            authorizationEndpoint: "not-a-url",
            tokenEndpoint: "https://example.com/token",
            clientId: "client-1",
            scopes: ["read"],
            grantType: "authorization_code",
          },
        },
      },
    };

    const data = extractConnectionData(item, "org-1", "user-1", {
      remoteIndex: 0,
    });

    expect(data.oauth_config).toBeNull();
  });

  // An unrecognized remote type must not mint an invalid connection_type enum value.
  it("falls back to HTTP for an unrecognized remote type", () => {
    const item: RegistryItem = {
      ...packageOnlyItem,
      server: {
        ...packageOnlyItem.server,
        remotes: [{ type: "graphql", url: "https://example.com/mcp" }],
      },
    };

    const data = extractConnectionData(item, "org-1", "user-1", {
      remoteIndex: 0,
    });

    expect(data.connection_type).toBe("HTTP");
  });

  it("keeps a well-formed oauth_config", () => {
    const item: RegistryItem = {
      ...packageOnlyItem,
      _meta: {
        "mcp.studio": {
          oauth_config: {
            authorizationEndpoint: "https://example.com/authorize",
            tokenEndpoint: "https://example.com/token",
            clientId: "client-1",
            scopes: ["read"],
            grantType: "authorization_code",
          },
        },
      },
    };

    const data = extractConnectionData(item, "org-1", "user-1", {
      remoteIndex: 0,
    });

    expect(data.oauth_config).toMatchObject({ clientId: "client-1" });
  });
});
