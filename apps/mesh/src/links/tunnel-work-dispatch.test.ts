import { describe, expect, test } from "bun:test";
import type { NatsConnection } from "@nats-io/nats-core";
import type { WorkItem } from "../links/link-work-item";
import { buildUserTunnelHostname } from "./tunnel-host";
import {
  createTunnelControlPublisher,
  createTunnelWorkPublisher,
  type TunnelFetch,
} from "./tunnel-work-dispatch";

const asNats = (connection: object): NatsConnection =>
  connection as NatsConnection;

const workItem = (): WorkItem => ({
  runId: "run-1",
  threadId: "thread-1",
  orgId: "org-1",
  userId: "user-1",
  runFenceToken: "fence-1",
  harnessInput: { agent: { id: "agent-1" } },
  orgSlug: "acme",
});

describe("createTunnelWorkPublisher", () => {
  test("posts work items to the hostname derived from userSub", async () => {
    const nats = asNats({});
    const calls: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const tunnelFetch: TunnelFetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("", { status: 202 });
    };
    const publisher = createTunnelWorkPublisher({
      getConnection: () => nats,
      createFetch: (connection) => {
        expect(connection).toBe(nats);
        return tunnelFetch;
      },
    });

    const item = workItem();
    await publisher.publish("user-1", item);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(
      `tunnel://${buildUserTunnelHostname("user-1")}/api/links/work`,
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(item);
  });

  test("NATS unavailable throws", async () => {
    const publisher = createTunnelWorkPublisher({
      getConnection: () => null,
      createFetch: () => async () => new Response(),
    });

    await expect(publisher.publish("user-1", workItem())).rejects.toThrow(
      "link_unavailable: NATS unavailable",
    );
  });

  test("throws when the tunnel command is rejected", async () => {
    const publisher = createTunnelWorkPublisher({
      getConnection: () => asNats({}),
      createFetch: () => async () => new Response("bad work", { status: 400 }),
    });

    await expect(publisher.publish("user-1", workItem())).rejects.toThrow(
      "tunnel work publish failed (400): bad work",
    );
  });

  test("a fetch rejection propagates", async () => {
    const publisher = createTunnelWorkPublisher({
      getConnection: () => asNats({}),
      createFetch: () => async () => {
        throw new Error("tunnel_no_first_frame");
      },
    });

    await expect(publisher.publish("user-1", workItem())).rejects.toThrow(
      "tunnel_no_first_frame",
    );
  });
});

describe("createTunnelControlPublisher", () => {
  test("posts control frames to the hostname derived from userSub", async () => {
    const calls: Array<{
      input: string | URL | Request;
      init?: RequestInit;
    }> = [];
    const publisher = createTunnelControlPublisher({
      getConnection: () => asNats({}),
      createFetch: () => async (input, init) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      },
    });

    await publisher.publishControlFrame("user-1", {
      type: "cancel",
      runId: "run-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(
      `tunnel://${buildUserTunnelHostname("user-1")}/api/links/control`,
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      type: "cancel",
      runId: "run-1",
    });
  });
});
