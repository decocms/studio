import { describe, expect, it } from "bun:test";
import {
  isBlockableOrgRequest,
  isToolAllowedWhileBlocked,
} from "./org-notice-gate";

describe("isBlockableOrgRequest", () => {
  it("never blocks reads", () => {
    expect(isBlockableOrgRequest("GET", "/api/acme/threads")).toBe(false);
    expect(isBlockableOrgRequest("HEAD", "/api/acme/threads")).toBe(false);
    expect(isBlockableOrgRequest("OPTIONS", "/api/acme/threads")).toBe(false);
  });

  it("blocks control-plane writes", () => {
    expect(isBlockableOrgRequest("POST", "/api/acme/fs/main/write")).toBe(true);
    expect(isBlockableOrgRequest("PUT", "/api/acme/kv/some-key")).toBe(true);
    expect(isBlockableOrgRequest("DELETE", "/api/acme/object-storage/x")).toBe(
      true,
    );
    expect(isBlockableOrgRequest("POST", "/api/acme/webhooks/trigger-1")).toBe(
      true,
    );
  });

  it("leaves the data plane and its credentials alone", () => {
    expect(isBlockableOrgRequest("POST", "/api/acme/mcp/conn-1")).toBe(false);
    expect(
      isBlockableOrgRequest(
        "POST",
        "/api/acme/vault/connections/c1/access-token",
      ),
    ).toBe(false);
    expect(
      isBlockableOrgRequest("POST", "/api/acme/connections/c1/oauth-token"),
    ).toBe(false);
    expect(
      isBlockableOrgRequest("POST", "/api/acme/oauth-proxy/c1/token"),
    ).toBe(false);
    expect(isBlockableOrgRequest("POST", "/api/acme/sandbox/vm-1/main/x")).toBe(
      false,
    );
    expect(isBlockableOrgRequest("POST", "/api/acme/trigger-callback")).toBe(
      false,
    );
  });

  it("lets sign-in through, or the member cannot read why they are blocked", () => {
    expect(isBlockableOrgRequest("POST", "/api/acme/sso/authorize")).toBe(
      false,
    );
  });

  it("delegates tool dispatch to the per-tool gate", () => {
    expect(
      isBlockableOrgRequest("POST", "/api/acme/tools/THREADS_CREATE"),
    ).toBe(false);
  });

  it("ignores a path with no route under the org segment", () => {
    expect(isBlockableOrgRequest("POST", "/api/acme")).toBe(false);
    expect(isBlockableOrgRequest("POST", "/api/acme/")).toBe(false);
  });
});

describe("isToolAllowedWhileBlocked", () => {
  it("allows what the block screen and the billing page need", () => {
    expect(isToolAllowedWhileBlocked("ORGANIZATION_GET")).toBe(true);
    expect(isToolAllowedWhileBlocked("ORGANIZATION_SETTINGS_GET")).toBe(true);
    expect(isToolAllowedWhileBlocked("INFRA_BILLING_PORTAL")).toBe(true);
    expect(
      isToolAllowedWhileBlocked("ORGANIZATION_BILLING_CHECKOUT_START"),
    ).toBe(true);
  });

  it("denies everything else, including reads", () => {
    expect(isToolAllowedWhileBlocked("THREADS_CREATE")).toBe(false);
    expect(isToolAllowedWhileBlocked("ORGANIZATION_SETTINGS_UPDATE")).toBe(
      false,
    );
    expect(isToolAllowedWhileBlocked("TASK_BOARD_ITEM_LIST")).toBe(false);
  });
});
