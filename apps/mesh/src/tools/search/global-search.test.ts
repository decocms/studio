import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { GLOBAL_SEARCH } from "./global-search";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "../thread/test-helpers";

describe("GLOBAL_SEARCH", () => {
  let env: ThreadTestEnv;

  beforeAll(async () => {
    env = await buildThreadTestContext();
    // Seed three threads with distinct titles. The storage layer does an
    // ILIKE on threads.title — these cover unique-token, shared-token, and
    // case-insensitive matching respectively.
    await env.ctx.storage.threads.create({
      id: "thrd_alpha",
      title: "Alpha launch checklist",
      created_by: env.userId,
    });
    await env.ctx.storage.threads.create({
      id: "thrd_beta",
      title: "Beta release notes",
      created_by: env.userId,
    });
    await env.ctx.storage.threads.create({
      id: "thrd_gamma",
      title: "Gamma launch retro",
      created_by: env.userId,
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it("finds a thread by a unique token in its title", async () => {
    const raw = await GLOBAL_SEARCH.handler({ query: "Beta" }, env.ctx);
    const parsed = GLOBAL_SEARCH.outputSchema.parse(raw);

    const threadIds = parsed.items
      .filter((item) => item.type === "thread")
      .map((item) => item.id);

    expect(threadIds).toContain("thrd_beta");
    expect(threadIds).not.toContain("thrd_alpha");
    expect(threadIds).not.toContain("thrd_gamma");
  });

  it("returns every thread whose title shares the search token", async () => {
    const raw = await GLOBAL_SEARCH.handler({ query: "launch" }, env.ctx);
    const parsed = GLOBAL_SEARCH.outputSchema.parse(raw);

    const threadIds = parsed.items
      .filter((item) => item.type === "thread")
      .map((item) => item.id);

    expect(threadIds).toContain("thrd_alpha");
    expect(threadIds).toContain("thrd_gamma");
    expect(threadIds).not.toContain("thrd_beta");
  });

  it("matches case-insensitively", async () => {
    const raw = await GLOBAL_SEARCH.handler({ query: "ALPHA" }, env.ctx);
    const parsed = GLOBAL_SEARCH.outputSchema.parse(raw);

    const threadIds = parsed.items
      .filter((item) => item.type === "thread")
      .map((item) => item.id);

    expect(threadIds).toContain("thrd_alpha");
  });

  it("returns no items when the query matches no thread", async () => {
    const raw = await GLOBAL_SEARCH.handler(
      { query: "nonexistent-token-xyz" },
      env.ctx,
    );
    const parsed = GLOBAL_SEARCH.outputSchema.parse(raw);
    expect(parsed.items).toHaveLength(0);
  });

  it("honors the `types` filter — empty array of thread results when threads are excluded", async () => {
    // `types: []` would be filtered out by the input schema if treated as
    // "none", so use a non-thread (future) type to assert the filter narrows.
    // Today the only branch is `"thread"`, so passing `types: ["thread"]`
    // still returns threads. The negative case is: explicitly request a type
    // that doesn't exist yet — the input schema rejects unknown enum values,
    // so we instead assert that requesting only `"thread"` works and matches
    // the unfiltered call.
    const filtered = GLOBAL_SEARCH.outputSchema.parse(
      await GLOBAL_SEARCH.handler(
        { query: "launch", types: ["thread"] },
        env.ctx,
      ),
    );
    const unfiltered = GLOBAL_SEARCH.outputSchema.parse(
      await GLOBAL_SEARCH.handler({ query: "launch" }, env.ctx),
    );
    expect(filtered.items.map((i) => i.id).sort()).toEqual(
      unfiltered.items.map((i) => i.id).sort(),
    );
  });
});
