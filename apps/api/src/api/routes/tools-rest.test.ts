import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../hono-env";
import { createToolsRestRoutes } from "./tools-rest";

const app = new Hono<Env>().route("/tools", createToolsRestRoutes());

const call = (headers: Record<string, string>) =>
  app.request("/tools/ORGANIZATION_GET", {
    method: "POST",
    headers,
    body: "{}",
  });

describe("POST /tools/:toolName", () => {
  it("rejects bodies a cross-origin form or simple fetch can send", async () => {
    for (const type of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      expect((await call({ "content-type": type })).status).toBe(415);
    }
    expect((await call({})).status).toBe(415);
  });

  it("lets a JSON call through to tool dispatch", async () => {
    const res = await app.request("/tools/NOT_A_TOOL", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
