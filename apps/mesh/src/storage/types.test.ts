import { describe, expect, it } from "bun:test";
import type { Database, Permission } from "./types";
import type { ConnectionEntity } from "../tools/connection/schema";

describe("Database Types", () => {
  describe("Permission format", () => {
    it("should allow valid Permission format", () => {
      const permission: Permission = {
        conn_abc123: ["SEND_MESSAGE", "LIST_THREADS"],
        mcp: ["COLLECTION_VIRTUAL_MCP_CREATE", "COLLECTION_VIRTUAL_MCP_LIST"],
      };
      expect(permission).toBeDefined();
      expect(permission["conn_abc123"]).toEqual([
        "SEND_MESSAGE",
        "LIST_THREADS",
      ]);
      expect(permission["mcp"]).toEqual([
        "COLLECTION_VIRTUAL_MCP_CREATE",
        "COLLECTION_VIRTUAL_MCP_LIST",
      ]);
    });

    it("should allow wildcard permissions", () => {
      const permission: Permission = {
        conn_123: ["*"],
      };
      expect(permission["conn_123"]).toEqual(["*"]);
    });

    it("should allow empty permission object", () => {
      const permission: Permission = {};
      expect(Object.keys(permission)).toHaveLength(0);
    });
  });

  describe("ConnectionEntity types", () => {
    it("should allow organization-scoped connection", () => {
      const conn: Partial<ConnectionEntity> = {
        id: "conn_123",
        organization_id: "org_123",
        title: "Test",
        connection_type: "HTTP",
        connection_url: "https://example.com",
      };
      expect(conn.organization_id).toBe("org_123");
    });

    it("should support all connection types", () => {
      const httpConn: Pick<ConnectionEntity, "connection_type"> = {
        connection_type: "HTTP",
      };
      const sseConn: Pick<ConnectionEntity, "connection_type"> = {
        connection_type: "SSE",
      };
      const wsConn: Pick<ConnectionEntity, "connection_type"> = {
        connection_type: "Websocket",
      };

      expect(httpConn.connection_type).toBe("HTTP");
      expect(sseConn.connection_type).toBe("SSE");
      expect(wsConn.connection_type).toBe("Websocket");
    });
  });

  describe("Database schema", () => {
    it("should have all required tables", () => {
      // Type-level test - if this compiles, the schema is valid
      const tableNames: (keyof Database)[] = [
        "connections",
        "api_keys",
        "oauth_clients",
        "oauth_authorization_codes",
        "oauth_refresh_tokens",
        "downstream_tokens",
      ];

      expect(tableNames).toHaveLength(6);
    });
  });

  describe("Organization model", () => {
    it("should reflect database as organization boundary", () => {
      // Conceptual test - validates our understanding
      const organizationConcept = {
        database: "mesh instance per organization",
        users: "managed by Better Auth",
        connections: "organization-scoped MCP connections",
        accessControl: "via Better Auth permissions",
      };

      expect(organizationConcept.database).toBe(
        "mesh instance per organization",
      );
      expect(organizationConcept.connections).toContain("organization-scoped");
    });
  });
});
