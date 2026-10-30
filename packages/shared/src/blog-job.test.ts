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
});
