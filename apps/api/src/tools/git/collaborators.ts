/**
 * REPOSITORY_COLLABORATOR* — who has access to a linked repository on its
 * provider. Owners and admins of the organization only: these change access
 * outside Studio, so a member role grant does not reach them.
 *
 * Every call reads the provider; nothing is cached, so the list an admin
 * acts on is the one the provider holds.
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
  clientForAccount,
  COLLABORATOR_PERMISSIONS,
  type GitProviderClient,
} from "@/git-providers";
import { captureOrgEvent } from "@/posthog";
import type { RepositoryRecord } from "@/storage/repositories";

const CollaboratorPermissionSchema = z.enum(COLLABORATOR_PERMISSIONS);

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

async function requireCollaboratorAccess(
  ctx: StudioContext,
  repositoryId: string,
): Promise<{
  client: GitProviderClient;
  repository: RepositoryRecord;
  organizationId: string;
}> {
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
  if (!repository.accountId) {
    throw new Error(
      "This repository is linked without a git account. Connect the account that owns it first.",
    );
  }
  const account = await ctx.storage.gitProviderAccounts.get(
    repository.accountId,
    organization.id,
  );
  if (!account) throw new Error("Git account not found");
  const client = clientForAccount(
    { db: ctx.db, vault: ctx.vault },
    account,
    repository,
  );
  return { client, repository, organizationId: organization.id };
}

function unsupported(repository: RepositoryRecord): Error {
  return new Error(
    `Managing access is not supported for ${repository.provider} repositories yet`,
  );
}

export const REPOSITORY_COLLABORATORS_LIST = defineTool({
  name: "REPOSITORY_COLLABORATORS_LIST",
  description:
    "List the people with direct access to a linked repository on its provider, and the invitations they have not accepted yet. Owners and admins only.",
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
    "Give a provider user access to a linked repository. Someone without access yet receives an invitation they have to accept; someone with access has it changed to `permission`. Owners and admins only.",
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
    permission: CollaboratorPermissionSchema.default("write"),
  }),
  outputSchema: z.object({ status: z.enum(["invited", "updated"]) }),
  handler: async (input, ctx) => {
    const { client, repository, organizationId } =
      await requireCollaboratorAccess(ctx, input.repositoryId);
    if (!client.addCollaborator) throw unsupported(repository);
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
    "Withdraw a provider user's pending invitation and direct access to a linked repository. Access through an organization or team on the provider is unaffected. Owners and admins only.",
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
