/**
 * Standard test hooks for multi-pod scenarios.
 *
 * Call `registerTestHooks()` at the top of each scenario file. It waits for
 * every mesh pod to report /health/live in `beforeAll`, ensuring the test
 * body never races against a still-booting cluster. Idempotent — if the
 * cluster was brought up out of band (e.g. `docker compose up -d` ran
 * before `bun test`), the poll resolves immediately.
 */

import { beforeAll } from "bun:test";
import { waitReady } from "./cluster";

export function registerTestHooks(): void {
  beforeAll(async () => {
    await waitReady();
  }, 180_000);
}
