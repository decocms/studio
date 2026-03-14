import {
  type DefaultAgentSpec,
  getDefaultAgentSpecs,
} from "@/constants/default-agents";
import {
  useConnections,
  useVirtualMCPActions,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  MessageChatCircle,
  Plus,
  SearchMd,
  ShoppingBag01,
} from "@untitledui/icons";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { EmptyState } from "@/web/components/empty-state.tsx";

// ---------------------------------------------------------------------------
// Category grouping
// ---------------------------------------------------------------------------

interface CategoryGroup {
  label: string;
  specs: DefaultAgentSpec[];
}

function categorizeSpecs(specs: DefaultAgentSpec[]): CategoryGroup[] {
  const categories: Record<string, DefaultAgentSpec[]> = {};
  for (const spec of specs) {
    const cat = getCategoryLabel(spec);
    (categories[cat] ??= []).push(spec);
  }
  const order = [
    "Platform",
    "E-Commerce",
    "Content & SEO",
    "Site Building",
    "Marketing",
    "Operations",
    "Engineering",
  ];
  return order
    .filter((label) => categories[label]?.length)
    .map((label) => ({ label, specs: categories[label]! }));
}

function getCategoryLabel(spec: DefaultAgentSpec): string {
  const title = spec.title;
  if (["Studio Manager", "Event Automator"].includes(title)) return "Platform";
  if (
    [
      "PLP Optimizer",
      "Order Tracker",
      "Inventory Monitor",
      "Product Photographer",
    ].includes(title)
  )
    return "E-Commerce";
  if (["Blog Writer", "SEO Analyst", "Competitor Scout"].includes(title))
    return "Content & SEO";
  if (title === "Site Builder") return "Site Building";
  if (title === "Ads Reporter") return "Marketing";
  if (
    [
      "Error Watchdog",
      "Spreadsheet Syncer",
      "Comms Drafter",
      "Daily Inbox Summary",
      "Daily Standup",
      "Calendar Watcher",
      "Proposal Drafter",
      "Weekly Report",
      "Scorecard Updater",
    ].includes(title)
  )
    return "Operations";
  if (
    [
      "PR Reviewer",
      "Release Notes",
      "Code Reviewer",
      "Engineering Retro",
      "Product Reviewer",
      "Architecture Reviewer",
      "Browser QA",
    ].includes(title)
  )
    return "Engineering";
  return "Other";
}

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function specIcon(spec: DefaultAgentSpec): string {
  return `/icons/capy-${spec.iconIndex}.png`;
}

/** GitHub avatar via CORS-safe proxy (same pattern as github-icon.ts) */
function ghAvatar(owner: string): string {
  return `https://images.weserv.nl/?url=${encodeURIComponent(`https://github.com/${owner}.png`)}&output=webp`;
}

const deco = (path: string) => `https://assets.decocache.com/decocms/${path}`;

/**
 * Fallback icon URLs for well-known app_names used in agent templates.
 * Used when the MCP isn't installed (so we can't read the connection icon).
 */
const KNOWN_APP_ICONS: Record<string, string> = {
  vtex: ghAvatar("vtex"),
  nanobanana: ghAvatar("nanobanana-ai"),
  perplexity: ghAvatar("perplexity-ai"),
  hyperdx: ghAvatar("hyperdxio"),
  "google-gmail": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/google_mail_gmail_logo_icon_159346.webp",
  ),
  "google-sheets": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/google_spreadsheets_sheets_logo_icon_159348.webp",
  ),
  "google-calendar": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/google_calendar_logo_icon_159350.webp",
  ),
  "google-docs": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/google_docs_logo_icon_159351.webp",
  ),
  "google-search-console": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/google_search_console_logo_icon_159354.webp",
  ),
  "data-for-seo": ghAvatar("nickmarca"),
  storefront: ghAvatar("deco-cx"),
  "meta-ads": deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/facebook_meta_logo_icon_247241.webp",
  ),
  slack: deco(
    "3b38d2ee-b26b-454e-be9f-3be338a5b0f3/slack_logo_icon_195635.webp",
  ),
  github: ghAvatar("github"),
  "code-sandbox": ghAvatar("anthropics"),
};

// ---------------------------------------------------------------------------
// Installed-apps helper — returns app_name → icon URL mapping
// ---------------------------------------------------------------------------

interface AppInfo {
  installed: boolean;
  icon: string | null;
}

function useInstalledApps(): Map<string, AppInfo> {
  const connections = useConnections();
  const apps = new Map<string, AppInfo>();
  for (const conn of connections ?? []) {
    if (conn.app_name && !apps.has(conn.app_name)) {
      apps.set(conn.app_name, { installed: true, icon: conn.icon ?? null });
    }
  }
  return apps;
}

/** Resolve icon for an app: installed connection icon → known fallback → null */
function resolveAppIcon(
  app: string,
  installedApps: Map<string, AppInfo>,
): string | null {
  return installedApps.get(app)?.icon ?? KNOWN_APP_ICONS[app] ?? null;
}

// ---------------------------------------------------------------------------
// Tiny MCP icon with status ring
// ---------------------------------------------------------------------------

function McpAppIcon({
  app,
  installedApps,
}: {
  app: string;
  installedApps: Map<string, AppInfo>;
}) {
  const info = installedApps.get(app);
  const installed = !!info?.installed;
  const icon = resolveAppIcon(app, installedApps);
  const ringColor = installed ? "ring-emerald-500/60" : "ring-red-400/60";

  return (
    <div
      className={cn(
        "relative size-6 rounded-md ring-[1.5px] shrink-0 overflow-hidden bg-muted flex items-center justify-center",
        ringColor,
      )}
      title={`${app}${installed ? " (installed)" : " (not installed)"}`}
    >
      {icon ? (
        <img src={icon} alt={app} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-medium text-muted-foreground uppercase leading-none">
          {app.slice(0, 2)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template card
// ---------------------------------------------------------------------------

function TemplateCard({
  spec,
  installedApps,
  onClick,
}: {
  spec: DefaultAgentSpec;
  installedApps: Map<string, AppInfo>;
  onClick: () => void;
}) {
  return (
    <Card
      className="cursor-pointer transition-colors hover:bg-muted/50 flex flex-col overflow-hidden"
      onClick={onClick}
    >
      <div className="flex flex-col flex-1 p-6 gap-4">
        {/* Header: Icon + MCP mini-icons */}
        <div className="flex items-start justify-between">
          <IntegrationIcon
            icon={specIcon(spec)}
            name={spec.title}
            size="md"
            className="shrink-0 shadow-sm"
          />
          {spec.requiredApps.length > 0 && (
            <div className="flex items-center gap-1">
              {spec.requiredApps.map((app) => (
                <McpAppIcon key={app} app={app} installedApps={installedApps} />
              ))}
            </div>
          )}
        </div>

        {/* Title + Description */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <span className="text-base font-medium text-foreground truncate">
            {spec.title}
          </span>
          <span className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
            {spec.description}
          </span>
        </div>

        {/* Ice Breaker Preview */}
        <div className="flex flex-col gap-2 mt-auto pt-3 border-t border-border/50">
          <div className="flex flex-wrap gap-1.5">
            {spec.iceBreakers.slice(0, 2).map((breaker, i) => (
              <span
                key={i}
                className="text-xs text-muted-foreground bg-muted/50 rounded-full px-3 py-1 truncate max-w-full"
              >
                {breaker}
              </span>
            ))}
            {spec.iceBreakers.length > 2 && (
              <span className="text-xs text-muted-foreground/60 px-1 py-1">
                +{spec.iceBreakers.length - 2} more
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Template detail dialog
// ---------------------------------------------------------------------------

function TemplateDetailDialog({
  spec,
  open,
  onOpenChange,
  installedApps,
  onInstall,
  isInstalling,
}: {
  spec: DefaultAgentSpec | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installedApps: Map<string, AppInfo>;
  onInstall: (spec: DefaultAgentSpec) => void;
  isInstalling: boolean;
}) {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  if (!spec) return null;

  const missingApps = spec.requiredApps.filter(
    (app) => !installedApps.get(app)?.installed,
  );
  const canInstall = missingApps.length === 0;

  const registryId = WellKnownOrgMCPId.REGISTRY(org.id);

  const goToStore = (appName: string) => {
    onOpenChange(false);
    navigate({
      to: "/$org/$project/store/$appName",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        appName,
      },
      search: {
        registryId,
        serverName: `deco/${appName}`,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-3">
            <IntegrationIcon
              icon={specIcon(spec)}
              name={spec.title}
              size="md"
              className="shrink-0 shadow-sm"
            />
            <div>
              <DialogTitle>{spec.title}</DialogTitle>
              <DialogDescription>{spec.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto px-6 pb-6 flex flex-col gap-5">
          {/* Required MCPs */}
          {spec.requiredApps.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-foreground uppercase tracking-wider font-mono">
                Required MCPs
              </span>
              <div className="flex flex-col gap-2">
                {spec.requiredApps.map((app) => {
                  const installed = !!installedApps.get(app)?.installed;
                  return (
                    <div key={app} className="flex items-center gap-2.5">
                      <McpAppIcon app={app} installedApps={installedApps} />
                      <span className="text-sm text-foreground">{app}</span>
                      {installed ? (
                        <span className="text-xs ml-auto text-emerald-600">
                          Installed
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="text-xs ml-auto text-red-500 hover:text-red-600 underline underline-offset-2 cursor-pointer"
                          onClick={() => goToStore(app)}
                        >
                          Install from Store
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {missingApps.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Install missing MCPs from the Store before adding this agent.
                </p>
              )}
            </div>
          )}

          {/* Ice Breakers */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground uppercase tracking-wider font-mono">
              Conversation Starters
            </span>
            <div className="flex flex-col gap-1.5">
              {spec.iceBreakers.map((breaker, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
                >
                  <MessageChatCircle
                    size={14}
                    className="shrink-0 text-muted-foreground mt-0.5"
                  />
                  <span className="text-sm text-foreground">{breaker}</span>
                </div>
              ))}
            </div>
          </div>

          {/* System Prompt Preview */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-foreground uppercase tracking-wider font-mono">
              System Prompt
            </span>
            <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2 max-h-48 overflow-auto">
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                {spec.instructions}
              </pre>
            </div>
          </div>

          {/* Built-in connections info */}
          {spec.builtinConnections.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-foreground uppercase tracking-wider font-mono">
                Built-in Connections
              </span>
              <div className="flex flex-wrap gap-1.5">
                {spec.builtinConnections.map((conn) => (
                  <Badge key={conn.key} variant="secondary" className="text-xs">
                    {conn.key}
                    {conn.selected_tools
                      ? ` (${conn.selected_tools.length} tools)`
                      : " (all tools)"}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer with install / go-to-store button */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {canInstall ? (
            <Button onClick={() => onInstall(spec)} disabled={isInstalling}>
              <Plus size={14} />
              {isInstalling ? "Installing..." : "Install Agent"}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => goToStore(missingApps[0]!)}
            >
              <ShoppingBag01 size={14} />
              Go to Store
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentTemplates() {
  const [search, setSearch] = useState("");
  const [selectedSpec, setSelectedSpec] = useState<DefaultAgentSpec | null>(
    null,
  );
  const [isInstalling, setIsInstalling] = useState(false);
  const installedApps = useInstalledApps();
  const actions = useVirtualMCPActions();

  const allSpecs = getDefaultAgentSpecs();

  // Filter by search
  const filtered = search
    ? allSpecs.filter(
        (s) =>
          s.title.toLowerCase().includes(search.toLowerCase()) ||
          s.description.toLowerCase().includes(search.toLowerCase()) ||
          s.requiredApps.some((app) =>
            app.toLowerCase().includes(search.toLowerCase()),
          ),
      )
    : allSpecs;

  const categories = categorizeSpecs(filtered);

  const navigate = useNavigate();
  const { org } = useProjectContext();

  const handleInstall = async (spec: DefaultAgentSpec) => {
    setIsInstalling(true);
    try {
      const created = await actions.create.mutateAsync({
        title: spec.title,
        description: spec.description,
        icon: specIcon(spec),
        status: "active",
        metadata: {
          instructions: spec.instructions,
          ice_breakers: spec.iceBreakers,
          required_apps: spec.requiredApps,
        },
        connections: [],
      });
      setSelectedSpec(null);
      if (created?.id) {
        navigate({
          to: "/$org/$project/agents/$agentId",
          params: {
            org: org.slug,
            project: ORG_ADMIN_PROJECT_SLUG,
            agentId: created.id,
          },
        });
      }
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Search */}
      <div className="px-5">
        <CollectionSearch
          value={search}
          onChange={setSearch}
          placeholder="Search templates..."
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearch("");
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto px-5 pb-5">
        {categories.length === 0 ? (
          <EmptyState
            image={<SearchMd size={36} className="text-muted-foreground" />}
            title="No templates found"
            description={`No templates match "${search}"`}
          />
        ) : (
          <div className="flex flex-col gap-8">
            {categories.map((cat) => (
              <div key={cat.label} className="flex flex-col gap-3">
                <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider font-mono">
                  {cat.label}
                </span>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                  {cat.specs.map((spec) => (
                    <TemplateCard
                      key={spec.title}
                      spec={spec}
                      installedApps={installedApps}
                      onClick={() => setSelectedSpec(spec)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <TemplateDetailDialog
        spec={selectedSpec}
        open={selectedSpec !== null}
        onOpenChange={(open) => !open && setSelectedSpec(null)}
        installedApps={installedApps}
        onInstall={handleInstall}
        isInstalling={isInstalling}
      />
    </div>
  );
}
