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
});
