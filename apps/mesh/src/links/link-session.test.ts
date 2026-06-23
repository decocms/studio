import { describe, expect, test } from "bun:test";
import { encodeSubjectToken } from "@decocms/tunnel/subject";
import {
  buildDaemonCredentialPermissions,
  buildLinkSessionResponse,
  buildUserTunnelHostname,
} from "./link-session";

describe("link session helpers", () => {
  test("builds a stable user-scoped tunnel hostname for user ids with dots", () => {
    const userId = "user.with.dots";
    const hostname = buildUserTunnelHostname(userId);

    expect(hostname).toBe(`user-${encodeSubjectToken(userId)}.link`);
    expect(hostname).toMatch(/^user-[A-Za-z0-9_-]+\.link$/);
    expect(buildUserTunnelHostname(userId)).toBe(hostname);
  });

  test("builds host-scoped daemon credential permissions", () => {
    const tunnelHostname = "user-dXNlci53aXRoLmRvdHM.link";
    const hostToken = encodeSubjectToken(tunnelHostname);

    expect(buildDaemonCredentialPermissions(tunnelHostname)).toEqual({
      subscribe: {
        allow: [
          `tunnel.v1.host.${hostToken}.request`,
          `tunnel.v1.host.${hostToken}.req.*.body`,
          `tunnel.v1.host.${hostToken}.req.*.abort`,
          `_INBOX.${hostToken}.>`,
        ],
      },
      publish: {
        allow: [
          `tunnel.v1.host.${hostToken}.req.*.reply`,
          "decopilot.stream.*",
        ],
      },
    });
  });

  test("does not grant JetStream or work-queue permissions", () => {
    const permissions = JSON.stringify(
      buildDaemonCredentialPermissions("user-dXNlci53aXRoLmRvdHM.link"),
    );

    expect(permissions).not.toContain("$JS.API");
    expect(permissions).not.toContain("link.work");
  });

  test("builds a neutral link session response DTO", () => {
    const before = Date.now();
    const response = buildLinkSessionResponse({
      publicUrl: "wss://nats-a.example.com, wss://nats-b.example.com,,",
      userId: "user.with.dots",
      ttlSeconds: 60,
      credentials: "creds",
    });
    const after = Date.now();

    expect(response.connection).toEqual({
      urls: ["wss://nats-a.example.com", "wss://nats-b.example.com"],
      credentials: "creds",
    });
    expect(response.tunnelHostname).toBe(
      buildUserTunnelHostname("user.with.dots"),
    );
    expect(new Date(response.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 60_000,
    );
    expect(new Date(response.expiresAt).getTime()).toBeLessThanOrEqual(
      after + 60_000,
    );
    expect("token" in response.connection).toBe(false);
  });
});
