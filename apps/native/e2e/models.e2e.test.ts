/**
 * local-api e2e: GET /models shape.
 *
 * New surface — see
 * the native local-API contract. CLI
 * detection is environment-dependent (whatever the test runner's PATH has),
 * so this suite pins the WIRE SHAPE and invariants, not which harnesses are
 * "detected" on any given machine.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

interface ModelTier {
  id: string;
  label: string;
}

interface HarnessModels {
  harness: "claude-code" | "codex";
  detected: boolean;
  tiers: ModelTier[];
}

describeLocalApi("local-api e2e: models", () => {
  let a: LocalApi;
  beforeAll(async () => {
    a = await startLocalApi();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await stopLocalApi(a);
  }, HOOK_TIMEOUT_MS);

  it("GET /models returns exactly claude-code and codex, in that order", async () => {
    const res = await fetch(url(a, "/models"), { headers: jsonAuthHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { harnesses: HarnessModels[] };
    expect(body.harnesses.map((h) => h.harness)).toEqual([
      "claude-code",
      "codex",
    ]);
  });

  it("every harness entry has detected:boolean and tiers matching it", async () => {
    const res = await fetch(url(a, "/models"), { headers: jsonAuthHeaders() });
    const body = (await res.json()) as { harnesses: HarnessModels[] };
    for (const h of body.harnesses) {
      expect(typeof h.detected).toBe("boolean");
      if (!h.detected) {
        expect(h.tiers).toEqual([]);
      } else {
        expect(h.tiers.length).toBeGreaterThan(0);
        for (const tier of h.tiers) {
          expect(typeof tier.id).toBe("string");
          expect(tier.id.startsWith(`${h.harness}:`)).toBe(true);
          expect(typeof tier.label).toBe("string");
          expect(tier.label.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("no third harness (no decopilot, no Ollama/LM Studio probing in v1)", async () => {
    const res = await fetch(url(a, "/models"), { headers: jsonAuthHeaders() });
    const body = (await res.json()) as { harnesses: HarnessModels[] };
    expect(body.harnesses.length).toBe(2);
  });
});
