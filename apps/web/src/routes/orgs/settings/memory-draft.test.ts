import { describe, expect, test } from "bun:test";
import type {
  OrgFsConditionalWrite,
  OrgFsEntry,
  OrgFsWriteExpect,
} from "@/hooks/use-org-fs";
import { ABSENT, DraftSaver, type SaveStatus, versionOf } from "./memory-draft";

const entry = (contentHash: string): OrgFsEntry => ({
  path: "MEMORY.md",
  kind: "file",
  size: 1,
  updatedAt: "2026-10-06T00:00:00.000Z",
  contentHash,
});

function harness(answer: (body: string) => OrgFsConditionalWrite) {
  const writes: { body: string; expect: OrgFsWriteExpect | null }[] = [];
  const statuses: SaveStatus[] = [];
  const saved: string[] = [];
  let release = () => {};
  let gate: Promise<void> | null = null;
  const saver = new DraftSaver(
    async (body, expect) => {
      writes.push({ body, expect });
      if (gate) await gate;
      return answer(body);
    },
    (s) => statuses.push(s),
    (_entry, body) => saved.push(body),
  );
  const hold = () => {
    gate = new Promise((r) => (release = r));
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    saver,
    writes,
    statuses,
    saved,
    hold,
    release: () => release(),
    settle,
  };
}

describe("memory DraftSaver", () => {
  test("a save expects the version the edit started from, then the one it wrote", async () => {
    const h = harness((body) => ({ ok: true, entry: entry(`h-${body}`) }));
    h.saver.change("a", { version: versionOf(entry("h0")), generation: 1 });
    h.saver.flush();
    await h.settle();
    h.saver.change("ab", { version: versionOf(entry("h0")), generation: 1 });
    h.saver.flush();
    await h.settle();
    expect(h.writes).toEqual([
      { body: "a", expect: { contentHash: "h0" } },
      { body: "ab", expect: { contentHash: "h-a" } },
    ]);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  test("a reloaded editor replaces the base", async () => {
    const h = harness((body) => ({ ok: true, entry: entry(`h-${body}`) }));
    h.saver.change("a", { version: versionOf(entry("h0")), generation: 1 });
    h.saver.flush();
    await h.settle();
    h.saver.change("b", { version: versionOf(entry("deco")), generation: 2 });
    h.saver.flush();
    await h.settle();
    expect(h.writes.at(-1)?.expect).toEqual({ contentHash: "deco" });
  });

  test("a first write into a missing file requires it to still be missing", async () => {
    const h = harness(() => ({ ok: true, entry: entry("h1") }));
    h.saver.change("x", { version: ABSENT, generation: 1 });
    h.saver.flush();
    await h.settle();
    expect(h.writes[0]?.expect).toEqual({ absent: true });
  });

  test("a conflict holds the draft until the person keeps it", async () => {
    let conflict = true;
    const h = harness(() =>
      conflict
        ? { ok: false, reason: "conflict" }
        : { ok: true, entry: entry("h2") },
    );
    h.saver.change("mine", { version: versionOf(entry("h0")), generation: 1 });
    h.saver.flush();
    await h.settle();
    expect(h.statuses.at(-1)).toBe("conflict");

    h.saver.change("mine, edited", {
      version: versionOf(entry("h0")),
      generation: 1,
    });
    h.saver.flush();
    await h.settle();
    expect(h.writes).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("conflict");

    conflict = false;
    h.saver.flush(true);
    await h.settle();
    expect(h.writes.at(-1)).toEqual({ body: "mine, edited", expect: null });
    expect(h.statuses.at(-1)).toBe("saved");
  });

  test("typing during a save leaves the newer draft unsaved", async () => {
    const h = harness((body) => ({ ok: true, entry: entry(`h-${body}`) }));
    h.hold();
    h.saver.change("one", { version: versionOf(entry("h0")), generation: 1 });
    h.saver.flush();
    await h.settle();
    h.saver.change("one two", {
      version: versionOf(entry("h0")),
      generation: 1,
    });
    h.release();
    await h.settle();
    expect(h.saved).toEqual(["one"]);
    expect(h.statuses.at(-1)).toBe("dirty");
    h.saver.discard();
  });

  test("a discarded draft is never written", async () => {
    const h = harness(() => ({ ok: true, entry: entry("h3") }));
    h.saver.change("gone", { version: ABSENT, generation: 1 });
    h.saver.discard();
    h.saver.flush();
    await h.settle();
    expect(h.writes).toEqual([]);
  });
});
