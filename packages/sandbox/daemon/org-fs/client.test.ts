import { describe, expect, it } from "bun:test";
import { OrgFsClient } from "./client";

describe("OrgFsClient.readResponse", () => {
  it("falls back (null) when the presigned host is unreachable", async () => {
    // The studio fetch is injected and presigns to a port nothing listens on —
    // a real refused connection, like a cluster pod given a localhost MinIO
    // URL. Found by the Stage-2 kind e2e: a propagated error here makes
    // rclone retry-loop forever instead of using the buffered path.
    const client = new OrgFsClient({
      baseUrl: "http://studio",
      orgSlug: "acme",
      volume: "skills",
      token: "t",
      fetch: async () =>
        Response.json({ url: "http://127.0.0.1:1/bucket/key?sig=x" }),
    });
    expect(await client.readResponse("f.txt")).toBeNull();
  });

  it("falls back (null) on non-http presigned URLs (dev data: storage)", async () => {
    const client = new OrgFsClient({
      baseUrl: "http://studio",
      orgSlug: "acme",
      volume: "skills",
      token: "t",
      fetch: async () => Response.json({ url: "data:text/plain;base64,aGk=" }),
    });
    expect(await client.readResponse("f.txt")).toBeNull();
  });
});
