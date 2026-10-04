import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { RepoContentClient } from "@/git-providers";
import { patchBodyLimit, patchBodySchema, revisionOnBranch } from "./decofile";

describe("decofile patchBodySchema", () => {
  test("accepts a reasonably sized patch", () => {
    const result = patchBodySchema.safeParse({
      set: { "pages/home": {} },
      delete: ["pages/old"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a patch touching more than 500 blocks", () => {
    // Before the fix: unbounded, one commit tree write per key.
    const result = patchBodySchema.safeParse({
      delete: Array.from({ length: 501 }, (_, i) => `pages/block_${i}`),
    });
    expect(result.success).toBe(false);
  });

  test("rejects a single block over the size cap", () => {
    // Before the fix: the key-count cap let one oversized value through.
    const result = patchBodySchema.safeParse({
      set: { "pages/home": { html: "x".repeat(2 * 1024 * 1024) } },
    });
    expect(result.success).toBe(false);
  });

  test("rejects a delete key over the key-length cap", () => {
    // Before the fix: only the block value was size-capped, not the key.
    const result = patchBodySchema.safeParse({
      delete: ["x".repeat(2000)],
    });
    expect(result.success).toBe(false);
  });
});

describe("decofile patchBodyLimit", () => {
  const app = new Hono().patch("/", patchBodyLimit, (c) => c.text("ok"));

  test("rejects a body over the raw size cap before it's parsed", async () => {
    // Before the fix: nothing capped the raw body before c.req.json().
    const body = "x".repeat(9 * 1024 * 1024);
    const res = await app.request("/", {
      method: "PATCH",
      body,
      headers: { "content-length": String(body.length) },
    });
    expect(res.status).toBe(413);
  });

  test("lets a body under the cap through", async () => {
    const res = await app.request("/", { method: "PATCH", body: "small" });
    expect(res.status).toBe(200);
  });
});

describe("decofile revisionOnBranch", () => {
  /** A history `main <- a <- b` on "feat", and "other" at `x`, off `main`. */
  const client = (branches: Record<string, string>) =>
    ({
      getBranch: async (name: string) =>
        branches[name] ? { sha: branches[name] } : null,
      getDefaultBranch: async () => "main",
      compareDetailed: async (base: string, head: string) => {
        const ancestors: Record<string, string[]> = {
          b: ["main", "a", "b"],
          x: ["main", "x"],
          main: ["main"],
        };
        const tip = branches[head] ?? head;
        const line = ancestors[tip] ?? [];
        return {
          aheadBy: 0,
          behindBy: 0,
          mergeBaseSha: line.includes(base) ? base : "main",
          files: [],
          commitMessages: [],
        };
      },
    }) as unknown as RepoContentClient;

  test("accepts the branch head and its ancestors", async () => {
    const c = client({ feat: "b", other: "x", main: "main" });
    expect(await revisionOnBranch(c, "feat", "b")).toBe(true);
    expect(await revisionOnBranch(c, "feat", "a")).toBe(true);
  });

  test("refuses another branch's commit", async () => {
    const c = client({ feat: "b", other: "x", main: "main" });
    expect(await revisionOnBranch(c, "feat", "x")).toBe(false);
  });

  test("checks against the default branch while the branch doesn't exist", async () => {
    const c = client({ other: "x", main: "main" });
    expect(await revisionOnBranch(c, "feat", "main")).toBe(true);
    expect(await revisionOnBranch(c, "feat", "x")).toBe(false);
  });
});
