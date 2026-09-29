/**
 * What a control-plane sandbox may have re-minted through
 * `/api/sandbox-callbacks/*`. Studio signs one into every SANDBOX_ENSURE, the
 * host keeps it in the sandbox's persisted options and presents it on each
 * callback. The host cannot sign one, so its bearer alone opens no org's
 * credentials: a callback mints only for the tenant and repos Studio itself
 * asked a sandbox for.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { repoKeyFromCloneUrl } from "@decocms/sandbox/provider/agent-sandbox";
import type { EnsureOptions } from "@decocms/sandbox/provider";

const id = z.string().min(1).max(512);

const grantRepoSchema = z.union([
  z.object({ repositoryId: id }).strict(),
  z.object({ connectionId: id, repo: id }).strict(),
]);
export type GrantRepo = z.infer<typeof grantRepoSchema>;

const grantScopeSchema = z
  .object({
    v: z.literal(1),
    orgId: id,
    userId: id,
    repos: z.array(grantRepoSchema).max(64),
  })
  .strict();
export type CallbackGrantScope = z.infer<typeof grantScopeSchema>;

function mac(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`sandbox-callback-grant.${payload}`)
    .digest();
}

/** Signed with the first secret; the rest only verify, so a rotation overlaps. */
export function signCallbackGrant(
  scope: CallbackGrantScope,
  secrets: readonly string[],
): string {
  const [current] = secrets;
  if (!current) throw new Error("no callback grant secret configured");
  const payload = Buffer.from(JSON.stringify(scope)).toString("base64url");
  return `${payload}.${mac(payload, current).toString("base64url")}`;
}

/** The scope a grant names, or null when no configured secret signed it. */
export function verifyCallbackGrant(
  grant: string,
  secrets: readonly string[],
): CallbackGrantScope | null {
  const parts = grant.split(".");
  if (parts.length !== 2) return null;
  const [payload = "", signature = ""] = parts;
  const presented = Buffer.from(signature, "base64url");
  const signed = secrets.some((secret) => {
    const expected = mac(payload, secret);
    return (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented)
    );
  });
  if (!signed) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = grantScopeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function grantRepo(repo: NonNullable<EnsureOptions["repo"]>): GrantRepo | null {
  // The repository mint reads its own record; a connection mint trusts the
  // owner/name in the clone URL, so that is part of the scope.
  if (repo.repositoryId) return { repositoryId: repo.repositoryId };
  const key = repo.connectionId ? repoKeyFromCloneUrl(repo.cloneUrl) : null;
  return repo.connectionId && key
    ? { connectionId: repo.connectionId, repo: key }
    : null;
}

/** The scope for a sandbox Studio is about to ask for; null without a tenant. */
export function grantScopeFor(opts: EnsureOptions): CallbackGrantScope | null {
  if (!opts.tenant) return null;
  const repos = [opts.repo, ...(opts.extraRepos ?? [])]
    .filter((repo) => repo !== undefined)
    .map(grantRepo)
    .filter((repo) => repo !== null);
  return {
    v: 1,
    orgId: opts.tenant.orgId,
    userId: opts.tenant.userId,
    repos,
  };
}

/** Whether a clone-url request names a repo the grant covers. */
export function grantCoversRepo(
  scope: CallbackGrantScope,
  request: { cloneUrl: string; connectionId?: string; repositoryId?: string },
): boolean {
  if (request.repositoryId) {
    return scope.repos.some(
      (repo) =>
        "repositoryId" in repo && repo.repositoryId === request.repositoryId,
    );
  }
  const key = repoKeyFromCloneUrl(request.cloneUrl);
  return scope.repos.some(
    (repo) =>
      "connectionId" in repo &&
      repo.connectionId === request.connectionId &&
      repo.repo === key,
  );
}

/**
 * `STUDIO_SANDBOX_CALLBACK_GRANT_SECRETS`, comma-separated: the first signs,
 * all verify. Its own secret so rotating it neither signs everyone out
 * (BETTER_AUTH_SECRET) nor re-keys the vault (ENCRYPTION_KEY).
 */
export function parseGrantSecrets(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
