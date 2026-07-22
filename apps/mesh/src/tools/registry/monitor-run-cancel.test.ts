import { describe, expect, it, mock } from "bun:test";
import type { MonitorRunEntity } from "@/storage/registry";
import { REGISTRY_MONITOR_RUN_CANCEL } from "./monitor-run-cancel";
import { cancelMonitorRun } from "./monitor-run-start";

function makeRun(overrides: Partial<MonitorRunEntity> = {}): MonitorRunEntity {
  return {
    id: "run-1",
    organization_id: "org-1",
    status: "running",
    config_snapshot: null,
    total_items: 0,
    tested_items: 0,
    passed_items: 0,
    failed_items: 0,
    skipped_items: 0,
    current_item_id: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCtx(orgId: string, findById: ReturnType<typeof mock>) {
  return {
    organization: { id: orgId },
    access: { check: mock(async () => {}) },
    storage: {
      registry: {
        monitorRuns: {
          findById,
          update: mock(async () => makeRun({ organization_id: orgId })),
        },
      },
    },
  } as unknown as Parameters<typeof REGISTRY_MONITOR_RUN_CANCEL.handler>[1];
}

describe("REGISTRY_MONITOR_RUN_CANCEL", () => {
  it("does not abort a running monitor run that belongs to a different organization", async () => {
    // findById is org-scoped in storage, so a run owned by another org
    // resolves to null here — the handler must reject before ever touching
    // the process-wide (org-agnostic) abort-controller map.
    const findById = mock(async () => null);
    const ctx = makeCtx("org-b", findById);

    await expect(
      REGISTRY_MONITOR_RUN_CANCEL.handler({ runId: "run-owned-by-org-a" }, ctx),
    ).rejects.toThrow(/not found/i);

    expect(findById).toHaveBeenCalledWith("org-b", "run-owned-by-org-a");
    expect(
      (
        ctx as unknown as {
          storage: {
            registry: { monitorRuns: { update: ReturnType<typeof mock> } };
          };
        }
      ).storage.registry.monitorRuns.update,
    ).not.toHaveBeenCalled();
  });

  it("cancels a run that belongs to the caller's organization", async () => {
    const findById = mock(async () => makeRun());
    const ctx = makeCtx("org-1", findById);

    const result = await REGISTRY_MONITOR_RUN_CANCEL.handler(
      { runId: "run-1" },
      ctx,
    );

    expect(result.run.status).toBe("running"); // from the mocked update stub
    expect(findById).toHaveBeenCalledWith("org-1", "run-1");
  });
});

describe("cancelMonitorRun", () => {
  it("returns false for an unknown runId without throwing", () => {
    expect(cancelMonitorRun("does-not-exist")).toBe(false);
  });
});
