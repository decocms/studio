import { describe, it, expect } from "bun:test";
import { needsTokenEndpointReresolution } from "./token-refresh";

describe("needsTokenEndpointReresolution", () => {
  it("re-resolves oauth-proxy URLs", () => {
    expect(
      needsTokenEndpointReresolution(
        "https://studio.example.com/oauth-proxy/conn_x/token",
        "https://sites-x.deco.site/mcp",
      ),
    ).toBe(true);
  });

  it("re-resolves when the stored host is stale (host mismatch)", () => {
    // Captured against the `*.decocache.com` canonical host at authorize time;
    // the connection lives on the working `*.deco.site` alias.
    expect(
      needsTokenEndpointReresolution(
        "https://sites-x.decocache.com/token",
        "https://sites-x.deco.site/mcp",
      ),
    ).toBe(true);
  });

  it("does not re-resolve when the host matches", () => {
    expect(
      needsTokenEndpointReresolution(
        "https://sites-x.deco.site/token",
        "https://sites-x.deco.site/mcp",
      ),
    ).toBe(false);
  });

  it("does not re-resolve on unparseable input", () => {
    expect(
      needsTokenEndpointReresolution("not a url", "https://x.deco.site/mcp"),
    ).toBe(false);
  });
});
