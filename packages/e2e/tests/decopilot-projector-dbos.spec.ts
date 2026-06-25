import { test, expect } from "@playwright/test";

test.describe("DBOS resumable projector", () => {
  test.skip(
    process.env.DECOPILOT_PROJECTOR_DBOS_E2E !== "1",
    "requires real Postgres, NATS JetStream, DBOS launch, and multi-pod controls",
  );

  test("scheduler crash before done ack redelivers and projects once", async ({
    request,
  }) => {
    const res = await request.post(
      "/__test/decopilot/projector/crash-before-ack",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.partCount).toBeGreaterThan(0);
    expect(body.projectionCount).toBe(1);
  });

  test("DBOS worker crash mid-projection recovers and completes", async ({
    request,
  }) => {
    const res = await request.post("/__test/decopilot/projector/dbos-recover");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.partCount).toBeGreaterThan(0);
    expect(body.workflowAttempts).toBeGreaterThan(1);
  });

  test("retention loss marks failed instead of completed", async ({
    request,
  }) => {
    const res = await request.post("/__test/decopilot/projector/missing-chunk");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.completed).toBe(false);
  });

  test("checkpoint pass writes parts before done", async ({ request }) => {
    const res = await request.post(
      "/__test/decopilot/projector/checkpoint-visibility",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.partsAppearedIncrementally).toBe(true);
    expect(body.partCountBeforeDone).toBeGreaterThan(0);
  });

  test("terminal projection parity: done pass result matches non-incremental baseline", async ({
    request,
  }) => {
    const res = await request.post(
      "/__test/decopilot/projector/checkpoint-terminal-parity",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.partsMatch).toBe(true);
  });

  test("checkpoint projections are idempotent — no duplicate parts", async ({
    request,
  }) => {
    const res = await request.post(
      "/__test/decopilot/projector/checkpoint-idempotency",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.duplicatePartsWritten).toBe(0);
  });

  test("fence change aborts in-flight checkpoint for old fence", async ({
    request,
  }) => {
    const res = await request.post(
      "/__test/decopilot/projector/checkpoint-fence-abort",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.oldFenceCheckpointSkipped).toBe(true);
  });
});
