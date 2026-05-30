import { describe, expect, it } from "bun:test";
import { makeHealthHandler } from "./health";

describe("makeHealthHandler", () => {
  const cfg = { daemonBootId: "boot-xyz" } as const;

  it("returns ready:false, bootId, orchestrator pre-config", async () => {
    const h = makeHealthHandler({
      config: cfg,
      getReady: () => false,
      getOrchestrator: () => ({ running: false, pending: 0 }),
      getConfigured: () => false,
    });
    const res = h();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      bootId: string;
      configured: boolean;
      orchestrator: { running: boolean; pending: number };
      setup: { running: boolean; done: boolean };
    };
    expect(body.ready).toBe(false);
    expect(body.bootId).toBe("boot-xyz");
    expect(body.configured).toBe(false);
    expect(body.orchestrator).toEqual({ running: false, pending: 0 });
    expect(body.setup).toEqual({ running: false, done: true });
  });

  it("flips ready:true once probe succeeds", async () => {
    let ready = false;
    const h = makeHealthHandler({
      config: cfg,
      getReady: () => ready,
      getOrchestrator: () => ({ running: false, pending: 0 }),
      getConfigured: () => true,
    });
    expect(((await h().json()) as { ready: boolean }).ready).toBe(false);
    ready = true;
    expect(((await h().json()) as { ready: boolean }).ready).toBe(true);
  });

  it("response has JSON content-type", () => {
    const h = makeHealthHandler({
      config: cfg,
      getReady: () => true,
      getOrchestrator: () => ({ running: false, pending: 0 }),
      getConfigured: () => true,
    });
    expect(h().headers.get("content-type")).toContain("application/json");
  });
});
