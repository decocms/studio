import { describe, expect, test } from "bun:test";
import {
  contentBackendDestination,
  contentBackendScopeKey,
  type ContentBackend,
} from "@/components/sections-editor/content-backend";
import { cmsBlocksLoadState, cmsBlocksScopeKey } from "./use-blocks";
import { localServeBackend } from "./use-content-backend";

const cachedBody = { ready: true, failed: false };
const loadingBody = { ready: false, failed: false };
const failedBody = { ready: false, failed: true };

describe("CMS backend availability before mounting body editors", () => {
  test("a cached body cannot open an editor while v8 is being selected", () => {
    expect(cmsBlocksLoadState(true, "pending", cachedBody)).toEqual(
      loadingBody,
    );
    expect(cmsBlocksLoadState(true, "unavailable", cachedBody)).toEqual(
      failedBody,
    );
    expect(cmsBlocksLoadState(true, "protocol", loadingBody)).toEqual(
      loadingBody,
    );
    expect(cmsBlocksLoadState(true, "protocol", cachedBody)).toEqual(
      cachedBody,
    );
  });

  test("hosted body failures remain failures after a backend connects", () => {
    expect(cmsBlocksLoadState(true, "protocol", failedBody)).toEqual(
      failedBody,
    );
  });

  test("legacy and ready whole-body protocol backends retain their ready state", () => {
    for (const kind of ["legacy", "protocol"] as const) {
      expect(cmsBlocksLoadState(true, kind, cachedBody)).toEqual(cachedBody);
    }
  });

  test("an explicitly disabled read does not wait or fail for any backend", () => {
    for (const kind of [
      "pending",
      "unavailable",
      "legacy",
      "protocol",
    ] satisfies ContentBackend["kind"][]) {
      expect(cmsBlocksLoadState(false, kind, failedBody)).toEqual(cachedBody);
    }
  });
});

describe("CMS storage destination identity", () => {
  const scope = { orgSlug: "org", virtualMcpId: "project", branch: "draft" };

  test("pending, connected and unavailable states keep one destination key", () => {
    for (const source of ["github", "sandbox", "local"] as const) {
      const destination = contentBackendDestination(
        source,
        "http://localhost:8000/rpc",
      );
      const keys = (["pending", "protocol", "unavailable"] as const).map(
        (kind) =>
          cmsBlocksScopeKey(scope, {
            kind,
            ...destination,
          }),
      );
      expect(new Set(keys).size).toBe(1);
    }
  });

  test("the local selector retains its endpoint before connection and during failures", () => {
    const endpoint = "http://localhost:8000/rpc";
    const expected = contentBackendScopeKey({
      kind: "protocol",
      ...contentBackendDestination("local", endpoint),
    });
    for (const failing of [false, true]) {
      const backend = localServeBackend({
        endpoint,
        probed: undefined,
        describe: undefined,
        isError: failing,
        failureCount: failing ? 3 : 0,
        failure: new Error("Connection refused"),
      });
      expect(contentBackendScopeKey(backend)).toBe(expected);
    }
  });

  test("actual organization, project, branch, source and endpoint changes reset editors", () => {
    const destination = contentBackendDestination(
      "local",
      "http://localhost:8000/rpc",
    );
    const backend = { kind: "protocol" as const, ...destination };
    const key = cmsBlocksScopeKey(scope, backend);
    for (const changed of [
      { ...scope, orgSlug: "other" },
      { ...scope, virtualMcpId: "other" },
      { ...scope, branch: "other" },
    ]) {
      expect(cmsBlocksScopeKey(changed, backend)).not.toBe(key);
    }
    expect(
      cmsBlocksScopeKey(scope, {
        kind: "pending",
        ...contentBackendDestination("local", "http://localhost:8001/rpc"),
      }),
    ).not.toBe(key);
    expect(
      cmsBlocksScopeKey(scope, {
        kind: "pending",
        ...contentBackendDestination("sandbox"),
      }),
    ).not.toBe(key);
    expect(contentBackendScopeKey({ kind: "legacy" })).not.toBe(
      contentBackendScopeKey(backend),
    );
  });
});
