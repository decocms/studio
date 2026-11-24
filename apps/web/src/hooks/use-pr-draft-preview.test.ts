import { describe, expect, test } from "bun:test";
import type { Release } from "@decocms/shared/sdk/types";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  isPullRequestDraft,
  pullRequestDraftsEnabled,
} from "./use-pr-draft-preview";

const prDraft: Release = {
  branch: "fix/header",
  name: "Fix header",
  color: "orange",
  runtime: "cms",
  preview: "pull-request",
};
const base = {
  enabled: true,
  runtime: "cms" as const,
  releases: [prDraft],
  branch: "fix/header",
};

describe("isPullRequestDraft", () => {
  test("a CMS session on a pull request draft's branch", () => {
    expect(isPullRequestDraft(base)).toBe(true);
  });

  test("not with the project's switch off", () => {
    expect(isPullRequestDraft({ ...base, enabled: false })).toBe(false);
  });

  test("not in a coding session on the same branch", () => {
    expect(isPullRequestDraft({ ...base, runtime: "sandbox" })).toBe(false);
  });

  test("not on an ordinary draft or an unlisted branch", () => {
    expect(
      isPullRequestDraft({
        ...base,
        releases: [{ ...prDraft, preview: undefined }],
      }),
    ).toBe(false);
    expect(isPullRequestDraft({ ...base, branch: "other" })).toBe(false);
    expect(isPullRequestDraft({ ...base, branch: null })).toBe(false);
  });
});

describe("pullRequestDraftsEnabled", () => {
  const project = (metadata: Record<string, unknown>) =>
    ({ metadata }) as unknown as VirtualMCPEntity;
  const fastPreview = {
    previewServerUrl: "https://acme.com",
    fastPreview: true,
  };

  test("the project's switch, with Fast Preview on", () => {
    expect(
      pullRequestDraftsEnabled(
        project({ ...fastPreview, pullRequestDrafts: true }),
      ),
    ).toBe(true);
    expect(pullRequestDraftsEnabled(project(fastPreview))).toBe(false);
  });

  test("inert without Fast Preview", () => {
    expect(
      pullRequestDraftsEnabled(
        project({
          ...fastPreview,
          fastPreview: false,
          pullRequestDrafts: true,
        }),
      ),
    ).toBe(false);
    expect(
      pullRequestDraftsEnabled(
        project({ fastPreview: true, pullRequestDrafts: true }),
      ),
    ).toBe(false);
  });

  test("never on a Blocks v8 site", () => {
    expect(
      pullRequestDraftsEnabled(
        project({ ...fastPreview, blocksV8: true, pullRequestDrafts: true }),
      ),
    ).toBe(false);
  });
});
