import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import type { McpAuthStatus } from "@decocms/mesh-sdk";
import {
  onAuthed,
  onInstallFresh,
  onInstalled,
  onPickActive,
  onPickInactive,
  onPollerActive,
  onPollerTimeout,
  resolveAuthPhase,
  onReset,
} from "./slot-card-transitions";

function makeConn(overrides: Partial<ConnectionEntity> = {}): ConnectionEntity {
  return {
    id: "conn_test",
    title: "Test Connection",
    status: "inactive",
    connection_type: "HTTP",
    connection_url: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    tools: null,
    bindings: null,
    organization_id: "org_1",
    created_by: "user_1",
    updated_by: "user_1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as ConnectionEntity;
}

describe("onInstalled", () => {
  it("transitions to polling phase", () => {
    expect(onInstalled("conn_abc").phase).toBe("polling");
  });

  it("sets pollingConnectionId to the new connection", () => {
    expect(onInstalled("conn_abc").pollingConnectionId).toBe("conn_abc");
  });
});

describe("onPollerActive", () => {
  it("does NOT immediately go to done — queues an auth check instead", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    // phase must not be set here; the auth check will decide done vs auth-oauth
    expect(onPollerActive(conn).phase).toBeUndefined();
  });

  it("sets authCheckId so the auth query fires", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPollerActive(conn).authCheckId).toBe("conn_abc");
  });

  it("clears pollingConnectionId", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPollerActive(conn).pollingConnectionId).toBeNull();
  });

  it("stores the active connection as selectedConnection", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPollerActive(conn).selectedConnection).toBe(conn);
  });
});

describe("onPollerTimeout", () => {
  it("sets authCheckId to the connectionId so the auth query fires", () => {
    const result = onPollerTimeout("conn_abc", makeConn({ id: "conn_abc" }));
    expect(result.authCheckId).toBe("conn_abc");
  });

  it("clears pollingConnectionId", () => {
    const result = onPollerTimeout("conn_abc", makeConn());
    expect(result.pollingConnectionId).toBeNull();
  });

  it("captures the connection entity when the poller fetched it before timing out", () => {
    const conn = makeConn({ id: "conn_abc" });
    expect(onPollerTimeout("conn_abc", conn).selectedConnection).toBe(conn);
  });

  it("stores null selectedConnection when the poller never fetched the entity", () => {
    expect(onPollerTimeout("conn_abc", null).selectedConnection).toBeNull();
  });
});

// Helper to build a McpAuthStatus quickly
function makeAuthStatus(overrides: Partial<McpAuthStatus> = {}): McpAuthStatus {
  return {
    isAuthenticated: true,
    supportsOAuth: false,
    hasOAuthToken: false,
    ...overrides,
  };
}

describe("resolveAuthPhase", () => {
  describe("connections with oauth_config (e.g. Gmail)", () => {
    // Cast because OAuthConfig shape is complex — we just need it to be non-null
    const oauthConn = {
      ...makeConn(),
      oauth_config: {},
    } as unknown as ConnectionEntity;

    it("returns auth-oauth when connection has oauth_config but no token yet — even if server returned 200", () => {
      // Gmail initialize returns 200 without a token, so supportsOAuth is false,
      // but we detect the need via oauth_config + !hasOAuthToken.
      const status = makeAuthStatus({
        isAuthenticated: true,
        supportsOAuth: false,
        hasOAuthToken: false,
      });
      expect(resolveAuthPhase(status, oauthConn, "active")).toBe("auth-oauth");
    });

    it("returns done once OAuth token has been obtained", () => {
      const status = makeAuthStatus({
        isAuthenticated: true,
        supportsOAuth: false,
        hasOAuthToken: true,
      });
      expect(resolveAuthPhase(status, oauthConn, "active")).toBe("done");
    });
  });

  describe("connections without oauth_config (e.g. simple HTTP MCPs)", () => {
    const simpleConn = makeConn();

    it("returns done when active and no auth needed", () => {
      const status = makeAuthStatus({
        isAuthenticated: true,
        supportsOAuth: false,
        hasOAuthToken: false,
      });
      expect(resolveAuthPhase(status, simpleConn, "active")).toBe("done");
    });

    it("returns auth-token when timed out with no OAuth cues", () => {
      const status = makeAuthStatus({
        isAuthenticated: false,
        supportsOAuth: false,
        hasOAuthToken: false,
      });
      expect(resolveAuthPhase(status, simpleConn, "timeout")).toBe(
        "auth-token",
      );
    });
  });

  describe("connections that return 401 + WWW-Authenticate (explicit OAuth challenge)", () => {
    it("returns auth-oauth regardless of oauth_config when server returns OAuth challenge", () => {
      const status = makeAuthStatus({
        isAuthenticated: false,
        supportsOAuth: true,
        hasOAuthToken: false,
      });
      expect(
        resolveAuthPhase(status, makeConn({ oauth_config: null }), "active"),
      ).toBe("auth-oauth");
      expect(
        resolveAuthPhase(status, makeConn({ oauth_config: null }), "timeout"),
      ).toBe("auth-oauth");
    });
  });

  describe("null selectedConnection (entity not fetched before timeout)", () => {
    it("returns auth-token when timed out with no info", () => {
      const status = makeAuthStatus({
        isAuthenticated: false,
        supportsOAuth: false,
      });
      expect(resolveAuthPhase(status, null, "timeout")).toBe("auth-token");
    });

    it("returns auth-oauth when server signals OAuth on timeout", () => {
      const status = makeAuthStatus({
        isAuthenticated: false,
        supportsOAuth: true,
      });
      expect(resolveAuthPhase(status, null, "timeout")).toBe("auth-oauth");
    });
  });
});

describe("onAuthed", () => {
  it("restarts polling using authCheckId when selectedConnection is null", () => {
    const result = onAuthed({
      pollingConnectionId: null,
      selectedConnection: null,
      authCheckId: "conn_abc",
    });
    expect(result.pollingConnectionId).toBe("conn_abc");
    expect(result.authCheckId).toBeNull();
    expect(result.phase).toBe("polling");
  });

  it("restarts polling using selectedConnection.id as fallback", () => {
    const conn = makeConn({ id: "conn_abc" });
    const result = onAuthed({
      pollingConnectionId: null,
      selectedConnection: conn,
      authCheckId: null,
    });
    expect(result.pollingConnectionId).toBe("conn_abc");
    expect(result.phase).toBe("polling");
  });

  it("prefers pollingConnectionId over selectedConnection.id", () => {
    const conn = makeConn({ id: "conn_selected" });
    const result = onAuthed({
      pollingConnectionId: "conn_polling",
      selectedConnection: conn,
      authCheckId: null,
    });
    expect(result.pollingConnectionId).toBe("conn_polling");
  });

  it("clears authCheckId after auth", () => {
    const result = onAuthed({
      pollingConnectionId: null,
      selectedConnection: null,
      authCheckId: "conn_abc",
    });
    expect(result.authCheckId).toBeNull();
  });

  it("returns empty object when no connection id is available", () => {
    const result = onAuthed({
      pollingConnectionId: null,
      selectedConnection: null,
      authCheckId: null,
    });
    expect(result).toEqual({});
  });
});

describe("onReset", () => {
  it("goes to picker when existing connections are available", () => {
    expect(onReset(true).phase).toBe("picker");
  });

  it("goes to install when no existing connections", () => {
    expect(onReset(false).phase).toBe("install");
  });

  it("clears selectedConnection", () => {
    expect(onReset(false).selectedConnection).toBeNull();
  });

  it("clears pollingConnectionId", () => {
    expect(onReset(false).pollingConnectionId).toBeNull();
  });

  it("clears authCheckId", () => {
    expect(onReset(false).authCheckId).toBeNull();
  });
});

describe("onPickActive", () => {
  it("transitions to done", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPickActive(conn).phase).toBe("done");
  });

  it("stores the picked connection", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPickActive(conn).selectedConnection).toBe(conn);
  });
});

describe("onPickInactive", () => {
  it("starts polling for the picked connection", () => {
    const conn = makeConn({ id: "conn_abc", status: "inactive" });
    expect(onPickInactive(conn).phase).toBe("polling");
  });

  it("sets pollingConnectionId to the picked connection id", () => {
    const conn = makeConn({ id: "conn_abc", status: "inactive" });
    expect(onPickInactive(conn).pollingConnectionId).toBe("conn_abc");
  });

  it("stores the picked connection as selectedConnection", () => {
    const conn = makeConn({ id: "conn_abc", status: "inactive" });
    expect(onPickInactive(conn).selectedConnection).toBe(conn);
  });
});

describe("onInstallFresh", () => {
  it("transitions to install phase", () => {
    expect(onInstallFresh().phase).toBe("install");
  });
});
