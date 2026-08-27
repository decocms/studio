import { describe, it, expect, vi, mock, beforeEach } from "bun:test";
import type { TokenRefreshResult } from "./refresh-access-token";
import type { DownstreamToken } from "../storage/types";
import type { DownstreamTokenStorage } from "../storage/downstream-token";

// Narrow justified mock per TESTING.md: refreshAccessToken makes a real HTTP call.
const mockRefreshAccessToken =
  vi.fn<(...args: unknown[]) => Promise<TokenRefreshResult>>();
mock.module("./refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const { refreshAndStore, clearRefreshBackoff } = await import(
  "./token-refresh"
);

const baseToken: DownstreamToken = {
  id: "dtok_1",
  connectionId: "conn_persist_fail",
  accessToken: "old-access",
  refreshToken: "refresh-1",
  scope: null,
  expiresAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  clientId: "client-1",
  clientSecret: null,
  tokenEndpoint: "https://idp.example.com/token",
};

function fakeStorage(overrides: Partial<DownstreamTokenStorage>) {
  return {
    get: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    isExpired: vi.fn(),
    ...overrides,
  } as unknown as DownstreamTokenStorage;
}

beforeEach(() => {
  mockRefreshAccessToken.mockReset();
  clearRefreshBackoff();
});

describe("refreshAndStore — storage failures don't throw", () => {
  it("returns the freshly refreshed token instead of discarding it when persisting fails", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      success: true,
      accessToken: "new-access",
      expiresIn: 3600,
    });
    const storage = fakeStorage({
      upsert: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });

    await expect(refreshAndStore(baseToken, storage)).resolves.toBe(
      "new-access",
    );
  });

  it("returns null instead of rejecting when deleting a dead token fails", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      success: false,
      permanent: true,
      error: "invalid_grant",
    });
    const storage = fakeStorage({
      delete: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });

    await expect(refreshAndStore(baseToken, storage)).resolves.toBeNull();
  });
});
