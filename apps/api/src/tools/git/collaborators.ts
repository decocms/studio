/**
 * Repository access on the provider, for org owners and admins. Studio only
 * manages hosted (`managed`) repositories, up to write, never the host's people.
 */

import { z } from "zod";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import { ForbiddenError } from "@/core/access-control";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import {
  type CollaboratorPermission,
  clientForAccount,
  COLLABORATOR_PERMISSIONS,
  type GitProviderClient,
  repositoryAccessMode,
} from "@/git-providers";
import { captureOrgEvent } from "@/posthog";
import type { RepositoryRecord } from "@/storage/repositories";

const CollaboratorPermissionSchema = z.enum(COLLABORATOR_PERMISSIONS);

/** What Studio may grant on a managed repository. */
const GrantablePermissionSchema = z.enum(["read", "triage", "write"]);

/** Access Studio leaves alone: the host's own people, and roles it cannot read. */
function isHostAccess(permission: CollaboratorPermission | null): boolean {
  return (
    permission === null || permission === "maintain" || permission === "admin"
  );
}

const CollaboratorSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
  permission: CollaboratorPermissionSchema.nullable(),
});

/** GitHub's rule for a login: alphanumerics and single inner hyphens, 39 at most. */
const LoginSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
    "Enter a valid GitHub username",
  );

function manageOnProviderUrl(repository: RepositoryRecord): string {
  return `${repository.webUrl.replace(/\/$/, "")}/settings/access`;
}

async function requireOrgAdminRepository(
  ctx: StudioContext,
  repositoryId: string,
) {
  requireAuth(ctx);
  await ctx.access.check();
  if (!hasAdminRole(ctx.access.getRole())) {
    throw new ForbiddenError(
      "Only organization owners and admins can manage repository access",
    );
  }
  const organization = requireOrganization(ctx);
  const repository = await ctx.storage.repositories.get(
    repositoryId,
    organization.id,
  );
  if (!repository) throw new Error("Repository not found");
  const account = repository.accountId
    ? await ctx.storage.gitProviderAccounts.get(
        repository.accountId,
        organization.id,
      )
    : null;
  return { organizationId: organization.id, repository, account };
}

async function requireCollaboratorAccess(
  ctx: StudioContext,
  repositoryId: string,
): Promise<{
  client: GitProviderClient;
  repository: RepositoryRecord;
  organizationId: string;
}> {
  const { organizationId, repository, account } =
    await requireOrgAdminRepository(ctx, repositoryId);
  if (!account || repositoryAccessMode(account, repository) !== "managed") {
    throw new ForbiddenError(
      `Manage who has access to ${repository.path} on GitHub: ${manageOnProviderUrl(repository)}`,
    );
  }
  // A whole-installation grant would reach every hosted repository, not just this org's.
  if (account.installationRepositoryIds === null) {
    throw new ForbiddenError(
      "This organization is granted the whole hosted GitHub installation, so Studio cannot tell which repositories are its own. Reconnect it with only this organization's repositories.",
    );
  }
  const client = clientForAccount(
    { db: ctx.db, vault: ctx.vault },
    account,
    repository,
  );
  return { client, repository, organizationId };
}

/** Refuse to change the access of the host's own people. */
async function refuseHostAccess(
  client: GitProviderClient,
  repository: RepositoryRecord,
  login: string,
): Promise<void> {
  if (!client.listCollaborators) throw unsupported(repository);
  const { collaborators } = await client.listCollaborators(repository);
  const current = collaborators.find(
    (person) => person.login.toLowerCase() === login.toLowerCase(),
  );
  if (current && isHostAccess(current.permission)) {
    throw new ForbiddenError(
      `${current.login}'s access to ${repository.path} is managed by the repository's host, not from Studio`,
    );
  }
}

function unsupported(repository: RepositoryRecord): Error {
  return new Error(
    `Managing access is not supported for ${repository.provider} repositories yet`,
  );
}

export const REPOSITORY_ACCESS_MODE = defineTool({
  name: "REPOSITORY_ACCESS_MODE",
  description:
    "Whether Studio manages who has access to a linked repository (`managed`: hosted for this organization, which cannot administer it) or its owner does on the provider (`self`), with the provider page where access is managed. Owners and admins only.",
  annotations: {
    title: "Repository access mode",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({ repositoryId: z.string() }),
  outputSchema: z.object({
    mode: z.enum(["managed", "self"]),
    manageUrl: z.string(),
  }),
  handler: async (input, ctx) => {
    const { repository, account } = await requireOrgAdminRepository(
      ctx,
      input.repositoryId,
    );
    return {
      mode: repositoryAccessMode(account, repository),
      manageUrl: manageOnProviderUrl(repository),
    };
  },
});

export const REPOSITORY_COLLABORATORS_LIST = defineTool({
  name: "REPOSITORY_COLLABORATORS_LIST",
  description:
    "List the people with direct access to a managed repository on its provider, and the invitations they have not accepted yet. Owners and admins only.",
  annotations: {
    title: "List repository collaborators",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({ repositoryId: z.string() }),
  outputSchema: z.object({
    collaborators: z.array(CollaboratorSchema),
    invitations: z.array(CollaboratorSchema),
  }),
  handler: async (input, ctx) => {
    const { client, repository } = await requireCollaboratorAccess(
      ctx,
      input.repositoryId,
    );
    if (!client.listCollaborators) throw unsupported(repository);
    return client.listCollaborators(repository);
  },
});

export const REPOSITORY_COLLABORATOR_ADD = defineTool({
  name: "REPOSITORY_COLLABORATOR_ADD",
  description:
    "Give a provider user up to write access to a managed repository. Someone without access yet receives an invitation they have to accept; someone with access has it changed to `permission`. Owners and admins only.",
  annotations: {
    title: "Add repository collaborator",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    repositoryId: z.string(),
    username: LoginSchema,
    permission: GrantablePermissionSchema.default("write"),
  }),
  outputSchema: z.object({ status: z.enum(["invited", "updated"]) }),
  handler: async (input, ctx) => {
    const { client, repository, organizationId } =
      await requireCollaboratorAccess(ctx, input.repositoryId);
    if (!client.addCollaborator) throw unsupported(repository);
    await refuseHostAccess(client, repository, input.username);
    const status = await client.addCollaborator(
      repository,
      input.username,
      input.permission,
    );
    captureOrgEvent({
      event: "repository_collaborator_added",
      organizationId,
      userId: getUserId(ctx),
      properties: {
        repository_id: repository.id,
        permission: input.permission,
        status,
      },
    });
    return { status };
  },
});

export const REPOSITORY_COLLABORATOR_REMOVE = defineTool({
  name: "REPOSITORY_COLLABORATOR_REMOVE",
  description:
    "Withdraw a provider user's pending invitation and direct access to a managed repository. Access through an organization or team on the provider is unaffected. Owners and admins only.",
  annotations: {
    title: "Remove repository collaborator",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    repositoryId: z.string(),
    username: LoginSchema,
  }),
  outputSchema: z.object({ removed: z.literal(true) }),
  handler: async (input, ctx) => {
    const { client, repository, organizationId } =
      await requireCollaboratorAccess(ctx, input.repositoryId);
    if (!client.removeCollaborator) throw unsupported(repository);
    await refuseHostAccess(client, repository, input.username);
    await client.removeCollaborator(repository, input.username);
    captureOrgEvent({
      event: "repository_collaborator_removed",
      organizationId,
      userId: getUserId(ctx),
      properties: { repository_id: repository.id },
    });
    return { removed: true as const };
  },
});
