import { describe, expect, it } from "bun:test";
import { swapVirtualMcpAgent } from "./swap-virtual-mcp-agent";

describe("swapVirtualMcpAgent", () => {
  it("swaps the parent agent-id segment for the target id", () => {
    expect(
      swapVirtualMcpAgent(
        "https://studio.example.com/mcp/virtual-mcp/vir_parent",
        "vir_target",
      ),
    ).toBe("https://studio.example.com/mcp/virtual-mcp/vir_target");
  });

  it("handles a trailing slash on the parent url", () => {
    expect(
      swapVirtualMcpAgent(
        "https://studio.example.com/mcp/virtual-mcp/vir_parent/",
        "vir_target",
      ),
    ).toBe("https://studio.example.com/mcp/virtual-mcp/vir_target");
  });

  it("returns the parent url unchanged for a self-clone (undefined target)", () => {
    const url = "https://studio.example.com/mcp/virtual-mcp/vir_parent";
    expect(swapVirtualMcpAgent(url, undefined)).toBe(url);
  });

  it("encodes the target id", () => {
    expect(
      swapVirtualMcpAgent(
        "https://studio.example.com/mcp/virtual-mcp/vir_parent",
        "weird id/segment",
      ),
    ).toBe("https://studio.example.com/mcp/virtual-mcp/weird%20id%2Fsegment");
  });

  it("preserves an org-scoped path prefix when swapping", () => {
    expect(
      swapVirtualMcpAgent(
        "https://studio.example.com/api/acme/mcp/virtual-mcp/vir_parent",
        "vir_target",
      ),
    ).toBe("https://studio.example.com/api/acme/mcp/virtual-mcp/vir_target");
  });

  it("leaves a non-virtual-mcp url untouched (no segment to swap)", () => {
    const url = "https://studio.example.com/mcp/agent-1";
    expect(swapVirtualMcpAgent(url, "vir_target")).toBe(url);
  });
});
