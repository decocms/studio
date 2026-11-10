import { describe, expect, test } from "bun:test";
import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import {
  conflictAuthorDraft,
  draftChangeFor,
  heldBlockTag,
  rememberConflictEditor,
  resolveDraftChange,
  versionTag,
} from "./conflict-author";
import type { ContentBackend } from "./content-backend";

const params = { orgSlug: "acme", virtualMcpId: "p1", branch: "draft-1" };
const protocol = (source: "github" | "local" | "sandbox"): ContentBackend => ({
  kind: "protocol",
  source,
  client: {} as ContentClient,
  describe: {} as DescribeResult,
  cacheKeySuffix: "",
});
const at = "2026-10-16T12:00:00.000Z";

describe("conflictAuthorDraft", () => {
  test("only a hosted v8 draft says who changed a block", () => {
    expect(conflictAuthorDraft(protocol("github"), params)).toBe(params);
  });

  test("Fast Preview (v7), Localhost and a sandbox show no line", () => {
    expect(conflictAuthorDraft({ kind: "legacy" }, params)).toBeNull();
    expect(conflictAuthorDraft(protocol("local"), params)).toBeNull();
    expect(conflictAuthorDraft(protocol("sandbox"), params)).toBeNull();
    expect(conflictAuthorDraft({ kind: "pending" }, params)).toBeNull();
  });
});

describe("draftChangeFor", () => {
  const changedBy = { "pages-Home Page": { userId: "u-ana", at } };

  test("by the block's name, or another spelling of it", () => {
    expect(draftChangeFor(changedBy, "pages-Home Page")).toEqual({
      userId: "u-ana",
      at,
    });
    expect(draftChangeFor(changedBy, "pages-Home%20Page")).toEqual({
      userId: "u-ana",
      at,
    });
  });

  test("a block the draft has no record of has none", () => {
    expect(draftChangeFor(changedBy, "footer")).toBeNull();
  });
});

describe("resolveDraftChange", () => {
  const members = [
    {
      userId: "u-ana",
      user: { name: "Ana Souza", image: "https://img/ana.png" },
    },
  ];

  test("the member's name and avatar", () => {
    expect(
      resolveDraftChange({ userId: "u-ana", at }, members, "u-bob"),
    ).toEqual({
      name: "Ana Souza",
      shortName: "Ana",
      avatarUrl: "https://img/ana.png",
      at,
      you: false,
    });
  });

  test("two members who share a first name are named in full", () => {
    const demos = [
      { userId: "u-demo", user: { name: "Demo" } },
      { userId: "u-demo2", user: { name: "Demo 2" } },
      { userId: "u-ana", user: { name: "Ana Souza" } },
    ];
    expect(
      resolveDraftChange({ userId: "u-demo2", at }, demos, "u-demo").shortName,
    ).toBe("Demo 2");
    expect(
      resolveDraftChange({ userId: "u-demo", at }, demos, "u-demo2").shortName,
    ).toBe("Demo");
    expect(
      resolveDraftChange({ userId: "u-ana", at }, demos, "u-demo").shortName,
    ).toBe("Ana");
  });

  test("the viewer's own change is `you`", () => {
    expect(
      resolveDraftChange({ userId: "u-ana", at }, members, "u-ana").you,
    ).toBe(true);
  });

  test("an id that isn't a member shows only the time", () => {
    expect(
      resolveDraftChange({ userId: "u-gone", at }, members, "u-bob"),
    ).toEqual({
      at,
      you: false,
    });
  });
});

describe("versionTag", () => {
  test("stable for one version, different for another", () => {
    expect(versionTag('{"a":1}')).toBe(versionTag('{"a":1}'));
    expect(versionTag('{"a":1}')).not.toBe(versionTag('{"a":2}'));
  });
});

describe("heldBlockTag (the version a section form's dialog shows)", () => {
  // The page block a refused save carried: an inline section is a part of it.
  const page = {
    name: "Home Page",
    path: "/",
    sections: [{ __resolveType: "site/sections/Hero.tsx", title: "theirs" }],
  };

  test("finds the editor the refusal recorded for the block it carried, though the dialog shows only the section's values", () => {
    const queryClient = new QueryClient();
    rememberConflictEditor(queryClient, "pages-home", {
      block: page,
      editor: { userId: "u-ana", at: 1793800000 },
    });
    const tag = heldBlockTag({ "pages-home": page }, "pages-home");
    expect(tag).not.toBeNull();
    expect(
      queryClient.getQueryData<unknown>(
        KEYS.conflictEditor("pages-home", tag!),
      ),
    ).toEqual({
      userId: "u-ana",
      at: new Date(1793800000 * 1000).toISOString(),
    });
  });

  test("none for a block the editor doesn't hold", () => {
    expect(heldBlockTag({}, "pages-home")).toBeNull();
    expect(heldBlockTag(undefined, "pages-home")).toBeNull();
    expect(heldBlockTag({ "pages-home": page }, null)).toBeNull();
  });
});
