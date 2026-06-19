import { describe, expect, test } from "bun:test";
import { createTunnelStatusProbe } from "./tunnel-status-probe";

const FAKE_CONN = {} as never;

describe("createTunnelStatusProbe", () => {
  test("offline when no NATS connection", async () => {
    const probe = createTunnelStatusProbe({ getConnection: () => null });
    expect(await probe("user-1")).toEqual({ online: false, capabilities: [] });
  });

  test("offline when getConnection throws (degrade, never propagate)", async () => {
    const probe = createTunnelStatusProbe({
      getConnection: () => {
        throw new Error("nats provider exploded");
      },
    });
    expect(await probe("user-1")).toEqual({ online: false, capabilities: [] });
  });

  test("online maps daemon body", async () => {
    const probe = createTunnelStatusProbe({
      getConnection: () => FAKE_CONN,
      createFetch: () => async () =>
        new Response(
          JSON.stringify({
            hostname: "laptop",
            capabilities: ["codex"],
            cliVersion: "1.0",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(await probe("user-1")).toEqual({
      online: true,
      hostname: "laptop",
      capabilities: ["codex"],
      cliVersion: "1.0",
    });
  });

  test("offline when the tunnel fetch throws (timeout / no daemon)", async () => {
    const probe = createTunnelStatusProbe({
      getConnection: () => FAKE_CONN,
      createFetch: () => async () => {
        throw new Error("tunnel_no_first_frame");
      },
    });
    expect(await probe("user-1")).toEqual({ online: false, capabilities: [] });
  });

  test("offline on non-2xx", async () => {
    const probe = createTunnelStatusProbe({
      getConnection: () => FAKE_CONN,
      createFetch: () => async () => new Response("nope", { status: 502 }),
    });
    expect(await probe("user-1")).toEqual({ online: false, capabilities: [] });
  });
});
