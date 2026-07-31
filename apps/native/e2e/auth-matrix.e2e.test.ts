/**
 * local-api e2e: auth matrix.
 *
 * the native local-API contract tightens the daemon's
 * auth model: local-api gates EVERY route except `GET /health` (the daemon
 * leaves several GETs — `/idle`, `/scripts`, `/events` — unauthenticated,
 * see `daemon.e2e.test.ts`'s "serves no-auth GETs" case; that's a documented
 * divergence, not a gap). This suite asserts the 3-way matrix — no bearer,
 * wrong bearer, correct bearer — across a representative sample spanning
 * both KEPT (`/_sandbox/*`) and NEW (`/threads`, `/models`) route families.
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

interface Case {
  name: string;
  path: string;
  method?: string;
  body?: string;
}

const CASES: Case[] = [
  { name: "threads: list", path: "/threads", method: "GET" },
  { name: "threads: create", path: "/threads", body: toBody({ title: "x" }) },
  { name: "models: list", path: "/models", method: "GET" },
  {
    name: "sandbox: bash",
    path: "/_sandbox/bash",
    body: toBody({ command: "true" }),
  },
  { name: "sandbox: tasks list", path: "/_sandbox/tasks", method: "GET" },
  {
    name: "sandbox: dispatch",
    path: "/_sandbox/dispatch",
    body: toBody({ harnessId: "x", input: {} }),
  },
  {
    name: "sandbox: cancel run",
    path: "/_sandbox/runs/some-run",
    method: "DELETE",
  },
  // Correct-bearer answers 409 here (the standalone binary has no update
  // integration — `StartOptions.update: None`), which satisfies the
  // matrix's not-401 assertion; the 401 rows prove the route landed inside
  // the guard rather than as an unauthenticated top-level route.
  { name: "update: restart", path: "/_local/update/restart" },
];

describeLocalApi("local-api e2e: auth matrix", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  for (const c of CASES) {
    const method = c.method ?? "POST";

    it(`[${c.name}] ${method} ${c.path} without bearer → 401`, async () => {
      const res = await fetch(url(a, c.path), {
        method,
        headers: c.body ? { "Content-Type": "application/json" } : {},
        body: c.body,
      });
      expect(res.status).toBe(401);
    });

    it(`[${c.name}] ${method} ${c.path} with wrong bearer → 401`, async () => {
      const res = await fetch(url(a, c.path), {
        method,
        headers: {
          Authorization: "Bearer wrong-token-wrong-token-wrong-token",
          ...(c.body ? { "Content-Type": "application/json" } : {}),
        },
        body: c.body,
      });
      expect(res.status).toBe(401);
    });

    it(`[${c.name}] ${method} ${c.path} with correct bearer is not 401`, async () => {
      const res = await fetch(url(a, c.path), {
        method,
        headers: c.body ? jsonAuthHeaders() : authHeaders(),
        body: c.body,
      });
      expect(res.status).not.toBe(401);
    });
  }

  it("update restart answers 409 in the standalone binary (no update integration)", async () => {
    // The desktop shell injects UpdateHooks via StartOptions.update; the
    // standalone binary never does, so the route's documented contract here
    // is exactly 409 — never 404 (the route exists in both auth modes) and
    // never 202 (nothing can be staged).
    const res = await fetch(url(a, "/_local/update/restart"), {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(409);
  });

  it("an empty configured token rejects everything (fail closed)", async () => {
    // A daemon spawned without a token must never accept a blank `Bearer `.
    // Byte-parity with `auth.ts::requireToken`'s empty-token guard — this
    // suite doesn't spawn a token-less instance (LOCAL_API_TOKEN is always
    // set by startLocalApi), so this documents the invariant rather than
    // exercising it; Phase 1's unit-level port of `auth.ts` should carry the
    // corresponding test forward at that tier (see auth.test.ts precedent).
    const res = await fetch(url(a, "/threads"), {
      method: "GET",
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});
