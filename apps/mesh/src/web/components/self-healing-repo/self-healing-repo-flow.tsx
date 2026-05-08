import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { useNavigateToAgent } from "@/web/hooks/use-navigate-to-agent";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  GitHubRepoPicker,
  type GitHubImportPayload,
} from "@/web/components/github-repo-picker";
import { tiptapDocToMessages } from "@/web/components/chat/derive-parts";
import {
  COMING_SOON_SPECIALISTS,
  SPECIALIST_TEMPLATES,
  type SpecialistTemplate,
} from "./specialist-templates";
import { buildOrchestratorAutomationDoc } from "./orchestrator-automation";

const SITE_DIAGNOSTICS_APP_ID = "deco/site-diagnostics";

interface ConnectionRecord {
  id: string;
  app_id?: string | null;
}

interface VirtualMcpRecord {
  id: string;
  metadata?: { specialistId?: string } | null;
}

export function SelfHealingRepoFlow({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [imported, setImported] = useState<GitHubImportPayload | null>(null);

  const handleFullClose = () => {
    setImported(null);
    onOpenChange(false);
  };

  return (
    <>
      <GitHubRepoPicker
        open={open && imported === null}
        onOpenChange={(next) => {
          if (!next && imported === null) {
            onOpenChange(false);
          }
        }}
        title="Set up self-healing repo"
        hideAutoRespondCheckbox
        onImportComplete={setImported}
      />
      <SpecialistsStep
        open={open && imported !== null}
        payload={imported}
        onClose={handleFullClose}
      />
    </>
  );
}

function SpecialistsStep({
  open,
  payload,
  onClose,
}: {
  open: boolean;
  payload: GitHubImportPayload | null;
  onClose: () => void;
}) {
  const { org } = useProjectContext();
  const navigateToAgent = useNavigateToAgent();
  const connectionActions = useConnectionActions();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const [siteUrl, setSiteUrl] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of SPECIALIST_TEMPLATES) init[t.id] = true;
    return init;
  });

  const { data: siteDiagnosticsRegistry } = useRegistryApp(
    SITE_DIAGNOSTICS_APP_ID,
    { enabled: open },
  );

  const setupMutation = useMutation({
    mutationFn: async () => {
      if (!payload) throw new Error("No imported repo payload");

      const normalizedUrl = normalizeUrl(siteUrl);
      if (!normalizedUrl) {
        throw new Error("Enter a valid https:// URL");
      }

      const activeSpecialists = SPECIALIST_TEMPLATES.filter(
        (t) => enabled[t.id],
      );
      if (activeSpecialists.length === 0) {
        return { succeeded: [] as string[], failed: [] as string[] };
      }

      const siteDiagnosticsConnectionId = await ensureSiteDiagnosticsConnection(
        {
          selfClient,
          createConnection: connectionActions.create.mutateAsync,
          registry: siteDiagnosticsRegistry,
        },
      );

      const succeeded: string[] = [];
      const failed: string[] = [];

      for (const template of activeSpecialists) {
        try {
          await setupSpecialistOrchestration({
            template,
            selfClient,
            siteDiagnosticsConnectionId,
            projectAgentId: payload.virtualMcpId,
            owner: payload.repo.owner,
            repo: payload.repo.name,
            siteRootUrl: normalizedUrl,
          });
          succeeded.push(template.title);
        } catch (err) {
          console.error(`Failed to set up ${template.title}:`, err);
          failed.push(template.title);
        }
      }

      return { succeeded, failed };
    },
    onSuccess: ({ succeeded, failed }) => {
      if (succeeded.length > 0) {
        toast.success(
          `Self-healing repo ready — ${succeeded.length} specialist${succeeded.length > 1 ? "s" : ""} set up`,
        );
      } else if (failed.length === 0) {
        // No specialists toggled on — repo is imported, user opted to skip.
        toast.success("Repo imported. Add specialists later from automations.");
      }
      if (failed.length > 0) {
        toast.warning(
          `Could not set up: ${failed.join(", ")}. You can add them later from the automations view.`,
        );
      }
      const id = payload?.virtualMcpId;
      onClose();
      localStorage.setItem("mesh:sidebar-open", JSON.stringify(false));
      if (id) navigateToAgent(id);
    },
    onError: (error) => {
      toast.error(
        "Failed to set up specialists: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });

  const canSubmit = normalizeUrl(siteUrl) !== null && !setupMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !setupMutation.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[560px] max-h-[85svh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="h-12 border-b border-border px-4 flex flex-row items-center shrink-0 space-y-0">
          <DialogTitle className="text-sm font-medium text-foreground">
            Add specialist monitors
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Specialists run on a daily schedule. Your repo agent collects their
            findings and opens GitHub issues, then writes the fixes.
          </p>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="self-healing-site-url"
              className="text-xs font-medium text-foreground"
            >
              Production URL
            </label>
            <Input
              id="self-healing-site-url"
              type="url"
              placeholder="https://example.com"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              The site the specialists will monitor.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {SPECIALIST_TEMPLATES.map((template) => (
              <SpecialistRow
                key={template.id}
                template={template}
                enabled={enabled[template.id] ?? false}
                onToggle={(next) =>
                  setEnabled((prev) => ({ ...prev, [template.id]: next }))
                }
              />
            ))}
            {COMING_SOON_SPECIALISTS.map((template) => (
              <ComingSoonRow
                key={template.id}
                title={template.title}
                description={template.description}
                icon={template.icon}
              />
            ))}
            <MoreSoonRow />
          </div>
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (!setupMutation.isPending) {
                const id = payload?.virtualMcpId;
                onClose();
                if (id) navigateToAgent(id);
              }
            }}
            disabled={setupMutation.isPending}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
          >
            Skip for now
          </button>
          <Button
            onClick={() => setupMutation.mutate()}
            disabled={!canSubmit}
            size="sm"
          >
            {setupMutation.isPending ? "Setting up..." : "Set up specialists"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SpecialistRow({
  template,
  enabled,
  onToggle,
}: {
  template: SpecialistTemplate;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border px-3 py-3 cursor-pointer transition-colors",
        enabled ? "bg-accent/30" : "hover:bg-accent/30",
      )}
    >
      <AgentAvatar
        icon={template.icon}
        name={template.title}
        size="sm"
        className="shrink-0"
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground leading-tight">
          {template.title}
        </span>
        <span className="text-xs text-muted-foreground line-clamp-2">
          {template.description}
        </span>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        className="shrink-0"
      />
    </label>
  );
}

function ComingSoonRow({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-3 opacity-60">
      <AgentAvatar icon={icon} name={title} size="sm" className="shrink-0" />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground leading-tight">
          {title}
        </span>
        <span className="text-xs text-muted-foreground line-clamp-2">
          {description}
        </span>
      </div>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground shrink-0">
        Coming soon
      </span>
    </div>
  );
}

function MoreSoonRow() {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
      More specialists coming soon
    </div>
  );
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return null;
  }
}

async function ensureSiteDiagnosticsConnection({
  selfClient,
  createConnection,
  registry,
}: {
  selfClient: ReturnType<typeof useMCPClient>;
  createConnection: ReturnType<
    typeof useConnectionActions
  >["create"]["mutateAsync"];
  registry: ReturnType<typeof useRegistryApp>["data"];
}): Promise<string> {
  const existing = (await selfClient.callTool({
    name: "COLLECTION_CONNECTIONS_LIST",
    arguments: {
      where: {
        field: ["app_id"],
        operator: "eq",
        value: SITE_DIAGNOSTICS_APP_ID,
      },
      limit: 1,
      offset: 0,
    },
  })) as { structuredContent?: { items?: ConnectionRecord[] } };

  const match = existing.structuredContent?.items?.find(
    (c) => c.app_id === SITE_DIAGNOSTICS_APP_ID,
  );
  if (match) return match.id;

  const remoteUrl = registry?.server?.remotes?.[0]?.url;
  if (!remoteUrl) {
    throw new Error(
      "Site Diagnostics MCP is not available in the registry right now.",
    );
  }

  const appTitle =
    registry?.title ??
    registry?.server?.title ??
    registry?.server?.name ??
    "Site Diagnostics";
  const appIcon = registry?.server?.icons?.[0]?.src ?? null;
  const appDescription = registry?.server?.description ?? null;

  const created = await createConnection({
    title: appTitle,
    description: appDescription,
    icon: appIcon,
    connection_type: "HTTP",
    connection_url: remoteUrl,
    app_name: registry?.server?.name ?? "site-diagnostics",
    app_id: SITE_DIAGNOSTICS_APP_ID,
    metadata: {
      type: "site-diagnostics",
      source: "store",
      registry_item_id: SITE_DIAGNOSTICS_APP_ID,
      verified: true,
    },
  });

  return created.id;
}

async function setupSpecialistOrchestration({
  template,
  selfClient,
  siteDiagnosticsConnectionId,
  projectAgentId,
  owner,
  repo,
  siteRootUrl,
}: {
  template: SpecialistTemplate;
  selfClient: ReturnType<typeof useMCPClient>;
  siteDiagnosticsConnectionId: string;
  projectAgentId: string;
  owner: string;
  repo: string;
  siteRootUrl: string;
}) {
  const automationName = `${repo}: ${template.title}`;

  // Look for a previous run's automation. If it exists AND already has a
  // trigger, this is a no-op rerun — skip. If it exists with no trigger,
  // a previous attempt failed mid-flow (CREATE succeeded, TRIGGER_ADD
  // failed); reuse the orphan and just add the missing cron trigger
  // instead of creating a duplicate automation.
  const existing = (await selfClient.callTool({
    name: "AUTOMATION_LIST",
    arguments: { virtual_mcp_id: projectAgentId },
  })) as {
    structuredContent?: {
      automations?: Array<{ id: string; name: string; trigger_count: number }>;
    };
  };
  const existingMatch = existing.structuredContent?.automations?.find(
    (a) => a.name === automationName,
  );

  let automationId: string;

  if (existingMatch && existingMatch.trigger_count > 0) {
    return;
  }

  if (existingMatch) {
    automationId = existingMatch.id;
  } else {
    const specialistAgentId = await findOrCreateSpecialistVirtualMcp({
      template,
      selfClient,
      siteDiagnosticsConnectionId,
    });

    const tiptapDoc = buildOrchestratorAutomationDoc({
      template,
      specialistAgentId,
      owner,
      repo,
      siteRootUrl,
    });
    const messages = tiptapDocToMessages(tiptapDoc);

    const automationResult = (await selfClient.callTool({
      name: "AUTOMATION_CREATE",
      arguments: {
        name: automationName,
        virtual_mcp_id: projectAgentId,
        messages,
        active: true,
      },
    })) as { structuredContent?: unknown };

    const automationPayload = (automationResult.structuredContent ??
      automationResult) as { id: string };
    automationId = automationPayload.id;
  }

  await selfClient.callTool({
    name: "AUTOMATION_TRIGGER_ADD",
    arguments: {
      automation_id: automationId,
      type: "cron",
      cron_expression: template.cron,
    },
  });
}

async function findOrCreateSpecialistVirtualMcp({
  template,
  selfClient,
  siteDiagnosticsConnectionId,
}: {
  template: SpecialistTemplate;
  selfClient: ReturnType<typeof useMCPClient>;
  siteDiagnosticsConnectionId: string;
}): Promise<string> {
  const existing = (await selfClient.callTool({
    name: "COLLECTION_VIRTUAL_MCP_LIST",
    arguments: {
      where: {
        field: ["metadata", "specialistId"],
        operator: "eq",
        value: template.id,
      },
      limit: 1,
      offset: 0,
    },
  })) as { structuredContent?: { items?: VirtualMcpRecord[] } };

  const match = existing.structuredContent?.items?.find(
    (item) => item.metadata?.specialistId === template.id,
  );
  if (match) return match.id;

  const created = (await selfClient.callTool({
    name: "COLLECTION_VIRTUAL_MCP_CREATE",
    arguments: {
      data: {
        title: template.title,
        description: template.description,
        icon: template.icon,
        pinned: false,
        metadata: {
          specialistId: template.id,
          instructions: template.instructions,
        },
        connections: [
          {
            connection_id: siteDiagnosticsConnectionId,
            selected_tools: template.siteDiagnosticsTools,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
      },
    },
  })) as { structuredContent?: unknown };

  const payload = (created.structuredContent ?? created) as {
    item: { id: string };
  };
  return payload.item.id;
}
