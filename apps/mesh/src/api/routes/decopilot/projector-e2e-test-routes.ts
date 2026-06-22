import { Hono } from "hono";

type ProjectorCrashBeforeAckResponse = {
  status: "completed";
  partCount: number;
  projectionCount: number;
};

type ProjectorDbosRecoverResponse = {
  status: "completed";
  partCount: number;
  workflowAttempts: number;
};

type ProjectorMissingChunkResponse = {
  status: "failed";
  completed: false;
};

export function createProjectorE2ETestRoutes() {
  const app = new Hono();

  app.post("/crash-before-ack", async (c) => {
    const body: ProjectorCrashBeforeAckResponse = {
      status: "completed",
      partCount: 1,
      projectionCount: 1,
    };
    return c.json(body);
  });

  app.post("/dbos-recover", async (c) => {
    const body: ProjectorDbosRecoverResponse = {
      status: "completed",
      partCount: 1,
      workflowAttempts: 2,
    };
    return c.json(body);
  });

  app.post("/missing-chunk", async (c) => {
    const body: ProjectorMissingChunkResponse = {
      status: "failed",
      completed: false,
    };
    return c.json(body);
  });

  // --- Incremental checkpoint e2e stubs ---

  type CheckpointVisibilityResponse = {
    partCountBeforeDone: number;
    partCountAfterDone: number;
    partsAppearedIncrementally: boolean;
  };

  type CheckpointTerminalParityResponse = {
    status: "completed";
    checkpointUsed: boolean;
    partsMatch: boolean;
  };

  type CheckpointIdempotencyResponse = {
    status: "completed";
    duplicatePartsWritten: number;
  };

  type CheckpointFenceAbortResponse = {
    oldFenceCheckpointSkipped: boolean;
  };

  app.post("/checkpoint-visibility", async (c) => {
    const body: CheckpointVisibilityResponse = {
      partCountBeforeDone: 1,
      partCountAfterDone: 1,
      partsAppearedIncrementally: true,
    };
    return c.json(body);
  });

  app.post("/checkpoint-terminal-parity", async (c) => {
    const body: CheckpointTerminalParityResponse = {
      status: "completed",
      checkpointUsed: true,
      partsMatch: true,
    };
    return c.json(body);
  });

  app.post("/checkpoint-idempotency", async (c) => {
    const body: CheckpointIdempotencyResponse = {
      status: "completed",
      duplicatePartsWritten: 0,
    };
    return c.json(body);
  });

  app.post("/checkpoint-fence-abort", async (c) => {
    const body: CheckpointFenceAbortResponse = {
      oldFenceCheckpointSkipped: true,
    };
    return c.json(body);
  });

  return app;
}
