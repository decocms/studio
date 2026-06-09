import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { handleApiError } from "./error-handler";

// Minimal stand-in for the Hono context — only `c.json` is used by the handler
// (the HTTPException path renders itself via getResponse()).
const fakeCtx = {
  json: (body: unknown, status?: number) =>
    Response.json(body, { status: status ?? 200 }),
} as unknown as Context;

describe("handleApiError", () => {
  it("preserves an HTTPException's status (not flattened to 500)", async () => {
    const res = handleApiError(
      new HTTPException(404, { message: "missing" }),
      fakeCtx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("missing");
  });

  it("preserves a 401 HTTPException", () => {
    const res = handleApiError(new HTTPException(401), fakeCtx);
    expect(res.status).toBe(401);
  });

  it("maps an unexpected Error to a 500 JSON body", async () => {
    const res = handleApiError(new Error("boom"), fakeCtx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal Server Error",
      message: "boom",
    });
  });

  it("maps a non-Error throw to a 500 with a generic message", async () => {
    const res = handleApiError("just a string", fakeCtx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal Server Error",
      message: "Unknown error",
    });
  });

  it("is honored end-to-end via app.onError (the realistic path)", async () => {
    const app = new Hono();
    app.onError(handleApiError);
    app.get("/boom", () => {
      throw new HTTPException(403, { message: "denied" });
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(403);
  });
});
