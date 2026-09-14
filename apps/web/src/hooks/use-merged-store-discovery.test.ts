import { describe, expect, test } from "bun:test";
import type { RegistryItem } from "@/components/store/types";
import {
  getRegistryDiscoveryHealth,
  getRegistryGroupNextPageParam,
  summarizeRegistryPages,
  type RegistryPageResult,
} from "./use-merged-store-discovery";

const item: RegistryItem = {
  id: "calendar",
  title: "Calendar",
  server: { name: "calendar" },
};

const success = (
  registryId: string,
  items: RegistryItem[] = [],
  nextCursor?: string,
): RegistryPageResult => ({
  status: "success",
  registryId,
  registryTitle: `${registryId} title`,
  registryIcon: null,
  items,
  nextCursor,
});

const failure = (registryId: string): RegistryPageResult => ({
  status: "error",
  registryId,
  registryTitle: `${registryId} title`,
  registryIcon: null,
});

describe("merged registry discovery state", () => {
  test("keeps successful items and reports a failed registry separately", () => {
    const summary = summarizeRegistryPages([
      [success("private", [item]), failure("community")],
    ]);
    const health = getRegistryDiscoveryHealth(
      summary.failures,
      summary.successfulRegistryIds,
    );

    expect(summary.items).toEqual([
      {
        ...item,
        _sourceName: "private title",
        _sourceIcon: null,
        _registryId: "private",
      },
    ]);
    expect(health.status).toBe("partial-error");
    expect(health.failures.map(({ id }) => id)).toEqual(["community"]);
  });

  test("distinguishes an all-registry failure from a successful empty catalog", () => {
    const failed = summarizeRegistryPages([
      [failure("private"), failure("community")],
    ]);
    const empty = summarizeRegistryPages([[success("private")]]);

    expect(
      getRegistryDiscoveryHealth(failed.failures, failed.successfulRegistryIds)
        .status,
    ).toBe("error");
    expect(
      getRegistryDiscoveryHealth(empty.failures, empty.successfulRegistryIds)
        .status,
    ).toBe("success");
  });

  test("preserves healthy pagination while pausing a failed source", () => {
    expect(
      getRegistryGroupNextPageParam([
        success("private", [item], "private-page-2"),
        failure("community"),
      ]),
    ).toEqual({
      private: "private-page-2",
      community: null,
    });
  });

  test("does not manufacture another page when every source is terminal", () => {
    expect(
      getRegistryGroupNextPageParam([success("private"), failure("community")]),
    ).toBeUndefined();
  });
});
