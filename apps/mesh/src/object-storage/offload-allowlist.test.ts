import { describe, expect, it } from "bun:test";
import type { BoundObjectStorage } from "./bound-object-storage";
import { deriveOffloadAllowlist } from "./offload-allowlist";

/**
 * Hand-written stub — only presignedGetUrl is exercised by deriveOffloadAllowlist.
 * All other BoundObjectStorage methods are not needed for these pure unit tests.
 */
function makeStorage(
  presignedGetUrl: () => Promise<string>,
): BoundObjectStorage {
  return {
    presignedGetUrl: (
      _key: string,
      _expiresIn?: number,
      _opts?: { requireFetchable?: boolean },
    ) => presignedGetUrl(),
  } as unknown as BoundObjectStorage;
}

describe("deriveOffloadAllowlist", () => {
  it("returns fail-closed result when objectStorage is null", async () => {
    const result = await deriveOffloadAllowlist(null, { isProduction: false });
    expect(result).toEqual({ hosts: [], allowSameHostDev: false });
  });

  it("returns fail-closed result when presignedGetUrl throws", async () => {
    const storage = makeStorage(() =>
      Promise.reject(new Error("not fetchable")),
    );
    const result = await deriveOffloadAllowlist(storage, {
      isProduction: false,
    });
    expect(result).toEqual({ hosts: [], allowSameHostDev: false });
  });

  it("extracts the hostname from a public S3 presigned URL", async () => {
    const storage = makeStorage(() =>
      Promise.resolve(
        "https://studio-e2e.s3.amazonaws.com/k?X-Amz-Signature=abc",
      ),
    );
    const result = await deriveOffloadAllowlist(storage, {
      isProduction: false,
    });
    expect(result).toEqual({
      hosts: ["studio-e2e.s3.amazonaws.com"],
      allowSameHostDev: false,
    });
  });

  it("sets allowSameHostDev=true for loopback URL in non-production", async () => {
    const storage = makeStorage(() =>
      Promise.resolve("http://127.0.0.1:9000/bucket/k?X-Amz-Signature=xyz"),
    );
    const result = await deriveOffloadAllowlist(storage, {
      isProduction: false,
    });
    expect(result).toEqual({
      hosts: ["127.0.0.1"],
      allowSameHostDev: true,
    });
  });

  it("sets allowSameHostDev=false for loopback URL in production", async () => {
    const storage = makeStorage(() =>
      Promise.resolve("http://127.0.0.1:9000/bucket/k?X-Amz-Signature=xyz"),
    );
    const result = await deriveOffloadAllowlist(storage, {
      isProduction: true,
    });
    expect(result).toEqual({
      hosts: ["127.0.0.1"],
      allowSameHostDev: false,
    });
  });
});
