import { expect, test } from "../fixtures/test";

// KEDA hits the API process directly (the worker Service), not the web origin
// the rest of the suite uses — `/dbos-queue-depth` is not under `/api`, so the
// Vite proxy would answer it with index.html.
const apiOrigin = `http://localhost:${process.env.PORT ?? "3000"}`;

// The ScaledObject in deco-apps-cd reads these two field NAMES out of this
// unauthenticated endpoint (`valueLocation: queue_length` / `in_flight`). A
// rename here is silent: KEDA's scaler errors and the worker stops scaling,
// which is how a pod holding a live run got scaled in. So the shape is
// asserted, not the numbers.
test("dbos queue depth reports both backlog and in-flight work", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext({ baseURL: apiOrigin });

  const res = await ctx.get("/dbos-queue-depth/decopilot-hosted-harness");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({
    queue_length: expect.any(Number),
    in_flight: expect.any(Number),
  });

  const unknown = await ctx.get("/dbos-queue-depth/not-a-queue");
  expect(unknown.status()).toBe(404);
});
