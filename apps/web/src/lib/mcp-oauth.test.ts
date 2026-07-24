import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { handleOAuthCallback } from "./mcp-oauth";

describe("handleOAuthCallback", () => {
  // Skip if window is not defined (running in Node.js/Bun without DOM)
  const isBrowser = typeof globalThis.window !== "undefined";

  // Mock storage
  const mockStorage: Record<string, string> = {};

  // Create a minimal window mock for server-side testing
  const createWindowMock = () => ({
    location: {
      search: "",
      origin: "http://localhost:3000",
    },
    opener: null as Window | null,
    localStorage: {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        for (const key in mockStorage) {
          delete mockStorage[key];
        }
      },
    },
  });

  let windowMock: ReturnType<typeof createWindowMock>;

  beforeEach(() => {
    windowMock = createWindowMock();

    // Set up globalThis.window if not in browser
    if (!isBrowser) {
      (globalThis as unknown as { window: unknown }).window = windowMock;
    }

    // Clear mock storage
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
  });

  afterEach(() => {
    // Clean up window mock
    if (!isBrowser) {
      delete (globalThis as unknown as { window?: unknown }).window;
    }

    // Clear mock storage
    for (const key in mockStorage) {
      delete mockStorage[key];
    }
  });

  const mockLocation = (search: string) => {
    windowMock.location = {
      search,
      origin: "http://localhost:3000",
    };
    if (!isBrowser) {
      (globalThis as unknown as { window: typeof windowMock }).window =
        windowMock;
    }
  };

  const mockOpener = (postMessage: ReturnType<typeof mock> | null) => {
    if (postMessage === null) {
      windowMock.opener = null;
    } else {
      windowMock.opener = {
        postMessage,
        closed: false,
      } as unknown as Window;
    }
    if (!isBrowser) {
      (globalThis as unknown as { window: typeof windowMock }).window =
        windowMock;
    }
  };

  describe("with window.opener available", () => {
    test("posts message to opener with code and state", async () => {
      mockLocation("?code=auth_code_123&state=state_abc");
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(true);
      expect(postMessageMock).toHaveBeenCalledTimes(1);

      const callArgs = postMessageMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [message, origin] = callArgs as unknown as [unknown, string];
      expect(message).toEqual({
        type: "mcp:oauth:callback",
        success: true,
        code: "auth_code_123",
        state: "state_abc",
      });
      expect(origin).toBe("http://localhost:3000");
    });

    test("handles error parameter from OAuth provider", async () => {
      mockLocation("?error=access_denied&error_description=User%20denied");
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(false);
      expect(result.error).toBe("User denied");
      expect(postMessageMock).toHaveBeenCalledTimes(1);

      const callArgs = postMessageMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [message] = callArgs as unknown as [unknown];
      expect(message).toEqual({
        type: "mcp:oauth:callback",
        success: false,
        error: "User denied",
      });
    });

    test("handles missing code parameter", async () => {
      mockLocation("?state=state_abc");
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing code or state parameter");
    });

    test("handles missing state parameter", async () => {
      mockLocation("?code=auth_code_123");
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing code or state parameter");
    });
  });

  describe("with window.opener not available (localStorage fallback)", () => {
    test("returns error when opener is null and no state for localStorage key", async () => {
      mockLocation("?code=auth_code_123");
      mockOpener(null);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Missing code or state parameter");
    });
  });

  describe("state decoding (deco.cx wrapped state)", () => {
    test("decodes base64 wrapped state with clientState", async () => {
      // Create a wrapped state like deco.cx does
      const wrappedState = btoa(
        JSON.stringify({
          clientState: "original_state_123",
          otherData: "ignored",
        }),
      );

      mockLocation(`?code=auth_code&state=${encodeURIComponent(wrappedState)}`);
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(true);

      const callArgs = postMessageMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [message] = callArgs as unknown as [unknown];
      expect((message as Record<string, unknown>).state).toBe(
        "original_state_123",
      );
    });

    test("uses state as-is when not valid base64 JSON", async () => {
      mockLocation("?code=auth_code&state=plain_state");
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(true);

      const callArgs = postMessageMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [message] = callArgs as unknown as [unknown];
      expect((message as Record<string, unknown>).state).toBe("plain_state");
    });

    test("uses state as-is when base64 but not JSON", async () => {
      const invalidJson = btoa("not json");
      mockLocation(`?code=auth_code&state=${encodeURIComponent(invalidJson)}`);
      const postMessageMock = mock(() => {});
      mockOpener(postMessageMock);

      const result = await handleOAuthCallback();

      expect(result.success).toBe(true);

      const callArgs = postMessageMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const [message] = callArgs as unknown as [unknown];
      // Should use the original encoded state
      expect((message as Record<string, unknown>).state).toBe(invalidJson);
    });
  });
});
