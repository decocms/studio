/**
 * Git provider domain — shared wire types.
 *
 * A repository is a first-class org entity backed by a `git_provider_accounts`
 * row (the credential holder) whose `type` selects the provider client. Both
 * schemas here are the wire shape the API tools return and the web reads;
 * nothing in them names a GitHub-only concept except the optional
 * `installationId`, which is null for every other provider. Bitbucket means
 * Bitbucket Cloud (bitbucket.org); Bitbucket Data Center has a different API
 * and is not a kind here.
 *
 * Pure module (no DB / network / node deps) so api and web share it.
 */

import { z } from "zod";

export const GIT_PROVIDER_KINDS = ["github", "gitlab", "bitbucket"] as const;
export const GitProviderKindSchema = z.enum(GIT_PROVIDER_KINDS);
export type GitProviderKind = z.infer<typeof GitProviderKindSchema>;

/**
 * How an account authenticates against its provider.
 * - `github_app`: Studio's GitHub App is installed on the account; tokens are
 *   minted per repository from the App private key. No stored user grant.
 * - `oauth`: a refreshable OAuth grant stored in the account credential row.
 * - `token`: a long-lived personal / project / group access token.
 * - `github_cli`: local-only credentials read from the selected gh account.
 */
export const GIT_AUTH_KINDS = [
  "github_app",
  "oauth",
  "token",
  "github_cli",
] as const;
export const GitAuthKindSchema = z.enum(GIT_AUTH_KINDS);
export type GitAuthKind = z.infer<typeof GitAuthKindSchema>;

export const GIT_ACCOUNT_STATUSES = ["active", "revoked"] as const;
export const GitAccountStatusSchema = z.enum(GIT_ACCOUNT_STATUSES);
export type GitAccountStatus = z.infer<typeof GitAccountStatusSchema>;

/**
 * Provider-neutral repository reference. `path` is the full namespace path
 * (`owner/name` on GitHub, `group/subgroup/project` on GitLab) with the
 * provider's display casing preserved; identity comparisons lower-case it
 * (see `repoIdentityKey`).
 */
export const RepoRefSchema = z.object({
  provider: GitProviderKindSchema,
  host: z.string().min(1).describe("Provider host, e.g. github.com"),
  path: z
    .string()
    .min(1)
    .describe("Full namespace path, e.g. owner/name or group/sub/project"),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const GitProviderAccountSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: GitProviderKindSchema,
  host: z.string(),
  authKind: GitAuthKindSchema,
  externalAccountId: z
    .string()
    .describe(
      "Provider-side account identity: installation id (GitHub App), user/group id (GitLab) or user/workspace uuid (Bitbucket).",
    ),
  login: z.string().describe("Display login of the account/namespace"),
  avatarUrl: z.string().nullable(),
  installationId: z
    .number()
    .nullable()
    .describe("GitHub App installation id; null for other auth kinds."),
  status: GitAccountStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitProviderAccount = z.infer<typeof GitProviderAccountSchema>;

/**
 * Which sandbox image this repository's sandboxes boot from.
 *
 * `default` is the image every sandbox uses. `flutter` adds a Linux desktop
 * toolchain and a headless X server so an agent can run the app itself, click
 * through it and screenshot it — the default image can only reach a Flutter UI
 * through `flutter build web`, which a repo whose transitive dependencies do
 * not compile to JS cannot do at all.
 *
 * Deliberately a closed enum rather than a free-text image reference: each
 * value maps to a SandboxTemplate the cluster renders, and a name the cluster
 * does not have would park every claim at `TemplateNotFound`.
 */
export const SandboxImageSchema = z.enum(["default", "flutter"]);
export type SandboxImage = z.infer<typeof SandboxImageSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  accountId: z
    .string()
    .nullable()
    .describe("Credential-holding account; null for anonymous public clones."),
  provider: GitProviderKindSchema,
  host: z.string(),
  path: z.string(),
  externalId: z
    .string()
    .nullable()
    .describe("Provider repository/project id, when known."),
  defaultBranch: z.string().nullable(),
  webUrl: z.string(),
  visibility: z.enum(["public", "private", "internal"]).nullable(),
  sandboxImage: SandboxImageSchema.describe(
    "Sandbox image this repository's sandboxes boot from.",
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;
