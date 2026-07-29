/**
 * local-api e2e: SSE framing smoke.
 *
 * KEPT — byte-parity family (see
 * the native local-API contract). Per-event-type wire
 * assertions for every `DaemonEventMap` member live in the daemon's own
 * suite (TODO §0.2); this is a smoke check that the SSE transport itself
 * (headers, `event:`/`data:` framing, first frame on connect) round-trips
 * through `LOCAL_API_E2E_CMD`.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  readSseUntil,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

describeLocalApi("local-api e2e: SSE framing", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  it("GET /_sandbox/events without bearer → 401 (no auth-free SSE)", async () => {
    const res = await fetch(url(a, "/_sandbox/events"));
    expect(res.status).toBe(401);
  });

  it("GET /_sandbox/events streams a lifecycle event first, framed as event:/data:", async () => {
    const { res, text } = await readSseUntil(url(a, "/_sandbox/events"), {
      headers: jsonAuthHeaders(),
      predicate: (acc) => acc.includes("event: lifecycle"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Every frame is `event: <name>\ndata: <json>\n\n` — assert the shape
    // around the first match rather than the whole accumulated buffer, since
    // later frames (status/tasks/branch/heartbeat) are allowed to interleave.
    const frameStart = text.indexOf("event: lifecycle");
    const frame = text.slice(frameStart, text.indexOf("\n\n", frameStart) + 2);
    expect(frame).toMatch(/^event: lifecycle\ndata: .+\n\n$/);
    const dataLine = frame.split("\n")[1]!;
    const payload = JSON.parse(dataLine.slice("data: ".length)) as {
      state: { phase: string };
    };
    expect(typeof payload.state.phase).toBe("string");
  });
});
