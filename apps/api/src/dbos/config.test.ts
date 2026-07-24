import { describe, expect, it } from "bun:test";
import { buildDbosConfig } from "./config";
import { DBOS_WORKFLOW_VERSION } from "./workflow-version";

const base = {
  systemDatabaseUrl: "postgres://u:p@localhost:5432/db",
  poolSize: 5,
  executorID: "pod-1",
};

describe("buildDbosConfig", () => {
  it("pins applicationVersion to DBOS_WORKFLOW_VERSION", () => {
    expect(buildDbosConfig(base).applicationVersion).toBe(
      DBOS_WORKFLOW_VERSION,
    );
  });

  it("preserves the existing config fields", () => {
    const cfg = buildDbosConfig({ ...base, poolSize: 7 });
    expect(cfg.name).toBe("decocms");
    expect(cfg.systemDatabaseUrl).toBe(base.systemDatabaseUrl);
    expect(cfg.systemDatabaseSchemaName).toBe("dbos");
    expect(cfg.systemDatabasePoolSize).toBe(7);
    expect(cfg.runAdminServer).toBe(false);
    expect(cfg.executorID).toBe("pod-1");
  });

  it("omits listenQueues when undefined (the 'all' role)", () => {
    expect("listenQueues" in buildDbosConfig(base)).toBe(false);
  });

  it("includes listenQueues when provided", () => {
    const cfg = buildDbosConfig({ ...base, listenQueues: ["thread-gate"] });
    expect(cfg.listenQueues).toEqual(["thread-gate"]);
  });
});
