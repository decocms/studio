import { describe, expect, it } from "bun:test";
import {
  provisionTenantS3Credentials,
  TenantCredentialsError,
} from "./tenant-credentials";

describe("provisionTenantS3Credentials", () => {
  // The slug is interpolated into the IAM session-policy resource ARN, so an
  // invalid slug must be rejected before any AWS call (the load-bearing guard).
  it("rejects an invalid slug before reaching STS", async () => {
    for (const slug of ["Bad Slug", "a/b", "a*", "", "UPPER", "-x"]) {
      await expect(provisionTenantS3Credentials(slug)).rejects.toBeInstanceOf(
        TenantCredentialsError,
      );
    }
  });
});
