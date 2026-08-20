import { describe, expect, it } from "bun:test";
import {
  hostMatchesSuffix,
  isLoopbackHost,
  redirectUriMatchesRegistered,
  satisfiesAllowedRedirectHosts,
} from "./redirect-uri.ts";

describe("isLoopbackHost", () => {
  it("accepts loopback literals and reserved localhost names", () => {
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "::1",
      "localhost",
      "app.localhost",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects hosts that merely look local", () => {
    for (const host of [
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "notlocalhost",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("redirectUriMatchesRegistered", () => {
  const registered = "https://client.example.com/callback";

  it("matches an identical URI", () => {
    expect(redirectUriMatchesRegistered(registered, registered)).toBe(true);
  });

  it("rejects prefix, suffix, path and query variations", () => {
    for (const requested of [
      "https://client.example.com/callback/",
      "https://client.example.com/callback?next=1",
      "https://client.example.com/callback/../evil",
      "https://client.example.com.evil.io/callback",
      "https://evil.io/https://client.example.com/callback",
      "http://client.example.com/callback",
    ]) {
      expect(redirectUriMatchesRegistered(requested, registered)).toBe(false);
    }
  });

  it("allows only the port to vary on loopback URIs", () => {
    const loopback = "http://127.0.0.1:8080/callback";
    expect(
      redirectUriMatchesRegistered("http://127.0.0.1:51234/callback", loopback),
    ).toBe(true);
    expect(
      redirectUriMatchesRegistered("http://127.0.0.1:51234/other", loopback),
    ).toBe(false);
    expect(
      redirectUriMatchesRegistered("http://[::1]:51234/callback", loopback),
    ).toBe(false);
    expect(
      redirectUriMatchesRegistered("https://127.0.0.1/callback", loopback),
    ).toBe(false);
  });

  it("does not relax the port for non-loopback hosts", () => {
    expect(
      redirectUriMatchesRegistered(
        "https://client.example.com:8443/callback",
        registered,
      ),
    ).toBe(false);
  });

  it("rejects unparseable URIs", () => {
    expect(redirectUriMatchesRegistered("not a url", registered)).toBe(false);
  });
});

describe("hostMatchesSuffix", () => {
  it("matches on a label boundary only", () => {
    expect(hostMatchesSuffix("decocms.com", "decocms.com")).toBe(true);
    expect(hostMatchesSuffix("github-mcp.decocms.com", "decocms.com")).toBe(
      true,
    );
    expect(hostMatchesSuffix("evildecocms.com", "decocms.com")).toBe(false);
    expect(hostMatchesSuffix("decocms.com.attacker.io", "decocms.com")).toBe(
      false,
    );
  });

  it("ignores case, surrounding whitespace and a leading dot", () => {
    expect(hostMatchesSuffix("API.DecoCMS.com", " .decocms.com ")).toBe(true);
  });

  it("never matches an empty suffix", () => {
    expect(hostMatchesSuffix("decocms.com", "   ")).toBe(false);
  });
});

describe("satisfiesAllowedRedirectHosts", () => {
  const allowed = ["decocms.com"];

  it("accepts https on an allowed host", () => {
    expect(
      satisfiesAllowedRedirectHosts(
        "https://github-mcp.decocms.com/oauth/callback",
        allowed,
      ),
    ).toBe(true);
  });

  it("accepts http only for loopback", () => {
    expect(
      satisfiesAllowedRedirectHosts("http://127.0.0.1:5173/cb", allowed),
    ).toBe(true);
    expect(
      satisfiesAllowedRedirectHosts("http://decocms.com/cb", allowed),
    ).toBe(false);
  });

  it("rejects custom schemes, which have no host to check", () => {
    expect(
      satisfiesAllowedRedirectHosts("cursor://decocms.com/cb", allowed),
    ).toBe(false);
  });

  it("rejects an empty allowlist and unparseable URIs", () => {
    expect(satisfiesAllowedRedirectHosts("https://decocms.com/cb", [])).toBe(
      false,
    );
    expect(satisfiesAllowedRedirectHosts("not a url", allowed)).toBe(false);
  });
});
