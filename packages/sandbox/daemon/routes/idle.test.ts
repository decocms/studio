import { describe, expect, it } from "bun:test";
import {
  __resetActivityForTests,
  bumpActivity,
  markClaimed,
} from "../activity";
import { makeIdleHandler } from "./idle";

describe("makeIdleHandler", () => {
  it("returns lastActivityAt + idleMs as JSON with CORS", async () => {
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    __resetActivityForTests(t0);
    bumpActivity(t0);
    const handler = makeIdleHandler();
    const resp = handler();
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await resp.json()) as {
      lastActivityAt: string;
      idleMs: number;
      claimed: boolean;
    };
    expect(body.lastActivityAt).toBe(new Date(t0).toISOString());
    expect(typeof body.idleMs).toBe("number");
    expect(body.idleMs).toBeGreaterThanOrEqual(0);
  });

  it("claimed=false until markClaimed() is called", async () => {
    __resetActivityForTests();
    const handler = makeIdleHandler();
    const before = (await handler().json()) as { claimed: boolean };
    expect(before.claimed).toBe(false);
    markClaimed();
    const after = (await handler().json()) as { claimed: boolean };
    expect(after.claimed).toBe(true);
    // Reset for other tests.
    __resetActivityForTests();
  });
});
