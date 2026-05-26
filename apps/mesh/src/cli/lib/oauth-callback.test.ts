import { describe, expect, it } from "bun:test";
import { startOAuthCallbackServer } from "./oauth-callback";

describe("startOAuthCallbackServer", () => {
  it("redirects to successRedirectUrl when the browser hits the callback URL", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      const responsePromise = fetch(`${server.url}/?code=abc&state=nonce-1`, {
        redirect: "manual",
      });
      const callback = await server.waitForCallback();
      expect(callback).toEqual({ code: "abc" });
      const response = await responsePromise;
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://studio.example.com/cli/auth-success",
      );
    } finally {
      server.close();
    }
  });

  it("rejects waitForCallback when state does not match", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?code=abc&state=wrong`);
      await expect(server.waitForCallback()).rejects.toThrow(/state mismatch/i);
    } finally {
      server.close();
    }
  });

  it("rejects waitForCallback when code is missing", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?state=nonce-1`);
      await expect(server.waitForCallback()).rejects.toThrow(/missing code/i);
    } finally {
      server.close();
    }
  });

  it("returns 204 to follow-up requests after the promise has settled", async () => {
    const server = await startOAuthCallbackServer({
      expectedState: "nonce-1",
      successRedirectUrl: "https://studio.example.com/cli/auth-success",
    });
    try {
      await fetch(`${server.url}/?code=abc&state=nonce-1`, {
        redirect: "manual",
      });
      const callback = await server.waitForCallback();
      expect(callback).toEqual({ code: "abc" });

      const followUp = await fetch(`${server.url}/?code=other&state=nonce-1`);
      expect(followUp.status).toBe(204);
    } finally {
      server.close();
    }
  });
});
