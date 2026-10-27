/**
 * The project's specialists, as the CMS reads and writes them.
 *
 * Each is an `AGENT.md` under the project's own folder, so this is the Library
 * reached through a narrower door: the list is the folder, a role is a file,
 * and saving is writing it. No tool in between, because there is nothing for
 * one to decide — the server reads the same files when it resolves a
 * delegation.
 *
 * What the editor must never offer is the other half of the instruction. The
 * contract is composed over the body at run time and is not in the file at
 * all, which is what makes it un-editable rather than merely discouraged.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AgentDefinition,
  parseAgentMd,
  renderAgentMd,
} from "@decocms/shared/harness/agent-md";
import { projectFolderDir } from "@decocms/shared/organization/project-folder";
import {
  fetchOrgFsText,
  useOrgFsList,
  useOrgFsWriteText,
} from "@/hooks/use-org-fs";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";

const VOLUME = "home";
const DEFINITION_FILE = "AGENT.md";

interface ProjectRef {
  id: string;
  title?: string | null;
  metadata?: unknown;
}

function agentsDir(project: ProjectRef): string {
  return `${projectFolderDir(project)}/agents`;
}

function definitionPath(project: ProjectRef, slug: string): string {
  return `${agentsDir(project)}/${slug}/${DEFINITION_FILE}`;
}

/** The slug a folder path carries. */
function slugOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function useProjectAgents(project: ProjectRef | undefined) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const dir = project ? agentsDir(project) : "";

  const folders = useOrgFsList(VOLUME, dir, { enabled: !!project });
  const slugs = (folders.data ?? [])
    .filter((entry) => entry.kind === "dir")
    .map((entry) => slugOf(entry.path));

  const definitions = useQuery({
    queryKey: KEYS.projectAgents(org.id, project?.id ?? "", slugs.join(",")),
    enabled: !!project && slugs.length > 0,
    queryFn: async () => {
      const read = await Promise.all(
        slugs.map(async (slug) => {
          try {
            const text = await fetchOrgFsText(
              org.slug,
              VOLUME,
              definitionPath(project as ProjectRef, slug),
            );
            return parseAgentMd(slug, text);
          } catch {
            /** A folder with no definition in it is not a role. */
            return null;
          }
        }),
      );
      return read.filter((d): d is AgentDefinition => d !== null);
    },
  });

  const write = useOrgFsWriteText(VOLUME);

  const save = useMutation({
    mutationFn: async (definition: AgentDefinition) => {
      if (!project) throw new Error("No project");
      return await write.mutateAsync({
        path: definitionPath(project, definition.slug),
        body: renderAgentMd(definition),
        contentType: "text/markdown",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: KEYS.projectAgents(
          org.id,
          project?.id ?? "",
          slugs.join(","),
        ),
      }),
  });

  return {
    agents: definitions.data ?? [],
    isLoading: folders.isLoading || definitions.isLoading,
    save: (definition: AgentDefinition) => save.mutate(definition),
    isSaving: save.isPending,
    isError: save.isError,
  };
}
