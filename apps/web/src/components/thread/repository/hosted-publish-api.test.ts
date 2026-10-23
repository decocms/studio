import { afterEach, describe, expect, it } from "bun:test";
import { keptDraftOf, retryRelease } from "./hosted-publish-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("keptDraftOf", () => {
  it("is the kept draft's scope when the release isn't current", () => {
    expect(
      keptDraftOf(
        { result: "merged", sha: "a", release: "created", draftEtag: '"e1"' },
        "main",
      ),
    ).toEqual({ branch: "main", draftEtag: '"e1"' });
  });

  it("is null once released (the draft was emptied) or when nothing merged", () => {
    expect(
      keptDraftOf({ result: "merged", sha: "a", release: "current" }, "main"),
    ).toBeNull();
    expect(keptDraftOf({ result: "up-to-date" }, "main")).toBeNull();
  });
});

describe("retryRelease", () => {
  const capture = () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ current: {} }), { status: 200 });
    }) as typeof fetch;
    return bodies;
  };

  it("sends the kept draft's scope, so Try again empties it once released", async () => {
    const bodies = capture();
    await retryRelease(
      { orgSlug: "acme", virtualMcpId: "p1" },
      { branch: "main", draftEtag: '"e1"' },
    );
    expect(bodies).toEqual([{ branch: "main", draftEtag: '"e1"' }]);
  });

  it("sends no scope without a kept draft (the Releases screen)", async () => {
    const bodies = capture();
    await retryRelease({ orgSlug: "acme", virtualMcpId: "p1" });
    expect(bodies).toEqual([{}]);
  });
});
