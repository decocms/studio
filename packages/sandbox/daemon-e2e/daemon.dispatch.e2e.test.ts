/**
 * Daemon conformance suite — DISPATCH + RUN CANCEL.
 *
 * Contract-only: a real harness run needs model providers/MCP and can't run in
 * CI, so we assert the deterministic gates that fire BEFORE the harness streams
 * (auth, body validation, cancel/tombstone). `/dispatch` and `/runs/:id` verify
 * the bearer in-handler (not via the shared requireToken middleware), so the
 * 401 cases are exercised here too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  authHeaders,
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);

describe("daemon e2e: dispatch", () => {
  let d: Daemon;
  beforeAll(async () => {
    d = await startDaemon();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopDaemon(d);
  }, HOOK_TIMEOUT_MS);

  it("POST /dispatch without bearer → 401", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: toBody({ harnessId: "x", input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /dispatch with invalid JSON → 400 bad_json", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "}{nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_json");
  });

  it("POST /dispatch with a non-string harnessId → 400 missing_harness_id", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: 123, input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_harness_id",
    );
  });

  it("POST /dispatch without runId → 400 missing_run_id", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: "claude-code", input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_run_id",
    );
  });

  it("POST /dispatch with a malformed input envelope → 400 bad_input", async () => {
    const res = await fetch(url(d, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({
        runId: "run-bad-input",
        harnessId: "claude-code",
        input: {},
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_input");
  });

  it("DELETE /runs/:id with bearer → 204 (idempotent for unknown runs)", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/unknown-run-id"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /runs/:id without bearer → 401", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/some-run"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /runs/ without a run id → 404", async () => {
    const res = await fetch(url(d, "/_sandbox/runs/"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
