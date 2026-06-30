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

  return app;
}
