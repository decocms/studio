import { afterEach, describe, expect, it } from "bun:test";
import { HostedPublishError, publishHostedDraft } from "./hosted-publish-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const REVISION = "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55";

/** Answers every request with `body` at `status`, recording what was sent. */
function answer(status: number, body: unknown) {
  const sent: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return sent;
}

describe("publishHostedDraft", () => {
  it("publishes the draft on the hosted CMS, keyed by site", async () => {
    const sent = answer(200, {
      result: "published",
      revision: REVISION,
      previous: null,
    });
    const result = await publishHostedDraft(
      { orgSlug: "acme", site: "acme-store", branch: "main" },
      "Summer sale",
    );
    expect(result).toEqual({ result: "merged", sha: REVISION });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/api/cms/acme-store/drafts/main/publish");
    expect(sent[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(sent[0]!.init?.body))).toEqual({
      message: "Summer sale",
    });
  });

  it("nothing to publish is up to date", async () => {
    answer(200, { result: "up-to-date", revision: REVISION });
    expect(
      await publishHostedDraft(
        { orgSlug: "acme", site: "acme-store", branch: "main" },
        "",
      ),
    ).toEqual({ result: "up-to-date" });
  });

  it("a refusal carries the API's code", async () => {
    answer(409, { error: "production moved", code: "production_moved" });
    const error = await publishHostedDraft(
      { orgSlug: "acme", site: "acme-store", branch: "main" },
      "",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostedPublishError);
    expect((error as HostedPublishError).code).toBe("production_moved");
  });

  it("a project without a site never calls the API", async () => {
    const sent = answer(200, {});
    await expect(
      publishHostedDraft({ orgSlug: "acme", site: null, branch: "main" }, ""),
    ).rejects.toBeInstanceOf(HostedPublishError);
    expect(sent).toHaveLength(0);
  });
});
