import { describe, expect, mock, test } from "bun:test";
import { Resend } from "./known-email-providers";

describe("Resend.sendEmail", () => {
  test("surfaces the response body when the API call fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response("invalid api key", {
          status: 401,
          statusText: "Unauthorized",
        }),
    ) as unknown as typeof fetch;

    try {
      const resend = new Resend("test-key");
      await expect(
        resend.sendEmail({
          to: "user@example.com",
          from: "noreply@example.com",
          subject: "hi",
          html: "<p>hi</p>",
        }),
      ).rejects.toThrow(/invalid api key/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
