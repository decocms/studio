import { describe, expect, test } from "bun:test";
import { shouldServeNativeEntryInDev } from "./vite-native-entry-rules";

describe("native Vite entry routing", () => {
  test.each([
    ["/", "text/html"],
    ["/settings/profile", "text/html,application/xhtml+xml"],
    ["/fila?tab=chats", "text/html; charset=utf-8"],
    ["/index.html", "text/html"],
  ])("serves the native entry for GET navigation %s", (url, accept) => {
    expect(shouldServeNativeEntryInDev({ method: "GET", url, accept })).toBe(
      true,
    );
  });

  test("serves the native entry for HEAD navigation", () => {
    expect(
      shouldServeNativeEntryInDev({
        method: "HEAD",
        url: "/settings/profile",
        accept: "text/html",
      }),
    ).toBe(true);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "never rewrites %s requests",
    (method) => {
      expect(
        shouldServeNativeEntryInDev({
          method,
          url: "/settings/profile",
          accept: "text/html",
        }),
      ).toBe(false);
    },
  );

  test.each([
    "/api/fila/files/logo.png",
    "/mcp/connection",
    "/oauth-proxy/connection/callback",
    "/.well-known/oauth-authorization-server",
    "/org/fila",
    "/_auth/status",
    "/_local/session",
    "/_sandbox/events",
    "/threads/thread-id",
    "/models",
    "/health",
    "/metrics",
  ])("does not swallow reserved native path %s", (url) => {
    expect(
      shouldServeNativeEntryInDev({
        method: "GET",
        url,
        accept: "text/html",
      }),
    ).toBe(false);
  });

  test("matches path segments rather than lookalike prefixes", () => {
    for (const url of ["/apiary", "/organization", "/models-v2"]) {
      expect(
        shouldServeNativeEntryInDev({
          method: "GET",
          url,
          accept: "text/html",
        }),
      ).toBe(true);
    }
  });

  test("leaves non-navigation requests and malformed URLs unchanged", () => {
    expect(
      shouldServeNativeEntryInDev({
        method: "GET",
        url: "/settings/profile",
        accept: "application/json",
      }),
    ).toBe(false);
    expect(
      shouldServeNativeEntryInDev({
        method: "GET",
        url: "http://[",
        accept: "text/html",
      }),
    ).toBe(false);
  });
});
