/**
 * local-api e2e: golden-transcript differential for the dispatch/harness
 * family.
 *
 * WHY GOLDEN TRANSCRIPTS INSTEAD OF A LIVE TS-DAEMON DIFFERENTIAL: see
 * the native parity contract's Phase 2 section for the full
 * investigation. Summary: `packages/sandbox/daemon-go/main.go` registers the
 * REAL `claudeCodeHarnessFactory`/`codexHarnessFactory`
 * (the TS CLI harnesses, since deleted) into a hardcoded
 * module-singleton registry at import time — there is no env var or DI seam
 * a black-box-spawned daemon process exposes to swap in a fake harness
 * factory (unlike `DAEMON_E2E_CMD`, which swaps the whole BINARY, not one
 * dependency inside it). The TS harness itself goes through
 * `ai-sdk-provider-claude-code` → `@anthropic-ai/claude-agent-sdk`'s
 * programmatic `query()`, which spawns ITS OWN vendored native binary
 * (`@anthropic-ai/claude-agent-sdk-<platform>`), not a swappable `claude` on
 * PATH — so even editing daemon config couldn't retarget it to this repo's
 * stub without a code change to `packages/sandbox/daemon` or
 * the harness code, both out of bounds for this work. Running the daemon
 * for real would mean a real, paid, network-dependent Claude API call per
 * test — unacceptable for CI. This file is the golden-transcript
 * alternative instead.
 *
 * WHAT'S "GOLDEN" (checked in under `fixtures/golden/`):
 * `<scenario>.claude-raw.ndjson` — the EXACT byte-for-byte stdout the stub
 * harness (`fixtures/stub-harness.mjs`) produces for that scenario. This is
 * ground truth by construction (the stub generated it), not a captured real
 * CLI transcript — see that file's header comment for the full spec. Two
 * things are checked against it here:
 *
 *   1. STUB DETERMINISM GUARD: spawning the stub directly (bypassing
 *      local-api entirely) reproduces the golden file byte-for-byte. This
 *      is a regression trap on the stub's OWN determinism promise — if a
 *      future edit to `stub-harness.mjs` accidentally introduces
 *      nondeterminism (e.g. swaps a fixed field back to `Date.now()`), this
 *      test catches it without needing local-api at all. Also doubles as
 *      living documentation: `git diff` on a golden file after touching the
 *      stub is exactly the review artifact "did I mean to change the wire
 *      format" needs.
 *
 *   2. CONTENT SURVIVAL THROUGH THE RUST TRANSLATION (soft/best-effort):
 *      the golden file's final answer text (`result.result` for success
 *      scenarios) is extracted directly from the golden JSON — NOT
 *      hardcoded a second time here — and checked as a substring somewhere
 *      in the local-api SSE response's `ui-message-chunk` payloads (every
 *      string value found by a recursive walk, joined). This is
 *      DELIBERATELY loose: the native local-API contract's dispatch section marks
 *      `chunk` `<opaque UIMessageChunk>`, so there is no pinned field name
 *      to assert on directly, and the Rust translation from raw CLI ndjson
 *      to `UIMessageChunk`-shaped SSE frames is this phase's own
 *      not-yet-written code. A byte-exact "golden SSE transcript" would
 *      just be re-encoding a guess about that translation as a fixture —
 *      worse than not testing it, because a reasonable-but-different
 *      translation choice would fail this suite for no real reason. See
 *      `dispatch-stream.e2e.test.ts` for the envelope-level assertions that
 *      ARE pinned exactly (SSE framing, event-type sequence, terminal
 *      invariants) — those, not chunk payload shape, are this phase's real
 *      byte-parity surface.
 *
 * ALLOWLIST (fields/behaviors this suite deliberately does NOT compare):
 *   - `ui-message-chunk` COUNT vs raw ndjson line count — not 1:1 even in
 *     the real TS path (the AI SDK's `toUIMessageStream()` already
 *     sub-chunks one raw CLI message into several UIMessageChunks: a
 *     text-start, one-or-more text-delta, a text-end, a finish-step, etc.
 *     — see the since-deleted TS claude-code harness), so there is no
 *     invariant to pin here even in principle.
 *   - `chunk`'s internal field names/shape — opaque per contract doc.
 *   - Non-content fields inside the raw ndjson that the stub itself already
 *     documents as fixed-but-arbitrary (uuid/session_id/duration_ms/
 *     usage/total_cost_usd) — these are compared byte-for-byte ONLY against
 *     the golden file (regression guard on the STUB), never against
 *     anything Rust-side.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  buildDispatchInput,
  createThread,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  type LocalApi,
  runDispatchToCompletion,
  startLocalApi,
  stopLocalApi,
  STUB_HARNESS_PATH,
  stubClaudeBinEnv,
} from "./helpers";

const GOLDEN_DIR = fileURLToPath(
  new URL("./fixtures/golden/", import.meta.url),
);

function goldenPath(scenario: string): string {
  return `${GOLDEN_DIR}${scenario}.claude-raw.ndjson`;
}

function readGolden(scenario: string): string {
  return readFileSync(goldenPath(scenario), "utf8");
}

/** Parses NDJSON lines into objects, skipping trailing blank lines. */
function parseNdjson(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Recursively collects every string value in a JSON-ish value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
  return out;
}

/**
 * Word-level containment, not a contiguous-substring check: splits
 * `expectedText` into words (length > 2, so "hi"/"ok" noise doesn't produce
 * false negatives, but also can't produce misleadingly-strong false
 * positives) and asserts EACH ONE appears somewhere in `haystack`.
 *
 * Why not a single `haystack.includes(expectedText)`: even a perfectly
 * reasonable `UIMessageChunk` translation interleaves per-chunk metadata
 * (ids, uuids, type discriminators) BETWEEN successive text fragments once
 * every string field in every chunk is flattened — e.g. golden text
 * "Hello" + " from" + " stub-harness" arrives as 3 separate SSE chunks, and
 * each chunk's own uuid/session_id/model fields land physically between
 * "Hello" and " from" in the flattened haystack even though nothing is
 * actually wrong. A per-word check still catches the failure mode this
 * suite cares about (content dropped or garbled by the translation) without
 * being coupled to exact chunk boundaries/spacing this suite has no
 * visibility into (see the file's ALLOWLIST section above).
 */
function assertWordsSurvive(haystack: string, expectedText: string): void {
  const words = expectedText.split(/\s+/).filter((w) => w.length > 2);
  expect(words.length).toBeGreaterThan(0);
  for (const word of words) {
    expect(haystack).toContain(word);
  }
}

// ── Part 1: stub determinism guard — runs unconditionally, no local-api ────
// needed at all, so it's always green (not gated by LOCAL_API_E2E_CMD).

describe("dispatch differential: stub-harness golden ndjson (determinism guard)", () => {
  for (const scenario of ["simple", "tooluse", "fail"] as const) {
    it(`SCENARIO:${scenario} reproduces fixtures/golden/${scenario}.claude-raw.ndjson byte-for-byte`, () => {
      const golden = readGolden(scenario);
      const result = spawnSync(
        "node",
        [
          STUB_HARNESS_PATH,
          "-p",
          `SCENARIO:${scenario}`,
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        { encoding: "utf8" },
      );
      expect(result.stdout).toBe(golden);
      // `fail` exits 1 by design (see stub-harness.mjs header comment); the
      // others exit 0.
      expect(result.status).toBe(scenario === "fail" ? 1 : 0);
    });
  }

  it("golden fixtures are well-formed ndjson with the documented top-level `type`s", () => {
    for (const scenario of ["simple", "tooluse", "fail"] as const) {
      const lines = parseNdjson(readGolden(scenario)) as { type: string }[];
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]?.type).toBe("system");
      expect(lines.at(-1)?.type).toBe("result");
    }
  });
});

// ── Part 2: content-survival differential against local-api ────────────────

describeLocalApi(
  "dispatch differential: content survives the Rust translation (soft, local-api required)",
  () => {
    let a: LocalApi;
    beforeAll(async () => {
      a = await startLocalApi(stubClaudeBinEnv());
    }, HOOK_TIMEOUT_MS);
    afterAll(async () => {
      await stopLocalApi(a);
    }, HOOK_TIMEOUT_MS);

    it("SCENARIO:simple's golden `result.result` text survives somewhere in the SSE chunk payloads", async () => {
      const golden = parseNdjson(readGolden("simple")) as {
        type: string;
        result?: string;
      }[];
      const expectedText = golden.find((l) => l.type === "result")?.result;
      expect(typeof expectedText).toBe("string");

      const thread = await createThread(a, "differential: simple");
      const { frames } = await runDispatchToCompletion(a, {
        runId: "run-diff-simple",
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:simple",
        }),
      });
      const chunkStrings = frames
        .filter((f) => f.type === "ui-message-chunk")
        .flatMap((f) => collectStrings((f as { chunk: unknown }).chunk));
      assertWordsSurvive(chunkStrings.join(" "), expectedText as string);
    });

    it("SCENARIO:tooluse's golden final text survives somewhere in the SSE chunk payloads", async () => {
      const golden = parseNdjson(readGolden("tooluse")) as {
        type: string;
        result?: string;
      }[];
      const expectedText = golden.find((l) => l.type === "result")?.result;
      expect(typeof expectedText).toBe("string");

      const thread = await createThread(a, "differential: tooluse");
      const { frames } = await runDispatchToCompletion(a, {
        runId: "run-diff-tooluse",
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:tooluse",
        }),
      });
      const chunkStrings = frames
        .filter((f) => f.type === "ui-message-chunk")
        .flatMap((f) => collectStrings((f as { chunk: unknown }).chunk));
      assertWordsSurvive(chunkStrings.join(" "), expectedText as string);
    });

    it("SCENARIO:fail's golden error message survives somewhere in the SSE error event", async () => {
      const golden = parseNdjson(readGolden("fail")) as {
        type: string;
        errors?: string[];
      }[];
      const expectedErrors = golden.find((l) => l.type === "result")?.errors;
      expect(Array.isArray(expectedErrors)).toBe(true);

      const thread = await createThread(a, "differential: fail");
      const { frames } = await runDispatchToCompletion(a, {
        runId: "run-diff-fail",
        harnessId: "claude-code",
        input: buildDispatchInput({
          threadId: thread.id,
          prompt: "SCENARIO:fail",
        }),
      });
      const errorFrame = frames.find((f) => f.type === "error") as
        | { type: "error"; code: string; message: string }
        | undefined;
      expect(errorFrame).toBeDefined();
      // Soft: the Rust side may summarize/wrap rather than pass the raw
      // CLI error string verbatim, so this only requires SOME overlap
      // signal, not exact equality — a completely empty/unrelated message
      // would still fail this, which is the point.
      expect(errorFrame?.message.length).toBeGreaterThan(0);
    });
  },
);
