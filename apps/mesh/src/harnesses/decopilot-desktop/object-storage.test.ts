import { describe, expect, it } from "bun:test";
import { createRemoteObjectStorage } from "./object-storage";

describe("createRemoteObjectStorage", () => {
  it("calls the Studio object-storage API with injected auth headers", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: string;
      contentType: string | null;
    }> = [];
    const storage = createRemoteObjectStorage({
      baseUrl: "https://studio.example.com/api/acme/object-storage",
      headers: { Authorization: "Bearer session-key" },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const rawBody = init?.body;
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
          body:
            rawBody instanceof ArrayBuffer
              ? new TextDecoder().decode(rawBody)
              : String(rawBody ?? ""),
          contentType: headers.get("content-type"),
        });
        return Response.json({ key: "pages/home.html", etag: "etag-1" });
      },
    });

    await storage.put("pages/home.html", "<h1>Home</h1>", {
      contentType: "text/html; charset=utf-8",
    });

    expect(calls).toEqual([
      {
        url: "https://studio.example.com/api/acme/object-storage/pages/home.html",
        method: "PUT",
        authorization: "Bearer session-key",
        body: "<h1>Home</h1>",
        contentType: "text/html; charset=utf-8",
      },
    ]);
  });
});
