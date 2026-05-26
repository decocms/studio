/**
 * Catalog of automations the storefront flow auto-creates per imported repo.
 * Trigger types come from decocms/mcps github/server/lib/trigger-store.ts.
 * Consumed by github-repo-picker.tsx (creation) and
 * studio-pack-checklists.ts (completion).
 */

export type StorefrontAutomationSpec = {
  key: string;
  triggerType: string;
  nameSuffix: string;
  label: string;
  defaultEnabled: boolean;
  instructions: (repo: { owner: string; name: string }) => string;
};

export const STOREFRONT_GITHUB_AUTOMATIONS: readonly StorefrontAutomationSpec[] =
  [
    {
      key: "auto-respond-to-issues",
      triggerType: "github.issues.opened",
      nameSuffix: "auto-respond to issues",
      label: "Auto-respond to new issues",
      defaultEnabled: true,
      instructions: ({ owner, name }) =>
        `A new GitHub issue has been opened in ${owner}/${name}. Read the issue, explore relevant code, create a branch, implement the fix, and open a PR referencing the issue number.`,
    },
    {
      key: "review-incoming-prs",
      triggerType: "github.pull_request.opened",
      nameSuffix: "review incoming PRs",
      label: "Review incoming pull requests",
      defaultEnabled: true,
      instructions: ({ owner, name }) =>
        `A pull request was opened in ${owner}/${name}. Read the diff, summarize what changed, flag risks (security, perf, breaking changes), and leave a review comment.`,
    },
    {
      key: "note-merged-prs",
      triggerType: "github.pull_request.closed",
      nameSuffix: "note merged/closed PRs",
      label: "Note merged or closed PRs",
      defaultEnabled: false,
      instructions: ({ owner, name }) =>
        `A pull request was closed in ${owner}/${name}. If it was merged, update changelog/release notes as appropriate.`,
    },
  ];

export type TriggerDefinitionLike = {
  paramsSchema?: Record<string, unknown>;
  params?: Array<{ name: string }> | Record<string, unknown>;
};

function buildTriggerParams(
  def: TriggerDefinitionLike,
  repo: { owner: string; name: string },
): Record<string, string> {
  const keys = new Set<string>();
  if (def.paramsSchema) {
    for (const k of Object.keys(def.paramsSchema)) keys.add(k);
  }
  if (Array.isArray(def.params)) {
    for (const p of def.params) keys.add(p.name);
  } else if (def.params && typeof def.params === "object") {
    for (const k of Object.keys(def.params)) keys.add(k);
  }
  if (keys.has("repo")) return { repo: `${repo.owner}/${repo.name}` };
  const out: Record<string, string> = {};
  if (keys.has("owner")) out.owner = repo.owner;
  if (keys.has("name")) out.name = repo.name;
  if (keys.has("repository")) out.repository = `${repo.owner}/${repo.name}`;
  return out;
}

type CallTool = (req: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export async function setupStorefrontGithubAutomations({
  githubCallTool,
  selfCallTool,
  virtualMcpId,
  repo,
  connectionId,
  selectedKeys,
}: {
  githubCallTool: CallTool;
  selfCallTool: CallTool;
  virtualMcpId: string;
  repo: { owner: string; name: string };
  connectionId: string;
  selectedKeys: Set<string>;
}): Promise<{ total: number; failed: number }> {
  const triggerListResult = (await githubCallTool({
    name: "TRIGGER_LIST",
    arguments: {},
  })) as { structuredContent?: unknown };
  const triggerPayload = (triggerListResult.structuredContent ??
    triggerListResult) as {
    triggers?: Array<{ type: string } & TriggerDefinitionLike>;
  };
  const byType = new Map(
    (triggerPayload.triggers ?? []).map((t) => [t.type, t]),
  );

  const selectedSpecs = STOREFRONT_GITHUB_AUTOMATIONS.filter((s) =>
    selectedKeys.has(s.key),
  );

  const results = await Promise.allSettled(
    selectedSpecs.map(async (spec) => {
      const trigger = byType.get(spec.triggerType);
      if (!trigger) {
        throw new Error(`Trigger ${spec.triggerType} not exposed`);
      }
      const created = (await selfCallTool({
        name: "AUTOMATION_CREATE",
        arguments: {
          name: `${repo.name}: ${spec.nameSuffix}`,
          virtual_mcp_id: virtualMcpId,
          messages: spec.instructions(repo),
          active: true,
        },
      })) as { structuredContent?: { id: string }; id?: string };
      const automationId = (created.structuredContent ?? created).id;
      if (!automationId) {
        throw new Error(`AUTOMATION_CREATE returned no id for ${spec.key}`);
      }
      await selfCallTool({
        name: "AUTOMATION_TRIGGER_ADD",
        arguments: {
          automation_id: automationId,
          type: "event",
          connection_id: connectionId,
          event_type: spec.triggerType,
          params: buildTriggerParams(trigger, repo),
        },
      });
    }),
  );

  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    console.error(
      "Some GitHub automations failed to set up:",
      results.filter((r) => r.status === "rejected"),
    );
  }
  return { total: results.length, failed };
}
