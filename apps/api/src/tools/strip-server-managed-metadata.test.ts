import { describe, expect, test } from "bun:test";
import {
  metadataKeptOnClear,
  stripServerManagedMetadata,
} from "./strip-server-managed-metadata";

describe("stripServerManagedMetadata", () => {
  test("removes sandboxMap without mutating the caller's metadata", () => {
    const metadata = {
      instructions: "Keep me",
      sandboxMap: { user: { branch: {} } },
    };

    expect(stripServerManagedMetadata(metadata)).toEqual({
      instructions: "Keep me",
    });
    expect(metadata).toHaveProperty("sandboxMap");
  });

  test("preserves null and undefined", () => {
    expect(stripServerManagedMetadata(null)).toBeNull();
    expect(stripServerManagedMetadata(undefined)).toBeUndefined();
  });

  test("removes the Blocks v8 marker, so only the server writes it", () => {
    expect(
      stripServerManagedMetadata({ fastPreview: true, blocksMajor: 8 }),
    ).toEqual({ fastPreview: true });
  });

  test("removes the Deco Analytics registration, so a client can't point it at another site", () => {
    expect(
      stripServerManagedMetadata({
        fastPreview: true,
        decoAnalytics: { id: "d-other-site", key: "dq_x" },
      }),
    ).toEqual({ fastPreview: true });
  });
});

describe("metadataKeptOnClear", () => {
  test("keeps the server-managed keys and the site slug", () => {
    expect(
      metadataKeptOnClear({
        instructions: "dropped",
        sandboxMap: { u: {} },
        siteSlug: "acme",
        blocksMajor: 8,
      }),
    ).toEqual({ sandboxMap: { u: {} }, siteSlug: "acme", blocksMajor: 8 });
  });

  test("is null when there is nothing to keep", () => {
    expect(metadataKeptOnClear({ instructions: "x" })).toBeNull();
    expect(metadataKeptOnClear(null)).toBeNull();
  });
});
