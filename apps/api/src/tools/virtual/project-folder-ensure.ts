import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import {
  pinnedProjectFolderName,
  projectFolderDir,
} from "@decocms/shared/organization/project-folder";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveCallerProjectScope } from "../../core/project-scope";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { claimProjectFolder } from "../../file-storage/project-folder";

interface ProjectLike {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

/** {@link claimProjectFolder} with the organization's projects and sync state
 *  read from storage. Returns the folder name to persist, or null. */
export async function claimProjectFolderFor(
  ctx: StudioContext,
  organizationId: string,
  project: ProjectLike,
  actor: string,
): Promise<string | null> {
  if (!ctx.orgFs || pinnedProjectFolderName(project)) return null;
  const [projects, homeIsSynced] = await Promise.all([
    ctx.storage.virtualMcps.list(organizationId),
    ctx.storage.orgRepoSyncs.isSyncVolume(organizationId, HOME_MOUNT_PATH),
  ]);
  return claimProjectFolder({
    orgFs: ctx.orgFs,
    organizationId,
    project,
    projects,
    homeIsSynced,
    actor,
  });
}

/** Pin it on the row, so the next read sees the folder as given. */
export async function persistProjectFolderName(
  ctx: StudioContext,
  organizationId: string,
  projectId: string,
  name: string,
  actor: string,
): Promise<void> {
  await ctx.storage.virtualMcps.patchMetadata({
    id: projectId,
    organizationId,
    set: { projectFolderName: name },
    unset: [],
    by: actor,
  });
}

export const PROJECT_FOLDER_ENSURE = defineTool({
  name: "PROJECT_FOLDER_ENSURE",
  description:
    "Give a project's folder in the org's home volume its subfolders and memory.md, once. A project whose folder was already given its shape is left as it is.",
  annotations: {
    title: "Ensure Project Folder",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: z.object({
    path: z.string().describe("The folder's path inside the home volume"),
    created: z
      .boolean()
      .describe("Whether this call gave the folder its shape"),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const project = await ctx.storage.virtualMcps.findById(
      input.id,
      organization.id,
    );
    const projectScope = await resolveCallerProjectScope(ctx);
    if (
      !project ||
      project.organization_id !== organization.id ||
      !isProjectAllowed(projectScope, project.id)
    ) {
      throw new Error(`Project not found: ${input.id}`);
    }
    if (!ctx.orgFs) {
      throw new Error("Organization filesystem is not configured");
    }

    const actor = getUserId(ctx) ?? "system";
    const name = await claimProjectFolderFor(
      ctx,
      organization.id,
      project,
      actor,
    );
    if (name === null) {
      return { path: projectFolderDir(project), created: false };
    }
    await persistProjectFolderName(
      ctx,
      organization.id,
      project.id,
      name,
      actor,
    );
    return {
      path: projectFolderDir({
        ...project,
        metadata: { ...project.metadata, projectFolderName: name },
      }),
      created: true,
    };
  },
});
