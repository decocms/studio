import { describe, expect, it } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import {
  type StoreDraft,
  storeDraftVia,
  unlistedStoreDrafts,
} from "./cms-store-drafts";

const release = (branch: string): Release =>
  ({
    branch,
    name: `Draft ${branch}`,
    color: "orange",
    createdBy: "u1",
    createdAt: "2026-11-01T00:00:00Z",
  }) as Release;

const draft = (
  name: string,
  via: string,
  createdAt = "2026-11-10T00:00:00Z",
): StoreDraft => ({ name, via, createdBy: "u1", createdAt });

describe("unlistedStoreDrafts", () => {
  it("adds the drafts the CLI pushed, which no release names", () => {
    expect(
      unlistedStoreDrafts(
        [release("gimenes-qqaedawm")],
        [draft("gimenes-qqaedawm", "studio"), draft("fix-footer-refs", "cli")],
      ).map((d) => d.name),
    ).toEqual(["fix-footer-refs"]);
  });

  it("drops a CLI draft a release already names (one row per draft)", () => {
    expect(
      unlistedStoreDrafts(
        [release("fix-footer-refs")],
        [draft("fix-footer-refs", "cli")],
      ),
    ).toEqual([]);
  });

  it("leaves out Studio drafts: a discarded release keeps its CMS draft", () => {
    expect(
      unlistedStoreDrafts([], [draft("gimenes-se4w7awm", "studio")]),
    ).toEqual([]);
  });

  it("keeps token and agent drafts, newest first", () => {
    expect(
      unlistedStoreDrafts(
        [],
        [
          draft("old", "token", "2026-11-09T19:21:20.470Z"),
          draft("new", "cli", "2026-11-10T05:07:16.461Z"),
          draft("mid", "studio-agent", "2026-11-10T03:19:46.458Z"),
        ],
      ).map((d) => d.name),
    ).toEqual(["new", "mid", "old"]);
  });

  it("no answer yet (or a failed one) adds nothing", () => {
    expect(unlistedStoreDrafts([release("a")], undefined)).toEqual([]);
  });
});

describe("storeDraftVia", () => {
  it("names how a draft was made", () => {
    expect(storeDraftVia("cli")).toBe("CLI");
    expect(storeDraftVia("token")).toBe("API");
    expect(storeDraftVia("studio-agent")).toBe("agent");
  });
});
