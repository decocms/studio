import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import {
  onAuthed,
  onInstallFresh,
  onInstalled,
  onPickActive,
  onPickInactive,
  onPollerActive,
  onPollerTimeout,
  onAuthStatus,
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
  it("transitions to done", () => {
    const conn = makeConn({ id: "conn_abc", status: "active" });
    expect(onPollerActive(conn).phase).toBe("done");
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

describe("onAuthStatus", () => {
  it("routes to auth-oauth when the endpoint supports OAuth", () => {
    expect(onAuthStatus(true).phase).toBe("auth-oauth");
  });

  it("routes to auth-token when the endpoint does not support OAuth", () => {
    expect(onAuthStatus(false).phase).toBe("auth-token");
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
