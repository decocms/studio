import { describe, expect, test } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";

/**
 * The flag gated the web app alone, so an organization that had turned agentic
 * blog generation off still had every BLOG_* tool reachable over MCP — an agent
 * could spend its credits, reach its connections and upload to its bucket on a
 * feature it had switched off. These pin the refusal on the server side, where
 * the switch has to live for it to mean anything.
 */
const ctxWith = (flags: Record<string, unknown> | null) =>
  ({
    storage: {
      organizationSettings: { get: async () => (flags ? { flags } : null) },
    },
  }) as unknown as StudioContext;

describe("requireBlogAi", () => {
  test("lets the run through when an admin has turned it on", async () => {
    expect(
      requireBlogAi(ctxWith({ blog_ai_enabled: true }), "org_1"),
    ).resolves.toBeUndefined();
  });

  test("refuses when the flag is off", async () => {
    expect(
      requireBlogAi(ctxWith({ blog_ai_enabled: false }), "org_1"),
    ).rejects.toThrow(/off for this organization/);
  });

  test("refuses when the flag was never set, since it is off by default", async () => {
    expect(requireBlogAi(ctxWith({}), "org_1")).rejects.toThrow(
      /off for this organization/,
    );
  });

  test("refuses when the organization has no settings row at all", async () => {
    expect(requireBlogAi(ctxWith(null), "org_1")).rejects.toThrow(
      /off for this organization/,
    );
  });

  test("says where to turn it on, since the caller cannot know", async () => {
    expect(requireBlogAi(ctxWith({}), "org_1")).rejects.toThrow(
      /Settings → General/,
    );
  });

  test("an unrelated flag being on does not open it", async () => {
    expect(
      requireBlogAi(ctxWith({ hide_default_blog_blocks: true }), "org_1"),
    ).rejects.toThrow(/off for this organization/);
  });
});
