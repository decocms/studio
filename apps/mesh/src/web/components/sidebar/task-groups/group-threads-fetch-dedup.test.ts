import { afterEach, describe, expect, it } from "bun:test";
import {
  fetchGroupProbeDeduped,
  fetchGroupPageDeduped,
  resetGroupThreadsFetchDedupForTests,
} from "./group-threads-fetch-dedup";
import { resetGroupThreadsFetchQueueForTests } from "./group-threads-fetch-queue";
import { shouldDeferGroupProbe } from "./group-show-more-identity";

afterEach(() => {
  resetGroupThreadsFetchDedupForTests();
  resetGroupThreadsFetchQueueForTests();
});

describe("shouldDeferGroupProbe", () => {
  it("waits for currentUserId when member is mine", () => {
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "mine",
        currentUserId: null,
      }),
    ).toBe(true);
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "mine",
        currentUserId: "user-1",
      }),
    ).toBe(false);
  });

  it("does not defer for all members", () => {
    expect(
      shouldDeferGroupProbe({
        type: "all",
        member: "all",
        currentUserId: null,
      }),
    ).toBe(false);
  });
});

describe("fetchGroupProbeDeduped", () => {
  it("runs the probe fn once for concurrent callers on the same identity", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      await Bun.sleep(5);
      return { serverHasMore: true };
    };

    const identity = "org|agent|vm-a|all|all|";
    const [a, b] = await Promise.all([
      fetchGroupProbeDeduped(identity, run),
      fetchGroupProbeDeduped(identity, run),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ serverHasMore: true });
    expect(b).toEqual({ serverHasMore: true });

    let callsAfterCache = 0;
    const cached = await fetchGroupProbeDeduped(identity, async () => {
      callsAfterCache++;
      return { serverHasMore: false };
    });
    expect(callsAfterCache).toBe(0);
    expect(cached).toEqual({ serverHasMore: true });
  });
});

describe("fetchGroupPageDeduped", () => {
  it("dedupes in-flight page fetches for the same identity offset and limit", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      await Bun.sleep(5);
      return { items: [] };
    };

    const identity = "org|agent|vm-a|all|all|user-1";
    const [a, b] = await Promise.all([
      fetchGroupPageDeduped(identity, 0, 10, run),
      fetchGroupPageDeduped(identity, 0, 10, run),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ items: [] });
    expect(b).toEqual({ items: [] });
  });

  it("does not dedupe different offsets", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return { ok: true };
    };

    const identity = "org|agent|vm-a|all|all|";
    await fetchGroupPageDeduped(identity, 0, 10, run);
    await fetchGroupPageDeduped(identity, 10, 10, run);
    expect(calls).toBe(2);
  });
});
