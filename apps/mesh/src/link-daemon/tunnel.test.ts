import { describe, expect, it } from "bun:test";
import { computeLinkSubDomain } from "./tunnel";

describe("computeLinkSubDomain", () => {
  it("lowercases mixed-case userSubs", () => {
    // Better Auth subs are case-sensitive nanoids, but hostnames are
    // case-insensitive and the WHATWG URL parser lowercases the host on
    // the wire. The Warp DO behind deco.host keys its registration map
    // by the `domain` field passed in the register message — if we send
    // it mixed-case while the public HTTP request arrives lowercase,
    // every dispatch 503s with "No registration for domain". The
    // cluster's `expectedTunnelDomain` does the same in
    // `apps/mesh/src/links/routes.ts`.
    expect(computeLinkSubDomain("ycoiLjsJJ87qAKNeANPPpb7UDoCKdqoy")).toBe(
      "link-ycoiljsjj87qakneanpppb7udockdqoy.deco.host",
    );
  });

  it("is idempotent for already-lowercase userSubs", () => {
    expect(computeLinkSubDomain("abc123")).toBe("link-abc123.deco.host");
  });
});
