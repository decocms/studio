import { describe, expect, test } from "bun:test";
import { BLOG_JOB_THREAD_KEY, blogJobOfThread } from "./blog-job";

describe("blogJobOfThread", () => {
  test("a fill's chat names the brand it fills", () => {
    expect(
      blogJobOfThread({
        [BLOG_JOB_THREAD_KEY]: { kind: "brand-fill", brand: "aurora" },
      }),
    ).toEqual({ kind: "brand-fill", brand: "aurora" });
  });

  test("a campaigns chat names its seed and the drafts it may write", () => {
    const job = {
      kind: "campaigns" as const,
      brand: "aurora",
      seedId: "s1",
      campaignIds: ["c1", "c2"],
    };
    expect(blogJobOfThread({ [BLOG_JOB_THREAD_KEY]: job })).toEqual(job);
  });

  test("a campaign's chat names the campaign it shapes", () => {
    const job = {
      kind: "campaign" as const,
      brand: "aurora",
      campaignId: "c1",
    };
    expect(blogJobOfThread({ [BLOG_JOB_THREAD_KEY]: job })).toEqual(job);
    expect(
      blogJobOfThread({
        [BLOG_JOB_THREAD_KEY]: {
          kind: "campaign",
          brand: "aurora",
          campaignId: "",
        },
      }),
    ).toBeNull();
  });

  test("any other chat runs no job", () => {
    expect(blogJobOfThread(null)).toBeNull();
    expect(blogJobOfThread({})).toBeNull();
    expect(
      blogJobOfThread({ blogCard: { cardId: "abc", brand: "aurora" } }),
    ).toBeNull();
    expect(
      blogJobOfThread({
        [BLOG_JOB_THREAD_KEY]: { kind: "brand-fill", brand: "" },
      }),
    ).toBeNull();
  });

  test("a campaigns chat with no draft to write, or too many, runs no job", () => {
    const base = { kind: "campaigns", brand: "aurora", seedId: "s1" };
    expect(
      blogJobOfThread({ [BLOG_JOB_THREAD_KEY]: { ...base, campaignIds: [] } }),
    ).toBeNull();
    expect(
      blogJobOfThread({
        [BLOG_JOB_THREAD_KEY]: { ...base, campaignIds: ["a", "b", "c", "d"] },
      }),
    ).toBeNull();
  });
});
