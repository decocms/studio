import {
  createFetch as createTunnelFetch,
  type TunnelFetch,
} from "@decocms/tunnel";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  encodeControlFrame,
  type ControlFrame,
} from "../api/routes/decopilot/control-frames";
import type { WorkItem } from "../links/link-work-item";
import { buildUserTunnelHostname } from "./tunnel-host";

export type { TunnelFetch };

export interface LinkWorkPublisher {
  publish(
    userSub: string,
    item: WorkItem,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface LinkControlPublisher {
  publishControlFrame(
    userSub: string,
    frame: ControlFrame,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
}

export type TunnelFetchFactory = (connection: NatsConnection) => TunnelFetch;

export interface CreateTunnelWorkPublisherDeps {
  getConnection: () => NatsConnection | null;
  createFetch?: TunnelFetchFactory;
}

const WORK_DISPATCH_IDLE_TIMEOUT_MS = 45_000;

export function createTunnelWorkPublisher(
  deps: CreateTunnelWorkPublisherDeps,
): LinkWorkPublisher {
  const makeFetch =
    deps.createFetch ??
    ((connection) =>
      createTunnelFetch({
        connection,
        idleTimeoutMs: WORK_DISPATCH_IDLE_TIMEOUT_MS,
      }));

  return {
    async publish(userSub, item, opts) {
      const connection = deps.getConnection();
      if (!connection) {
        throw new Error("link_unavailable: NATS unavailable");
      }

      const hostname = buildUserTunnelHostname(userSub);
      const tunnelFetch = makeFetch(connection);
      const response = await tunnelFetch(
        `tunnel://${hostname}/api/links/work`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item),
          signal: opts?.signal,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `tunnel work publish failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      await response.body?.cancel().catch(() => {});
    },
  };
}

export function createTunnelControlPublisher(
  deps: CreateTunnelWorkPublisherDeps,
): LinkControlPublisher {
  const makeFetch = deps.createFetch ?? createTunnelFetch;

  return {
    async publishControlFrame(userSub, frame, opts) {
      const connection = deps.getConnection();
      if (!connection) {
        throw new Error("link_unavailable: NATS unavailable");
      }

      const hostname = buildUserTunnelHostname(userSub);
      const tunnelFetch = makeFetch(connection);
      const response = await tunnelFetch(
        `tunnel://${hostname}/api/links/control`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeControlFrame(frame),
          signal: opts?.signal,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `tunnel control publish failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      await response.body?.cancel().catch(() => {});
    },
  };
}
