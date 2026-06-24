import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayLine } from "../links/protocol/relay";
import {
  MAX_OUTBOX_BYTES,
  openInMemoryOutbox,
  openOutbox,
  type Outbox,
} from "./outbox";

let dir: string;
let outbox: Outbox;

const FENCE = "fence-A";
const RUN = "run_1";

function line(seq: number, delta: string): RelayLine {
  return {
    seq,
    event: {
      type: "ui-message-chunk",
      chunk: { type: "text-delta", id: "t1", delta },
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-"));
  outbox = openOutbox({ path: join(dir, "outbox.sqlite") });
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("outbox append/replay", () => {
  it("appends rows and replays them ordered by wireSeq from fromSeq", () => {
    outbox.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    outbox.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 2,
      lane: 2,
      line: line(2, "b"),
    });
    outbox.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 3,
      lane: 2,
      line: line(3, "c"),
    });

    const replayed = outbox.replay({
      runId: RUN,
      fenceToken: FENCE,
      fromSeq: 1,
    });
    expect(replayed.map((r) => r.wireSeq)).toEqual([1, 2, 3]);
    expect(replayed.map((r) => r.line.event)).toEqual([
      line(1, "a").event,
      line(2, "b").event,
      line(3, "c").event,
    ]);
  });

  it("replay from a higher fromSeq skips lower wireSeqs", () => {
    for (let s = 1; s <= 4; s++) {
      outbox.append({
        runId: RUN,
        fenceToken: FENCE,
        wireSeq: s,
        lane: 2,
        line: line(s, "x"),
      });
    }
    expect(
      outbox
        .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 3 })
        .map((r) => r.wireSeq),
    ).toEqual([3, 4]);
  });

  it("scopes replay by (runId, fenceToken) — a new fence epoch is isolated", () => {
    outbox.append({
      runId: RUN,
      fenceToken: "fence-A",
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    outbox.append({
      runId: RUN,
      fenceToken: "fence-B",
      wireSeq: 1,
      lane: 2,
      line: line(1, "b"),
    });

    const a = outbox.replay({ runId: RUN, fenceToken: "fence-A", fromSeq: 1 });
    const b = outbox.replay({ runId: RUN, fenceToken: "fence-B", fromSeq: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect((a[0]!.line.event as { chunk: { delta: string } }).chunk.delta).toBe(
      "a",
    );
    expect((b[0]!.line.event as { chunk: { delta: string } }).chunk.delta).toBe(
      "b",
    );
  });

  it("append is idempotent on (runId, fenceToken, wireSeq) — resends are no-ops", () => {
    outbox.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    outbox.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    expect(
      outbox.replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 }),
    ).toHaveLength(1);
  });

  it("enables WAL journal mode", () => {
    expect(outbox.journalMode()).toBe("wal");
  });
});

describe("outbox boot sweep (clear)", () => {
  it("clear() drops ALL rows so a fresh daemon boot starts un-wedged", () => {
    outbox.append({
      runId: "r1",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 1,
      line: line(1, "x"),
    });
    outbox.append({
      runId: "r2",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 1,
      line: line(1, "y"),
    });
    expect(
      outbox.replay({ runId: "r1", fenceToken: FENCE, fromSeq: 1 }),
    ).toHaveLength(1);

    outbox.clear();

    expect(
      outbox.replay({ runId: "r1", fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
    expect(
      outbox.replay({ runId: "r2", fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
  });
});

describe("outbox cap (loud-fail backstop)", () => {
  it("MAX_OUTBOX_BYTES is 512 MiB (stalled-publisher backstop, not the per-run limit)", () => {
    // Bumped from the legacy 64 MiB once rolling ackSeq truncation bounded the
    // outbox to the in-flight window; this is now only a stalled-publisher
    // backstop.
    expect(MAX_OUTBOX_BYTES).toBe(512 * 1024 * 1024);
  });

  it("throws loudly with the runId when a single run exceeds the per-run cap", () => {
    const small = openOutbox({ path: join(dir, "cap.sqlite"), maxBytes: 4096 });
    const big = "x".repeat(2048);
    small.append({
      runId: "run_big",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, big),
    });
    expect(() =>
      small.append({
        runId: "run_big",
        fenceToken: FENCE,
        wireSeq: 2,
        lane: 2,
        line: line(2, big),
      }),
    ).toThrow(/run_big.*outbox exceeded MAX_OUTBOX_BYTES/);
    small.close();
  });

  it("the over-cap row is NOT committed (the bound holds)", () => {
    const small = openOutbox({
      path: join(dir, "cap2.sqlite"),
      maxBytes: 4096,
    });
    const big = "x".repeat(2048);
    small.append({
      runId: "r",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, big),
    });
    try {
      small.append({
        runId: "r",
        fenceToken: FENCE,
        wireSeq: 2,
        lane: 2,
        line: line(2, big),
      });
    } catch {
      // expected
    }
    expect(
      small
        .replay({ runId: "r", fenceToken: FENCE, fromSeq: 1 })
        .map((x) => x.wireSeq),
    ).toEqual([1]);
    small.close();
  });

  it("enforces the per-daemon cap across multiple runs", () => {
    const small = openOutbox({
      path: join(dir, "cap3.sqlite"),
      maxBytes: 4096,
    });
    const big = "x".repeat(2048);
    small.append({
      runId: "run_a",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, big),
    });
    expect(() =>
      small.append({
        runId: "run_b",
        fenceToken: FENCE,
        wireSeq: 1,
        lane: 2,
        line: line(1, big),
      }),
    ).toThrow(/outbox exceeded MAX_OUTBOX_BYTES/);
    small.close();
  });
});

describe("outbox terminal truncation", () => {
  it("drops every row for a (runId, fenceToken) once the run is terminal-acked", () => {
    for (let s = 1; s <= 3; s++) {
      outbox.append({
        runId: RUN,
        fenceToken: FENCE,
        wireSeq: s,
        lane: 2,
        line: line(s, "x"),
      });
    }
    outbox.truncateRun({ runId: RUN, fenceToken: FENCE });
    expect(
      outbox.replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
  });

  it("truncating one run leaves other runs intact", () => {
    outbox.append({
      runId: "run_a",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    outbox.append({
      runId: "run_b",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "b"),
    });
    outbox.truncateRun({ runId: "run_a", fenceToken: FENCE });
    expect(
      outbox.replay({ runId: "run_a", fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
    expect(
      outbox.replay({ runId: "run_b", fenceToken: FENCE, fromSeq: 1 }),
    ).toHaveLength(1);
  });

  it("truncating frees per-daemon byte budget for the next run", () => {
    const small = openOutbox({
      path: join(dir, "trunc.sqlite"),
      maxBytes: 4096,
    });
    const big = "x".repeat(2048);
    small.append({
      runId: "run_a",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, big),
    });
    small.truncateRun({ runId: "run_a", fenceToken: FENCE });
    // Without truncation this would have tripped the per-daemon cap.
    expect(() =>
      small.append({
        runId: "run_b",
        fenceToken: FENCE,
        wireSeq: 1,
        lane: 2,
        line: line(1, big),
      }),
    ).not.toThrow();
    small.close();
  });
});

describe("outbox crash recovery (reopen DB → replay)", () => {
  it("replays the full prefix ordered by wireSeq after a close/reopen", () => {
    const path = join(dir, "recover.sqlite");
    const first = openOutbox({ path });
    first.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    first.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 2,
      lane: 1,
      line: line(2, "b"),
    });
    first.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 3,
      lane: 2,
      line: line(3, "c"),
    });
    first.close(); // simulate daemon death

    const reopened = openOutbox({ path });
    const replayed = reopened.replay({
      runId: RUN,
      fenceToken: FENCE,
      fromSeq: 1,
    });
    expect(replayed.map((r) => r.wireSeq)).toEqual([1, 2, 3]);
    expect(replayed.map((r) => r.lane)).toEqual([2, 1, 2]);
    expect(
      (replayed[0]!.line.event as { chunk: { delta: string } }).chunk.delta,
    ).toBe("a");
    reopened.close();
  });

  it("a truncated run stays gone after reopen", () => {
    const path = join(dir, "recover2.sqlite");
    const first = openOutbox({ path });
    first.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    first.truncateRun({ runId: RUN, fenceToken: FENCE });
    first.close();

    const reopened = openOutbox({ path });
    expect(
      reopened.replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
    reopened.close();
  });
});

describe("outbox parent directory creation", () => {
  it("creates a missing parent dir instead of failing to open the DB", () => {
    // The daemon opens the outbox at `${dataDir}/link/outbox.sqlite`, where the
    // `link/` parent does NOT pre-exist. bun:sqlite's `create: true` makes the
    // FILE but never the parent dir, so without an mkdir this throws
    // "unable to open database file" and crash-loops the daemon.
    const nested = join(dir, "link", "outbox.sqlite"); // `link/` does not exist
    let created: Outbox | undefined;
    expect(() => {
      created = openOutbox({ path: nested });
    }).not.toThrow();
    created!.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    expect(
      created!
        .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })
        .map((r) => r.wireSeq),
    ).toEqual([1]);
    created!.close();
  });
});

describe("outbox rolling ackSeq truncation", () => {
  it("drops rows with wireSeq <= ackSeq, keeping the unacked tail", () => {
    for (let s = 1; s <= 5; s++) {
      outbox.append({
        runId: RUN,
        fenceToken: FENCE,
        wireSeq: s,
        lane: 2,
        line: line(s, "x"),
      });
    }
    outbox.truncateUpToSeq({ runId: RUN, fenceToken: FENCE, ackSeq: 3 });
    expect(
      outbox
        .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })
        .map((r) => r.wireSeq),
    ).toEqual([4, 5]);
  });

  it("is scoped per (runId, fenceToken)", () => {
    outbox.append({
      runId: "run_a",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    outbox.append({
      runId: "run_b",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "b"),
    });
    outbox.truncateUpToSeq({ runId: "run_a", fenceToken: FENCE, ackSeq: 1 });
    expect(
      outbox.replay({ runId: "run_a", fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
    expect(
      outbox.replay({ runId: "run_b", fenceToken: FENCE, fromSeq: 1 }),
    ).toHaveLength(1);
  });
});

describe("openInMemoryOutbox (non-durable default for the relay)", () => {
  it("honors the same append/replay/cap/truncate contract without a file", () => {
    const mem = openInMemoryOutbox();
    mem.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    mem.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 2,
      lane: 1,
      line: line(2, "b"),
    });
    // idempotent re-append
    mem.append({
      runId: RUN,
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, "a"),
    });
    expect(
      mem
        .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })
        .map((r) => r.wireSeq),
    ).toEqual([1, 2]);
    mem.truncateRun({ runId: RUN, fenceToken: FENCE });
    expect(mem.replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })).toEqual(
      [],
    );
    mem.close();
  });

  it("enforces MAX_OUTBOX_BYTES via the same loud-fail path", () => {
    const mem = openInMemoryOutbox({ maxBytes: 4096 });
    const big = "x".repeat(2048);
    mem.append({
      runId: "r",
      fenceToken: FENCE,
      wireSeq: 1,
      lane: 2,
      line: line(1, big),
    });
    expect(() =>
      mem.append({
        runId: "r",
        fenceToken: FENCE,
        wireSeq: 2,
        lane: 2,
        line: line(2, big),
      }),
    ).toThrow(/outbox exceeded MAX_OUTBOX_BYTES/);
    mem.close();
  });
});
