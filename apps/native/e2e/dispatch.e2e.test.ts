/**
 * local-api e2e: dispatch pre-stream gates.
 *
 * KEPT — byte-parity family (see
 * the native local-API contract); the deep
 * parity assertions for this route live in the daemon's own
 * `daemon.dispatch.e2e.test.ts`, run against the Rust binary via
 * `DAEMON_E2E_CMD`. This suite pins the SAME gate ordering/bodies as a
 * `LOCAL_API_E2E_CMD`-reachable smoke check, since a full harness run needs
 * model providers/CLIs and can't run in CI here either.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

const toBody = (obj: unknown) => JSON.stringify(obj);

describeLocalApi("local-api e2e: dispatch gates", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  it("POST /_sandbox/dispatch without bearer → 401", async () => {
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: toBody({ harnessId: "x", input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /_sandbox/dispatch with invalid JSON → 400 bad_json", async () => {
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: "}{nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_json");
  });

  it("POST /_sandbox/dispatch with a non-string harnessId → 400 missing_harness_id", async () => {
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: 123, input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_harness_id",
    );
  });

  it("POST /_sandbox/dispatch without runId → 400 missing_run_id", async () => {
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: toBody({ harnessId: "claude-code", input: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "missing_run_id",
    );
  });

  it("POST /_sandbox/dispatch with a malformed input envelope → 400 bad_input", async () => {
    const res = await fetch(url(a, "/_sandbox/dispatch"), {
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

  it("DELETE /_sandbox/runs/:id with bearer → 204 (idempotent for unknown runs)", async () => {
    const res = await fetch(url(a, "/_sandbox/runs/unknown-run-id"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /_sandbox/runs/:id without bearer → 401", async () => {
    const res = await fetch(url(a, "/_sandbox/runs/some-run"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /_sandbox/runs/ without a run id → 404", async () => {
    const res = await fetch(url(a, "/_sandbox/runs/"), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
