import { describe, expect, it } from "bun:test";
import app from "./mcp-consent";

const grant = (headers: Record<string, string>) =>
  app.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify({ client_id: "c1", scope: "openid" }),
  });

describe("POST /api/auth/custom/mcp-consent", () => {
  it("rejects a body a cross-origin form could send", async () => {
    expect((await grant({ "content-type": "text/plain" })).status).toBe(415);
    expect(
      (await grant({ "content-type": "application/x-www-form-urlencoded" }))
        .status,
    ).toBe(415);
  });

  it("rejects a request another site started", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await grant({
        "content-type": "application/json",
        "sec-fetch-site": site,
      });
      expect(res.status).toBe(403);
    }
  });

  it("requires a session", async () => {
    const res = await grant({
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/custom/mcp-consent", () => {
  it("requires a session", async () => {
    const res = await app.request(
      "/?client_id=c1&redirect_uri=https%3A%2F%2Fclient.example%2Fcb",
    );
    expect(res.status).toBe(401);
  });
});
