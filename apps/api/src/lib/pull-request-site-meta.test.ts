import { describe, expect, it } from "bun:test";
import type { DeploymentPreview } from "@/git-providers";
import {
  DECO_HOSTING_REPORTER,
  pullRequestMetaTarget,
} from "./pull-request-site-meta";

const PREVIEW = "https://acme-pr-12-site.deco.site";
const reported = (
  over: Partial<{ url: string; reporter: string | null }> = {},
): DeploymentPreview => ({
  state: "ready",
  url: PREVIEW,
  reporter: DECO_HOSTING_REPORTER,
  ...over,
});
const base = {
  linkedUrl: PREVIEW,
  deployment: reported(),
  siteSlug: "acme",
  orgOwnsSite: true,
};

describe("pullRequestMetaTarget", () => {
  it("sends the token to the org's own site's preview deco hosting reported", () => {
    expect(pullRequestMetaTarget(base)).toEqual({
      siteUrl: PREVIEW,
      trusted: true,
    });
  });

  it("uses the deployment's URL when no run links one", () => {
    expect(pullRequestMetaTarget({ ...base, linkedUrl: null })).toEqual({
      siteUrl: PREVIEW,
      trusted: true,
    });
  });

  it("withholds the token from a preview deco hosting did not report", () => {
    expect(
      pullRequestMetaTarget({
        ...base,
        deployment: reported({ reporter: "someone" }),
      })?.trusted,
    ).toBe(false);
    expect(pullRequestMetaTarget({ ...base, deployment: null })?.trusted).toBe(
      false,
    );
  });

  it("withholds it when the linked host is not the one deco hosting reported", () => {
    expect(
      pullRequestMetaTarget({
        ...base,
        linkedUrl: "https://acme-pr-99-site.deco.site",
      }),
    ).toEqual({ siteUrl: "https://acme-pr-99-site.deco.site", trusted: false });
  });

  it("withholds it from another site's host and from a site the org does not own", () => {
    const other = "https://evil-pr-12-site.deco.site";
    expect(
      pullRequestMetaTarget({
        ...base,
        linkedUrl: other,
        deployment: reported({ url: other }),
      })?.trusted,
    ).toBe(false);
    expect(
      pullRequestMetaTarget({ ...base, orgOwnsSite: false })?.trusted,
    ).toBe(false);
  });

  it("reads a preview off deco's platform without the token", () => {
    const workers = "https://feature-acme.deco-cx.workers.dev";
    expect(
      pullRequestMetaTarget({
        ...base,
        linkedUrl: workers,
        deployment: reported({ url: workers }),
      }),
    ).toEqual({ siteUrl: workers, trusted: false });
  });

  it("names nothing without a preview, or off the preview hosts", () => {
    expect(
      pullRequestMetaTarget({ ...base, linkedUrl: null, deployment: null }),
    ).toBeNull();
    expect(
      pullRequestMetaTarget({
        ...base,
        linkedUrl: "https://evil.example.com",
        deployment: null,
      }),
    ).toBeNull();
  });
});
