import {
  createFetch as createTunnelFetch,
  type TunnelFetch,
} from "@decocms/tunnel";
import type { NatsConnection } from "@nats-io/nats-core";
import type { Capability } from "./protocol";
import { buildUserTunnelHostname } from "./tunnel-host";

export interface LinkStatus {
  online: boolean;
  hostname?: string;
  capabilities: Capability[];
  cliVersion?: string;
}

export type LinkStatusProbe = (userId: string) => Promise<LinkStatus>;

export type TunnelFetchFactory = (
  connection: NatsConnection,
  timeoutMs: number,
) => TunnelFetch;

export interface CreateTunnelStatusProbeDeps {
  getConnection: () => NatsConnection | null;
  /** Test seam; real impl builds a short-first-frame-timeout fetch. */
  createFetch?: TunnelFetchFactory;
  /** First-frame timeout so an offline daemon fails fast. Default 2000ms. */
  timeoutMs?: number;
}

const OFFLINE: LinkStatus = { online: false, capabilities: [] };

const defaultFactory: TunnelFetchFactory = (connection, timeoutMs) =>
  createTunnelFetch({ connection, firstFrameTimeoutMs: timeoutMs });

export function createTunnelStatusProbe(
  deps: CreateTunnelStatusProbeDeps,
): LinkStatusProbe {
  const makeFetch = deps.createFetch ?? defaultFactory;
  const timeoutMs = deps.timeoutMs ?? 2000;

  return async (userId) => {
    try {
      // getConnection() is inside the try on purpose: a throwing provider (or
      // a NATS connection that throws while building the tunnel fetch) must
      // degrade to OFFLINE, never propagate a 500 to /api/links/me.
      const connection = deps.getConnection();
      if (!connection) return OFFLINE;

      const hostname = buildUserTunnelHostname(userId);
      const tunnelFetch = makeFetch(connection, timeoutMs);
      const res = await tunnelFetch(`tunnel://${hostname}/api/links/status`, {
        method: "GET",
      });
      if (!res.ok) return OFFLINE;
      const body = (await res.json()) as {
        hostname?: string;
        capabilities?: Capability[];
        cliVersion?: string;
      };
      return {
        online: true,
        hostname: body.hostname,
        capabilities: body.capabilities ?? [],
        cliVersion: body.cliVersion,
      };
    } catch {
      return OFFLINE;
    }
  };
}
