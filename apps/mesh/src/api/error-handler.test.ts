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

/** Stand-in for a better-call APIError: an Error whose `name` is "APIError"
 *  carrying `statusCode` + `body` (matches error.mjs in every bundled copy). */
function apiError(
  statusCode: number,
  body?: { message?: string; code?: string; cause?: unknown },
): Error {
  const err = new Error(body?.message ?? "api error");
  err.name = "APIError";
  Object.assign(err, { statusCode, body });
  return err;
}

describe("handleApiError APIError shape-mapping", () => {
  it("forwards a better-call APIError's status, message, and code", async () => {
    const res = handleApiError(
      apiError(404, {
        message: "Organization not found",
        code: "ORG_NOT_FOUND",
      }),
      fakeCtx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Organization not found",
      code: "ORG_NOT_FOUND",
    });
  });

  it("never forwards body.cause (may hold internals)", async () => {
    const res = handleApiError(
      apiError(400, { message: "bad", code: "X", cause: "secret-internal" }),
      fakeCtx,
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain("secret-internal");
    expect(json).toEqual({ error: "bad", code: "X" });
  });

  it("forwards a 5xx APIError's status (does not flatten to 500-generic)", () => {
    const res = handleApiError(apiError(503, { message: "down" }), fakeCtx);
    expect(res.status).toBe(503);
  });

  it("falls back to err.message and omits code when body is absent", async () => {
    const res = handleApiError(apiError(404), fakeCtx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "api error" });
  });

  it("does NOT match a foreign Error with statusCode but a different name", async () => {
    // e.g. the AI SDK's AI_APICallError carries statusCode but is not ours —
    // must 500, not relabel an upstream failure as a client-facing 4xx.
    const foreign = new Error("Incorrect API key provided");
    foreign.name = "AI_APICallError";
    Object.assign(foreign, { statusCode: 401 });
    const res = handleApiError(foreign, fakeCtx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal Server Error",
      message: "Incorrect API key provided",
    });
  });

  it("does not match out-of-range or non-numeric statusCodes (falls to 500)", () => {
    expect(handleApiError(apiError(399), fakeCtx).status).toBe(500);
    expect(handleApiError(apiError(600), fakeCtx).status).toBe(500);
    const stringCode = apiError(400);
    Object.assign(stringCode, { statusCode: "400" });
    expect(handleApiError(stringCode, fakeCtx).status).toBe(500);
  });
});
