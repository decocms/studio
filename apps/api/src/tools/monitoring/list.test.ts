import { describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/core/access-control";

// The real module pulls in the whole OpenTelemetry provider graph; the flush is
// a no-op when no exporter is configured, so stub it out.
const flushMonitoringData = mock(async () => {});
mock.module("@/observability", () => ({ flushMonitoringData }));

const { MONITORING_LOGS_LIST } = await import("./list");

type Handler = typeof MONITORING_LOGS_LIST.handler;
type Ctx = Parameters<Handler>[1];

function makeCtx(check: () => Promise<void>) {
  const query = mock(async (_filters: { organizationId: string }) => ({
    logs: [],
    total: 0,
  }));
  const ctx = {
    organization: { id: "org-1" },
    access: { check: mock(check) },
    storage: { monitoring: { query } },
  } as unknown as Ctx;
  return { ctx, query };
}

const INPUT = { limit: 20, offset: 0 } as Parameters<Handler>[0];

describe("MONITORING_LOGS_LIST", () => {
  it("authorizes before reading, so a denied caller never sees another org's logs", async () => {
    // `POST /api/:org/tools/:toolName` carries no auth middleware and
    // `resolveOrgFromPath` sets `ctx.organization` even for anonymous callers,
    // so the handler's own `access.check()` is the whole gate here.
    const { ctx, query } = makeCtx(async () => {
      throw new ForbiddenError("Access denied to: MONITORING_LOGS_LIST");
    });

    await expect(MONITORING_LOGS_LIST.handler(INPUT, ctx)).rejects.toThrow(
      ForbiddenError,
    );

    expect(ctx.access.check).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("queries scoped to the caller's organization once authorized", async () => {
    const { ctx, query } = makeCtx(async () => {});

    const result = await MONITORING_LOGS_LIST.handler(INPUT, ctx);

    expect(result).toEqual({ logs: [], total: 0, offset: 0, limit: 20 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatchObject({
      organizationId: "org-1",
    });
  });
});
