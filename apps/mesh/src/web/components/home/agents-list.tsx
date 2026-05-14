/**
 * Agents List Component for Home Page
 *
 * Displays a compact list of agents (Virtual MCPs) with their icon and name.
 * Order is controlled by the org's `default_home_agents` setting when present;
 * otherwise falls back to the legacy mix of well-known templates + most-recent
 * custom agents.
 */

import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  isDecopilot,
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
  WELL_KNOWN_AGENT_TEMPLATES,
} from "@decocms/mesh-sdk";
import type { ProjectLocator, VirtualMCPEntity } from "@decocms/mesh-sdk";
import { useDefaultHomeAgents } from "@/web/hooks/use-organization-settings";

function readRecentAgentIds(locator: ProjectLocator): string[] {
  try {
    const raw = localStorage.getItem(`mesh:chat:recent-agents:${locator}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Globe02, Plus, Users03 } from "@untitledui/icons";
import { ImportFromDecoDialog } from "@/web/components/import-from-deco-dialog.tsx";
import { SiteDiagnosticsRecruitModal } from "@/web/components/home/site-diagnostics-recruit-modal.tsx";
import { AiImageRecruitModal } from "@/web/components/home/ai-image-recruit-modal.tsx";
import { AiResearchRecruitModal } from "@/web/components/home/ai-research-recruit-modal.tsx";
import { LeanCanvasRecruitModal } from "@/web/components/home/lean-canvas-recruit-modal.tsx";
import { StudioPackRecruitModal } from "@/web/components/home/studio-pack-recruit-modal.tsx";
import { SelfHealingRepoFlow } from "@/web/components/self-healing-repo/self-healing-repo-flow.tsx";
import { useCreateVirtualMCP } from "@/web/hooks/use-create-virtual-mcp";
import { useNavigateToAgentThread } from "@/web/hooks/use-navigate-to-agent-thread";
import { usePinnedAgents } from "@/web/hooks/use-pinned-agents";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { Suspense, useState } from "react";
import { track } from "@/web/lib/posthog-client";

/**
 * Max tiles rendered on the home view. Keep in sync with the form copy in
 * `default-home-agents-form.tsx`.
 */
const HOME_VIEW_DISPLAY_LIMIT = 8;

type TileKind = "template" | "existing" | "recent";
type TileAction = "new_chat" | "open_modal" | "navigate";

/**
 * Individual agent preview component
 */
function AgentPreview({
  agent,
  onSpecialClick,
  tracking,
}: {
  agent: {
    id: string;
    title: string;
    icon?: string | null;
  };
  onSpecialClick?: () => void | Promise<unknown>;
  tracking: {
    template_id: string | null;
    tile_kind: TileKind;
    action: TileAction;
  };
}) {
  const { org } = useProjectContext();
  const navigate = useNavigate();

  const handleClick = () => {
    track("home_agent_tile_clicked", {
      template_id: tracking.template_id,
      agent_id: agent.id,
      agent_title: agent.title,
      tile_kind: tracking.tile_kind,
      action: tracking.action,
    });
    if (onSpecialClick) {
      void onSpecialClick();
    } else {
      const taskId = crypto.randomUUID();
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId },
        search: { virtualmcpid: agent.id },
      });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[100px] shrink-0",
        "group",
      )}
      aria-label={`Select agent ${agent.title}`}
    >
      <IntegrationIcon
        icon={agent.icon}
        name={agent.title}
        size="md"
        fallbackIcon={<Users03 size={24} />}
        className="transition-transform group-hover:scale-110"
      />
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight line-clamp-2 break-words w-full">
        {agent.title}
      </p>
    </button>
  );
}

/**
 * See All button component
 */
function SeeAllButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  return (
    <button
      type="button"
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[100px] shrink-0",
        "group",
      )}
      aria-label="See all agents"
      onClick={() => {
        track("home_see_all_agents_clicked");
        navigate({ to: "/$org/settings/agents", params: { org: org.slug } });
      }}
    >
      <div className="size-12 rounded-xl bg-accent flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
        <ChevronRight size={20} className="text-foreground" />
      </div>
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight">
        See all
      </p>
    </button>
  );
}

/**
 * Agents list content component
 */
function CreateAgentButton() {
  const { createVirtualMCP, isCreating } = useCreateVirtualMCP({
    navigateOnCreate: true,
  });

  return (
    <button
      type="button"
      onClick={() => {
        track("home_create_agent_clicked");
        createVirtualMCP();
      }}
      disabled={isCreating}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[100px] shrink-0",
        "group",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
      aria-label="Create agent"
    >
      <div className="size-12 rounded-xl bg-background border-2 border-dashed border-border flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
        <Plus size={20} className="text-muted-foreground" />
      </div>
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight">
        Create agent
      </p>
    </button>
  );
}

const LANDING_PAGE_TEMPLATE_URL =
  "https://github.com/shadcn-ui/next-template.git";

const LANDING_PAGE_INSTRUCTIONS = `You are a vibecoding assistant specialized in building landing pages with Next.js, Tailwind CSS, and shadcn/ui.

The sandbox already has the Next.js starter cloned (https://github.com/shadcn-ui/next-template) and the dev server running with hot module reload — you don't need to scaffold from scratch, and you don't need to restart the dev server.

## CRITICAL — what's pre-installed in this template

The template ships with **ONLY ONE shadcn component pre-built**: \`@/components/ui/button\` (Button).

It does NOT pre-include Badge, Card, CardHeader, CardContent, CardTitle, Input, Label, Avatar, Dialog, Sheet, Dropdown, Accordion, or anything else from shadcn/ui. Importing \`@/components/ui/<anything>\` other than \`button\` will fail with "Module not found".

Before you import a component, you MUST either:
1. **Verify it exists** with \`glob\` on \`components/ui/*.tsx\`, OR
2. **Create the component file yourself** with \`write\` (copy a known-good shadcn implementation into \`components/ui/<name>.tsx\` before importing it), OR
3. **Use plain HTML + Tailwind** (\`<div className="rounded-lg border p-6">\` instead of \`<Card>\`, \`<span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs">\` instead of \`<Badge>\`). This is the safest default for a landing page.

Pre-flight check at the start of every change: \`glob components/ui/*.tsx\` to see what's actually available. Don't guess.

## How to work

1. Edit \`app/page.tsx\` (and components under \`components/\`) using \`write\` / \`edit\`
2. Style with Tailwind utility classes — the template already has Tailwind + the design tokens set up
3. Do NOT run \`npm run dev\` or \`next dev\` — the dev server is already running and will hot-reload your file edits automatically. The user sees the live preview in the panel next to this chat.
4. Do NOT mention specific URLs like \`localhost:3000\` — the user already has the live preview visible. Just describe what you changed.
5. Ask what the landing page is for if the user hasn't said yet (one question, then build immediately)

Bias heavily toward building. Don't over-explain — show results.`;

function LandingPageButton() {
  const actions = useVirtualMCPActions();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const serverPinnedIds = allAgents.filter((a) => !!a.pinned).map((a) => a.id);
  const { pin } = usePinnedAgents(org.id, serverPinnedIds);
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [isCreating, setIsCreating] = useState(false);

  const handleClick = async () => {
    if (isCreating) return;
    setIsCreating(true);
    track("home_landing_page_clicked");
    try {
      const virtualMcp = await actions.create.mutateAsync({
        title: "Landing page",
        description: "Build a landing page with Next.js + shadcn/ui",
        status: "active",
        pinned: true,
        connections: [],
        metadata: {
          instructions: LANDING_PAGE_INSTRUCTIONS,
          cloneUrl: LANDING_PAGE_TEMPLATE_URL,
          // Pre-set the package manager only — shadcn/next-template has no
          // lockfile so detection would fall back to bun. Leave port unset
          // so the host runner assigns a unique dynamic port per sandbox
          // (otherwise every Landing-Page sandbox would race for :3000 and
          // all but the first would fail with EADDRINUSE). Next.js honours
          // the PORT env var the daemon exports.
          runtime: { selected: "npm" },
          // Open with the preview as the main view + chat open on the side.
          ui: {
            pinnedViews: null,
            layout: {
              defaultMainView: { type: "preview" },
              chatDefaultOpen: true,
            },
          },
        },
      });

      const virtualMcpId = virtualMcp.id!;
      const taskId = crypto.randomUUID();

      // Fire VM_START in the background BEFORE we navigate. It takes seconds
      // to provision; getting it started during the navigation flight saves
      // the user that wall-clock time. No branch is passed — the server
      // generates `deco/<adj>-<noun>` and stores the vmMap entry under it.
      // When the agent page's `useEnsureTask` later creates the task on a
      // cloneUrl-backed agent, `pickWarmBranchFromVmMap` returns this same
      // branch so the task and the running VM line up automatically.
      void selfClient
        .callTool({
          name: "VM_START",
          arguments: { virtualMcpId },
        })
        .catch((err: unknown) => {
          console.error("[landing-page] eager VM_START failed", err);
        });

      pin(virtualMcpId);
      localStorage.setItem("mesh:sidebar-open", JSON.stringify(false));
      navigate({
        to: "/$org/$taskId",
        params: { org: org.slug, taskId },
        search: { virtualmcpid: virtualMcpId },
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={isCreating}
      className={cn(
        "flex flex-col items-center gap-3 p-2 rounded-lg",
        "transition-colors",
        "cursor-pointer",
        "w-[100px] shrink-0",
        "group",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
      aria-label="Build landing page"
    >
      <div className="size-12 rounded-xl bg-accent flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
        <Globe02 size={20} className="text-foreground" />
      </div>
      <p className="text-xs sm:text-sm text-foreground text-center leading-tight">
        Build landing page
      </p>
    </button>
  );
}

/**
 * Tile = either an existing custom agent that already lives in the org, or a
 * not-yet-recruited template that opens its specific recruit/import flow.
 */
type RecruitModalKey =
  | "import-deco"
  | "diagnostics"
  | "ai-image"
  | "ai-research"
  | "lean-canvas"
  | "studio-pack"
  | "self-healing";

type HomeTile =
  | {
      key: string;
      kind: "template-recruit";
      templateId:
        | "site-editor"
        | "site-diagnostics"
        | "ai-image"
        | "ai-research"
        | "lean-canvas"
        | "studio-pack"
        | "self-healing-storefront";
      agent: { id: string; title: string; icon?: string | null };
      onClick: RecruitModalKey;
    }
  | {
      key: string;
      kind: "existing";
      templateId: string | null;
      agent: VirtualMCPEntity & { id: string };
    };

/**
 * Match a vMCP to a known template by metadata.type or title.
 */
function findExistingForTemplate(
  agents: VirtualMCPEntity[],
  templateId: string,
  templateTitle: string,
): (VirtualMCPEntity & { id: string }) | undefined {
  return agents.find(
    (a): a is typeof a & { id: string } =>
      a.id !== null &&
      ((a as { metadata?: { type?: string } }).metadata?.type === templateId ||
        a.title === templateTitle),
  );
}

function AgentsListContent() {
  const virtualMcps = useVirtualMCPs();
  const { locator, org } = useProjectContext();
  const orgDefaults = useDefaultHomeAgents();
  const [importDecoOpen, setImportDecoOpen] = useState(false);
  const [diagnosticsModalOpen, setDiagnosticsModalOpen] = useState(false);
  const [aiImageModalOpen, setAiImageModalOpen] = useState(false);
  const [aiResearchModalOpen, setAiResearchModalOpen] = useState(false);
  const [leanCanvasModalOpen, setLeanCanvasModalOpen] = useState(false);
  const [studioPackModalOpen, setStudioPackModalOpen] = useState(false);
  const [selfHealingOpen, setSelfHealingOpen] = useState(false);
  const [preferences] = usePreferences();
  const navigateToAgentThread = useNavigateToAgentThread(org.slug);

  const siteEditorAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "site-editor",
  )!;
  const siteDiagnosticsAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "site-diagnostics",
  )!;
  const aiImageAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "ai-image",
  )!;
  const aiResearchAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "ai-research",
  )!;
  const leanCanvasAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "lean-canvas",
  )!;
  const studioPackAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "studio-pack",
  )!;
  const selfHealingStorefrontAgent = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === "self-healing-storefront",
  )!;

  const existingDiagnostics = findExistingForTemplate(
    virtualMcps,
    siteDiagnosticsAgent.id,
    siteDiagnosticsAgent.title,
  );
  const existingAiImage = findExistingForTemplate(
    virtualMcps,
    aiImageAgent.id,
    aiImageAgent.title,
  );
  const existingAiResearch = findExistingForTemplate(
    virtualMcps,
    aiResearchAgent.id,
    aiResearchAgent.title,
  );
  const existingLeanCanvas = findExistingForTemplate(
    virtualMcps,
    leanCanvasAgent.id,
    leanCanvasAgent.title,
  );

  /**
   * Resolve a single id (template id OR custom UUID) into a renderable tile.
   * Returns null if the id doesn't match any known template or live custom
   * agent (e.g. the agent was deleted after the admin saved).
   */
  const resolveTile = (id: string): HomeTile | null => {
    if (id === siteEditorAgent.id) {
      return {
        key: id,
        kind: "template-recruit",
        templateId: "site-editor",
        agent: siteEditorAgent,
        onClick: "import-deco",
      };
    }
    if (id === siteDiagnosticsAgent.id) {
      if (existingDiagnostics) {
        return {
          key: existingDiagnostics.id,
          kind: "existing",
          templateId: "site-diagnostics",
          agent: existingDiagnostics,
        };
      }
      return {
        key: id,
        kind: "template-recruit",
        templateId: "site-diagnostics",
        agent: siteDiagnosticsAgent,
        onClick: "diagnostics",
      };
    }
    if (id === aiImageAgent.id) {
      if (existingAiImage) {
        return {
          key: existingAiImage.id,
          kind: "existing",
          templateId: "ai-image",
          agent: existingAiImage,
        };
      }
      return {
        key: id,
        kind: "template-recruit",
        templateId: "ai-image",
        agent: aiImageAgent,
        onClick: "ai-image",
      };
    }
    if (id === leanCanvasAgent.id) {
      if (existingLeanCanvas) {
        return {
          key: existingLeanCanvas.id,
          kind: "existing",
          templateId: "lean-canvas",
          agent: existingLeanCanvas,
        };
      }
      return {
        key: id,
        kind: "template-recruit",
        templateId: "lean-canvas",
        agent: leanCanvasAgent,
        onClick: "lean-canvas",
      };
    }
    if (id === studioPackAgent.id) {
      return {
        key: id,
        kind: "template-recruit",
        templateId: "studio-pack",
        agent: studioPackAgent,
        onClick: "studio-pack",
      };
    }
    if (id === selfHealingStorefrontAgent.id) {
      // Experimental — only render when the user has opted in.
      if (!preferences.experimental_vibecode) return null;
      return {
        key: id,
        kind: "template-recruit",
        templateId: "self-healing-storefront",
        agent: selfHealingStorefrontAgent,
        onClick: "self-healing",
      };
    }
    if (id === aiResearchAgent.id) {
      if (existingAiResearch) {
        return {
          key: existingAiResearch.id,
          kind: "existing",
          templateId: "ai-research",
          agent: existingAiResearch,
        };
      }
      return {
        key: id,
        kind: "template-recruit",
        templateId: "ai-research",
        agent: aiResearchAgent,
        onClick: "ai-research",
      };
    }
    const custom = virtualMcps.find(
      (a): a is typeof a & { id: string } =>
        a.id !== null && a.id === id && !isDecopilot(a.id),
    );
    if (custom) {
      return {
        key: custom.id,
        kind: "existing",
        templateId: null,
        agent: custom,
      };
    }
    return null;
  };

  let tiles: HomeTile[];

  if (orgDefaults?.ids) {
    // Admin-controlled order. Resolve in order and drop unresolvable ids.
    tiles = orgDefaults.ids
      .map(resolveTile)
      .filter((t): t is HomeTile => t !== null)
      .slice(0, HOME_VIEW_DISPLAY_LIMIT);
  } else {
    // Legacy fallback: 4 templates + up to 4 most-recent custom agents.
    // self-healing-storefront slots in after site-editor when the user has
    // opted into the experimental flag (resolveTile returns null otherwise).
    const templateIds = [
      siteEditorAgent.id,
      selfHealingStorefrontAgent.id,
      siteDiagnosticsAgent.id,
      aiImageAgent.id,
      aiResearchAgent.id,
    ];
    const templateTiles = templateIds
      .map(resolveTile)
      .filter((t): t is HomeTile => t !== null);

    const recentIds = readRecentAgentIds(locator);
    const recentCustom = virtualMcps
      .filter(
        (agent): agent is typeof agent & { id: string } =>
          agent.id !== null && !isDecopilot(agent.id),
      )
      .filter(
        (a) =>
          a.id !== existingDiagnostics?.id &&
          a.id !== existingAiImage?.id &&
          a.id !== existingAiResearch?.id,
      )
      .sort((a, b) => {
        const aIdx = recentIds.indexOf(a.id);
        const bIdx = recentIds.indexOf(b.id);
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        if (aIdx !== -1) return -1;
        if (bIdx !== -1) return 1;
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      })
      .slice(0, 4)
      .map(
        (agent): HomeTile => ({
          key: agent.id,
          kind: "existing",
          templateId: null,
          agent,
        }),
      );

    tiles = [...templateTiles, ...recentCustom];
  }

  const hasAgents = tiles.some(
    (tile) => tile.kind === "existing" && tile.templateId === null,
  );

  const renderTile = (tile: HomeTile) => {
    if (tile.kind === "template-recruit") {
      const handler = {
        "import-deco": () => setImportDecoOpen(true),
        diagnostics: () => setDiagnosticsModalOpen(true),
        "ai-image": () => setAiImageModalOpen(true),
        "ai-research": () => setAiResearchModalOpen(true),
        "lean-canvas": () => setLeanCanvasModalOpen(true),
        "studio-pack": () => setStudioPackModalOpen(true),
        "self-healing": () => setSelfHealingOpen(true),
      }[tile.onClick];
      return (
        <AgentPreview
          key={tile.key}
          agent={tile.agent}
          onSpecialClick={handler}
          tracking={{
            template_id: tile.templateId,
            tile_kind: "template",
            action: "open_modal",
          }}
        />
      );
    }
    return (
      <AgentPreview
        key={tile.key}
        agent={tile.agent}
        onSpecialClick={() => navigateToAgentThread(tile.agent.id)}
        tracking={{
          template_id: tile.templateId,
          tile_kind: tile.templateId ? "existing" : "recent",
          action: "navigate",
        }}
      />
    );
  };

  return (
    <>
      <div className="w-full max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
        <div className="flex flex-wrap justify-center gap-1.5 max-md:flex-nowrap max-md:justify-start md:max-h-52 md:overflow-hidden">
          <LandingPageButton />
          {tiles.map(renderTile)}
          <CreateAgentButton />
          {hasAgents && <SeeAllButton />}
        </div>
      </div>

      <ImportFromDecoDialog
        open={importDecoOpen}
        onOpenChange={setImportDecoOpen}
      />

      <SiteDiagnosticsRecruitModal
        open={diagnosticsModalOpen}
        onOpenChange={setDiagnosticsModalOpen}
        existingAgent={existingDiagnostics}
      />

      <AiImageRecruitModal
        open={aiImageModalOpen}
        onOpenChange={setAiImageModalOpen}
        existingAgent={existingAiImage}
      />

      <AiResearchRecruitModal
        open={aiResearchModalOpen}
        onOpenChange={setAiResearchModalOpen}
        existingAgent={existingAiResearch}
      />

      <LeanCanvasRecruitModal
        open={leanCanvasModalOpen}
        onOpenChange={setLeanCanvasModalOpen}
        existingAgent={existingLeanCanvas}
      />

      <StudioPackRecruitModal
        open={studioPackModalOpen}
        onOpenChange={setStudioPackModalOpen}
      />

      <SelfHealingRepoFlow
        open={selfHealingOpen}
        onOpenChange={setSelfHealingOpen}
      />
    </>
  );
}

/**
 * Skeleton loader for agents list
 */
function AgentsListSkeleton() {
  return (
    <div className="w-full max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
      <div className="flex flex-wrap justify-center gap-1.5 max-md:flex-nowrap max-md:justify-start md:max-h-52 md:overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col items-center gap-3 p-2 w-[100px] shrink-0"
          >
            <Skeleton className="size-12 rounded-xl shrink-0" />
            <Skeleton className="h-3 sm:h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Agents list component with Suspense boundary
 */
export function AgentsList() {
  return (
    <Suspense fallback={<AgentsListSkeleton />}>
      <AgentsListContent />
    </Suspense>
  );
}
