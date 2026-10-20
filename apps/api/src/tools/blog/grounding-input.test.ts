import { describe, expect, mock, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { takeEvidence } from "./grounding-input";

/**
 * The uri arrives in a request body and the call that reads it also deletes it.
 * Without a prefix check a caller could name any object in its organization's
 * storage, have this fetch it into a model's context, and have it destroyed —
 * on a tool that declares `destructiveHint: false`.
 */
const storage = () => {
  const read = mock(async () => new TextEncoder().encode("raw tool output"));
  const removed: string[] = [];
  const ctx = {
    objectStorage: {
      getBytes: read,
      delete: mock(async (key: string) => {
        removed.push(key);
      }),
    },
  } as unknown as StudioContext;
  return { ctx, read, removed };
};

describe("takeEvidence", () => {
  test("reads what a grounding pass parked", async () => {
    const { ctx, read } = storage();
    const evidence = await takeEvidence(ctx, {
      report: "",
      evidenceUri: "studio-storage://blog-grounding/2026-10-15/abc.txt",
    });
    expect(evidence).toBe("raw tool output");
    expect(read).toHaveBeenCalled();
  });

  test("takes it away, since nobody reads one twice", async () => {
    const { ctx, removed } = storage();
    await takeEvidence(ctx, {
      report: "",
      evidenceUri: "studio-storage://blog-grounding/2026-10-15/abc.txt",
    });
    await Promise.resolve();
    expect(removed).toEqual(["blog-grounding/2026-10-15/abc.txt"]);
  });

  test("refuses a key outside the prefix, and deletes nothing", async () => {
    const { ctx, read, removed } = storage();
    const evidence = await takeEvidence(ctx, {
      report: "",
      evidenceUri: "studio-storage://web-search/someone-elses-result.md",
    });
    expect(evidence).toBe("");
    expect(read).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });

  test("a traversal dressed as a prefix is still outside it", async () => {
    const { ctx, read } = storage();
    await takeEvidence(ctx, {
      report: "",
      evidenceUri: "studio-storage://blog-grounding-elsewhere/x.txt",
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("a uri in another scheme is not a key at all", async () => {
    const { ctx, read } = storage();
    await takeEvidence(ctx, {
      report: "",
      evidenceUri: "https://example.com/blog-grounding/x.txt",
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("inline evidence never touches storage", async () => {
    const { ctx, read } = storage();
    const evidence = await takeEvidence(ctx, {
      report: "",
      evidence: "already here",
      evidenceUri: "studio-storage://blog-grounding/2026-10-15/abc.txt",
    });
    expect(evidence).toBe("already here");
    expect(read).not.toHaveBeenCalled();
  });

  test("nothing supplied is nothing read", async () => {
    const { ctx, read } = storage();
    expect(await takeEvidence(ctx, undefined)).toBe("");
    expect(read).not.toHaveBeenCalled();
  });
});
