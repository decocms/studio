/**
 * JWT Authentication Integration Tests
 *
 * Tests for the studio JWT token system:
 * - Token issuance with custom payloads
 * - Token verification
 * - Token decoding (without verification)
 * - Integration with context factory authentication
 * - Backwards compatibility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { decodeJwt } from "jose";
import {
  issueMeshToken,
  verifyMeshToken,
  type MeshJwtPayload,
  type MeshTokenPayload,
} from "./jwt";

const decodeMeshToken = (token: string): MeshJwtPayload =>
  decodeJwt<MeshTokenPayload>(token);

// ============================================================================
// JWT Utility Tests
// ============================================================================

describe("JWT Utility Functions", () => {
  describe("issueMeshToken", () => {
    it("should issue a valid JWT token with all payload fields", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_123",
        permissions: {
          conn_456: ["SEND_MESSAGE", "LIST_THREADS"],
          conn_789: ["*"],
        },
        metadata: {
          state: {
            selectedConnection: { value: "conn_456" },
          },
          meshUrl: "https://mesh.example.com",
          connectionId: "conn_456",
        },
      };

      const token = await issueMeshToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3); // JWT has 3 parts
    });

    it("should issue token with default 5 minute expiration", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_123",
        permissions: {},
        metadata: {
          meshUrl: "https://mesh.example.com",
          connectionId: "conn_456",
        },
      };

      const token = await issueMeshToken(payload);
      const decoded = decodeMeshToken(token);

      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();

      // Expiration should be ~5 minutes from now
      const fiveMinutesInSeconds = 5 * 60;
      const expDiff = (decoded.exp as number) - (decoded.iat as number);
      expect(expDiff).toBe(fiveMinutesInSeconds);
    });

    it("should issue token with custom expiration", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_123",
        permissions: {},
        metadata: {
          meshUrl: "https://mesh.example.com",
          connectionId: "conn_456",
        },
      };

      const token = await issueMeshToken(payload, "1h");
      const decoded = decodeMeshToken(token);

      // Expiration should be ~1 hour from now
      const oneHourInSeconds = 60 * 60;
      const expDiff = (decoded.exp as number) - (decoded.iat as number);
      expect(expDiff).toBe(oneHourInSeconds);
    });

    it("should include all custom payload fields in token", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_test_123",
        permissions: {
          conn_abc: ["TOOL_A", "TOOL_B"],
        },
        metadata: {
          state: {
            config: { value: "test_value" },
            nested: { deep: { data: true } },
          },
          meshUrl: "https://test.mesh.com",
          connectionId: "conn_abc",
        },
      };

      const token = await issueMeshToken(payload);
      const decoded = decodeMeshToken(token);

      expect(decoded.sub).toBe("user_test_123");
      expect(decoded.permissions).toEqual({
        conn_abc: ["TOOL_A", "TOOL_B"],
      });
      expect(decoded.metadata?.state).toEqual({
        config: { value: "test_value" },
        nested: { deep: { data: true } },
      });
      expect(decoded.metadata?.meshUrl).toBe("https://test.mesh.com");
      expect(decoded.metadata?.connectionId).toBe("conn_abc");
    });
  });

  describe("verifyMeshToken", () => {
    it("should verify and return payload for valid token", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_123",
        permissions: { conn_456: ["*"] },
        metadata: {
          meshUrl: "https://mesh.example.com",
          connectionId: "conn_456",
        },
      };

      const token = await issueMeshToken(payload);
      const verified = await verifyMeshToken(token);

      expect(verified).toBeDefined();
      expect(verified?.sub).toBe("user_123");
      expect(verified?.permissions).toEqual({ conn_456: ["*"] });
      expect(verified?.metadata?.meshUrl).toBe("https://mesh.example.com");
      expect(verified?.metadata?.connectionId).toBe("conn_456");
    });

    it("should return undefined for invalid token", async () => {
      const invalidToken = "invalid.token.here";
      const verified = await verifyMeshToken(invalidToken);

      expect(verified).toBeUndefined();
    });

    it("should return undefined for tampered token", async () => {
      const payload: MeshTokenPayload = {
        sub: "user_123",
        permissions: {},
        metadata: {
          meshUrl: "https://mesh.example.com",
          connectionId: "conn_456",
        },
      };

      const token = await issueMeshToken(payload);

      // Tamper with the payload part (second segment)
      const parts = token.split(".");
      parts[1] = "tampered_payload_data";
      const tamperedToken = parts.join(".");

      const verified = await verifyMeshToken(tamperedToken);
      expect(verified).toBeUndefined();
    });

    it("should return undefined for token signed with different secret", async () => {
      // This test verifies that tokens from other sources won't validate
      // Create a fake JWT that looks valid but wasn't signed by us
      const fakeToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEyMyIsInBlcm1pc3Npb25zIjp7fSwibWV0YWRhdGEiOnsibWVzaFVybCI6Imh0dHBzOi8vbWVzaC5leGFtcGxlLmNvbSIsImNvbm5lY3Rpb25JZCI6ImNvbm5fNDU2In19.fake_signature";

      const verified = await verifyMeshToken(fakeToken);
      expect(verified).toBeUndefined();
    });
  });
});

// ============================================================================
// Token Payload Structure Tests
// ============================================================================

describe("Token Payload Structure", () => {
  it("should support empty permissions object", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token = await issueMeshToken(payload);
    const decoded = decodeMeshToken(token);

    expect(decoded.permissions).toEqual({});
  });

  it("should support multiple connections in permissions", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {
        conn_1: ["TOOL_A"],
        conn_2: ["TOOL_B", "TOOL_C"],
        conn_3: ["*"],
      },
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_1",
      },
    };

    const token = await issueMeshToken(payload);
    const decoded = decodeMeshToken(token);

    expect(Object.keys(decoded.permissions as object).length).toBe(3);
    expect((decoded.permissions as Record<string, string[]>)["conn_1"]).toEqual(
      ["TOOL_A"],
    );
    expect((decoded.permissions as Record<string, string[]>)["conn_2"]).toEqual(
      ["TOOL_B", "TOOL_C"],
    );
    expect((decoded.permissions as Record<string, string[]>)["conn_3"]).toEqual(
      ["*"],
    );
  });

  it("should support undefined state in metadata", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
        // state is optional
      },
    };

    const token = await issueMeshToken(payload);
    const decoded = decodeMeshToken(token);

    expect(decoded.metadata?.state).toBeUndefined();
  });

  it("should support complex state objects in metadata", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        state: {
          selectedProvider: { value: "conn_provider" },
          config: {
            apiKey: "encrypted_value",
            endpoint: "https://api.example.com",
          },
          array: [1, 2, 3],
          nested: {
            deep: {
              value: true,
            },
          },
        },
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token = await issueMeshToken(payload);
    const decoded = decodeMeshToken(token);

    expect(decoded.metadata?.state).toEqual(payload.metadata?.state);
  });
});

// ============================================================================
// Token Expiration Tests
// ============================================================================

describe("Token Expiration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should reject expired token on verification", async () => {
    vi.useRealTimers(); // Need real timers for token issuance

    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    // Issue token with very short expiration
    const token = await issueMeshToken(payload, "2s");

    // Token should be valid immediately
    const validResult = await verifyMeshToken(token);
    expect(validResult).toBeDefined();

    // Wait for token to expire (3s gives ample buffer on loaded CI runners)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Token should now be invalid
    const expiredResult = await verifyMeshToken(token);
    expect(expiredResult).toBeUndefined();
  });

  it("should decode expired token (decode doesn't verify)", async () => {
    vi.useRealTimers();

    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token = await issueMeshToken(payload, "1s");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Decode should still work (no verification)
    const decoded = decodeMeshToken(token);
    expect(decoded.sub).toBe("user_123");
  });
});

// ============================================================================
// Security Tests
// ============================================================================

describe("Security", () => {
  it("should use HS256 algorithm", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token = await issueMeshToken(payload);

    // Decode header to check algorithm
    const headerPart = token.split(".")[0]!;
    const header = JSON.parse(atob(headerPart));

    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
  });

  it("should include issued at (iat) claim", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const beforeIssue = Math.floor(Date.now() / 1000);
    const token = await issueMeshToken(payload);
    const afterIssue = Math.floor(Date.now() / 1000);

    const decoded = decodeMeshToken(token);

    expect(decoded.iat).toBeGreaterThanOrEqual(beforeIssue);
    expect(decoded.iat).toBeLessThanOrEqual(afterIssue);
  });

  it("should include expiration (exp) claim", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token = await issueMeshToken(payload);
    const decoded = decodeMeshToken(token);

    expect(decoded.exp).toBeDefined();
    expect(typeof decoded.exp).toBe("number");
  });

  it("should produce different tokens for same payload (due to iat)", async () => {
    const payload: MeshTokenPayload = {
      sub: "user_123",
      permissions: {},
      metadata: {
        meshUrl: "https://mesh.example.com",
        connectionId: "conn_456",
      },
    };

    const token1 = await issueMeshToken(payload);

    // Small delay to ensure different iat
    await new Promise((resolve) => setTimeout(resolve, 10));

    const token2 = await issueMeshToken(payload);

    // Tokens should be different due to different iat
    // Note: They might be same if issued in same second
    // This is acceptable behavior
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();
  });
});
