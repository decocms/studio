import { describe, expect, it } from "bun:test";
import { contentRevisionOf, servedLabelsReader } from "./serving";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CONTENT = "c".repeat(64);

describe("servedLabelsReader", () => {
  it("merges both sources per label, newest report first", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const read = servedLabelsReader(async (sql, params) => {
      seen.push(params);
      return sql.includes("otel_metrics_histogram")
        ? [
            { label: SHA_A, last_seen: "2026-10-14 10:00:00.000000000" },
            { label: CONTENT, last_seen: "2026-10-14 10:02:00.000000000" },
          ]
        : [{ label: SHA_A, last_seen: "2026-10-14 10:05:00.000000000" }];
    });
    expect(await read("acme", 15)).toEqual([
      { label: SHA_A, lastSeen: "2026-10-14T10:05:00.000Z" },
      { label: CONTENT, lastSeen: "2026-10-14T10:02:00.000Z" },
    ]);
    expect(seen).toEqual([
      { site: "acme", minutes: 15 },
      { site: "acme", minutes: 15 },
    ]);
  });

  it("uses the logs alone when the histogram is not readable (no grant yet)", async () => {
    const read = servedLabelsReader(async (sql) => {
      if (sql.includes("otel_metrics_histogram")) {
        throw new Error("ACCESS_DENIED");
      }
      return [{ label: SHA_B, last_seen: "2026-10-14 10:00:00" }];
    });
    expect(await read("acme", 15)).toEqual([
      { label: SHA_B, lastSeen: "2026-10-14T10:00:00.000Z" },
    ]);
  });

  it("is no signal (null) when neither source answers", async () => {
    const read = servedLabelsReader(async () => {
      throw new Error("connection refused");
    });
    expect(await read("acme", 15)).toBeNull();
  });

  it("ignores labels that are neither a commit nor a content revision", async () => {
    const read = servedLabelsReader(async () => [
      { label: "", last_seen: "2026-10-14 10:00:00" },
      { label: "dev", last_seen: "2026-10-14 10:00:00" },
      { label: SHA_A, last_seen: "not a date" },
    ]);
    expect(await read("acme", 15)).toEqual([]);
  });
});

describe("contentRevisionOf", () => {
  it("reads a release's blocks once per commit", async () => {
    let reads = 0;
    const blocks = async () => {
      reads++;
      return { Home: { title: "v1" } };
    };
    const sha = "d".repeat(40);
    const first = await contentRevisionOf(sha, blocks);
    expect(await contentRevisionOf(sha, blocks)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(reads).toBe(1);
  });
});
