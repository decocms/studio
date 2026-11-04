import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { act, render, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema.ts";
import { KEYS } from "@/lib/query-keys";
import type { PublishChange } from "./publish-change-summary.ts";
import type { PublishRequiredFields } from "./publish-required-fields.ts";
import { PublishRequiredFieldsRow } from "./publish-required-fields-row.tsx";
import { useCachedSiteMeta } from "./use-cached-site-meta.ts";

const change = (name: string): PublishChange => ({
  kind: "block",
  blockKey: name,
  name,
  pagePath: null,
  isSiteApp: false,
  status: "edited",
  filepaths: [],
  sections: [],
  fromJson: null,
  toJson: null,
});

const field = (labels: Array<string | number>, blocks: boolean) => ({
  path: labels,
  labels,
  blocks,
});

const listing: PublishRequiredFields = {
  change: change("Example listing"),
  fields: [
    field(["Promo cards", 1, "Headline"], false),
    field(["Promo cards", 1, "Image"], true),
  ],
};

type RowProps = Parameters<typeof PublishRequiredFieldsRow>[0];

const row = (props: Partial<RowProps>) => (
  <QueryClientProvider client={new QueryClient()}>
    <PublishRequiredFieldsRow
      found={[]}
      checking={false}
      blocking={false}
      review={false}
      {...props}
    />
  </QueryClientProvider>
);

const rowText = (props: Partial<RowProps>) =>
  render(row(props)).container.textContent;

describe("PublishRequiredFieldsRow", () => {
  test("missing fields stop a Publish and are listed first, by change", () => {
    expect(rowText({ found: [listing], blocking: true })).toBe(
      "Some required fields are missing. Fill them in, or discard those changes, to publish:" +
        "Example listing: Promo cards › 2 › Image, Promo cards › 2 › Headline",
    );
  });

  test("blank fields only warn", () => {
    const blank: PublishRequiredFields = {
      change: change("Example listing"),
      fields: [field(["Promo cards", 0, "Headline"], false)],
    };
    expect(rowText({ found: [blank] })).toContain(
      "Some required fields are empty. You can publish, but check them first:",
    );
  });

  test("a review submission is told, not stopped", () => {
    expect(rowText({ found: [listing], review: true })).toContain(
      "They need to be filled in before these changes can be published:",
    );
  });

  test("long lists end with how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      field(["Promo cards", i, "Headline"], true),
    );
    expect(
      rowText({
        found: [{ change: change("Example listing"), fields: many }],
        blocking: true,
      }),
    ).toContain("Promo cards › 4 › Headline, and 3 more");
  });

  test("a change that holds the Publish is listed ahead of blank-only ones", () => {
    const blank = (name: string): PublishRequiredFields => ({
      change: change(name),
      fields: [field(["Promo cards", 0, "Headline"], false)],
    });
    const text = rowText({
      found: [1, 2, 3, 4, 5].map((n) => blank(`Blank ${n}`)).concat(listing),
      blocking: true,
    });
    expect(text).toContain("Example listing:");
    expect(text).not.toContain("Blank 5:");
  });

  test("says it is checking while the changes load, and nothing when all is filled", () => {
    expect(rowText({ checking: true, blocking: true })).toBe(
      "Checking required fields…",
    );
    expect(rowText({})).toBe("");
  });
});

describe("useCachedSiteMeta", () => {
  const scope = { orgSlug: "org", virtualMcpId: "site", branch: "main" };
  const meta = (version: string) => ({ version }) as unknown as LiveMeta;

  test("reads the newest schema the editor cached for the branch, and follows it", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCachedSiteMeta(scope), { wrapper });
    expect(result.current).toBeUndefined();

    act(() => {
      client.setQueryData(
        KEYS.liveMeta("org", "site", "main", "https://preview", ""),
        meta("1"),
      );
      client.setQueryData(
        KEYS.liveMeta("org", "site", "other-branch", "", ""),
        meta("other"),
      );
    });
    expect(result.current).toEqual(meta("1"));

    act(() => {
      client.setQueryData(
        KEYS.liveMeta("org", "site", "main", "protocol-x", ""),
        meta("2"),
        { updatedAt: Date.now() + 1000 },
      );
    });
    expect(result.current).toEqual(meta("2"));
  });
});
