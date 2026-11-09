import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { cmsJson, CmsRequestError, cmsSiteOf, ensureCmsDraft } from "./cms-api";
import { rememberConflictEditor, versionTag } from "./conflict-editor";
import { canonicalBlockJson } from "@decocms/shared/decofile";
import { KEYS } from "@/lib/query-keys";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the hosted CMS client", () => {
  test("the site is the project's siteSlug, when it is a valid one", () => {
    expect(cmsSiteOf({ siteSlug: "acme" })).toBe("acme");
    expect(cmsSiteOf({ siteSlug: "Not A Slug" })).toBeNull();
    expect(cmsSiteOf({})).toBeNull();
    expect(cmsSiteOf(null)).toBeNull();
  });

  test("opening the editor creates its draft: POST /cms/:site/drafts {name: branch}", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body),
      });
      return Response.json({
        name: "threads/t-1",
        slug: "s",
        etag: "e1",
        pointer: "delivery.decocms.com/sites/acme/drafts/s/index.json@e1",
      });
    }) as typeof fetch;
    const draft = await ensureCmsDraft("acme", "threads/t-1");
    expect(draft.pointer).toBe(
      "delivery.decocms.com/sites/acme/drafts/s/index.json@e1",
    );
    expect(calls).toEqual([
      {
        url: "/api/cms/acme/drafts",
        method: "POST",
        body: JSON.stringify({ name: "threads/t-1" }),
      },
    ]);
  });

  test("a refusal keeps the API's code", async () => {
    const error = await cmsJson(
      Response.json(
        { error: "production moved, try again", code: "production_moved" },
        { status: 409 },
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CmsRequestError);
    expect((error as CmsRequestError).code).toBe("production_moved");
  });

  test("a refused save's editor is kept for the dialog of that version (at: seconds → ISO)", () => {
    const queryClient = new QueryClient();
    const block = { title: "Black Friday" };
    rememberConflictEditor(queryClient, "header", {
      block,
      editor: { userId: "usr_ana", at: 1793800000 },
    });
    expect(
      queryClient.getQueryData<unknown>(
        KEYS.conflictEditor("header", versionTag(canonicalBlockJson(block))),
      ),
    ).toEqual({
      userId: "usr_ana",
      at: new Date(1793800000 * 1000).toISOString(),
    });
    rememberConflictEditor(queryClient, "footer", { block, editor: null });
    expect(
      queryClient.getQueryData<unknown>(
        KEYS.conflictEditor("footer", versionTag(canonicalBlockJson(block))),
      ),
    ).toBeNull();
  });
});
