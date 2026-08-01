import { describe, expect, test } from "bun:test";
import { resolveCapabilities } from "./registry-metadata";

describe("resolveCapabilities", () => {
  test("does not grant a management capability from a connection-scoped bucket", () => {
    // A custom role granting a single connection's own tools happens to reuse
    // a management tool name in that connection's toolset. This must not
    // enable the unrelated "members:manage" capability org-wide.
    const capabilities = resolveCapabilities({
      conn_abc123: [
        "ORGANIZATION_MEMBER_LIST",
        "ORGANIZATION_MEMBER_ADD",
        "ORGANIZATION_MEMBER_REMOVE",
        "ORGANIZATION_MEMBER_UPDATE_ROLE",
        "ORGANIZATION_SEATS_GET",
        "ORGANIZATION_SEATS_SET",
        "ORGANIZATION_BILLING_CHECKOUT_START",
        "ORGANIZATION_SEATS_PREVIEW",
        "ORGANIZATION_BILLING_PORTAL",
        "ORGANIZATION_INCLUDED_REPORT_SET",
        "ORGANIZATION_REPORT_RUN_PAID",
        "ORGANIZATION_JOIN_REQUEST_LIST",
        "ORGANIZATION_JOIN_REQUEST_APPROVE",
        "ORGANIZATION_JOIN_REQUEST_DENY",
      ],
    });

    expect(capabilities["members:manage"]).toBe(false);
  });

  test("grants a management capability when its tools are in the self bucket", () => {
    const capabilities = resolveCapabilities({
      self: [
        "ORGANIZATION_MEMBER_LIST",
        "ORGANIZATION_MEMBER_ADD",
        "ORGANIZATION_MEMBER_REMOVE",
        "ORGANIZATION_MEMBER_UPDATE_ROLE",
        "ORGANIZATION_SEATS_GET",
        "ORGANIZATION_SEATS_SET",
        "ORGANIZATION_BILLING_CHECKOUT_START",
        "ORGANIZATION_SEATS_PREVIEW",
        "ORGANIZATION_BILLING_PORTAL",
        "ORGANIZATION_INCLUDED_REPORT_SET",
        "ORGANIZATION_REPORT_RUN_PAID",
        "ORGANIZATION_JOIN_REQUEST_LIST",
        "ORGANIZATION_JOIN_REQUEST_APPROVE",
        "ORGANIZATION_JOIN_REQUEST_DENY",
      ],
    });

    expect(capabilities["members:manage"]).toBe(true);
  });

  test("an org-wide `*` grant enables every capability", () => {
    const capabilities = resolveCapabilities({ self: ["*"] });

    expect(capabilities["members:manage"]).toBe(true);
    expect(capabilities["connections:manage"]).toBe(true);
  });
});
