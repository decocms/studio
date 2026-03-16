import { slugify } from "@/web/utils/slugify";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "@deco/ui/components/radio-group.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import {
  ArrowsRight,
  Check,
  ChevronDown,
  Code01,
  Copy01,
  InfoCircle,
  Key01,
  Lightbulb02,
  Loading01,
  Terminal,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Suspense, useState } from "react";
import { toast } from "sonner";

/**
 * Unicode-safe base64 encoding for browser environments
 */
function utf8ToBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary);
}

type AgentMode = "passthrough" | "smart_tool_selection" | "code_execution";

/**
 * Client card — colored icon bg + white logo + one-click action
 */
function ClientCard({
  logo,
  alt,
  label,
  bgColor,
  onClick,
  copied,
}: {
  logo: string;
  alt: string;
  label: string;
  bgColor: string;
  onClick: () => void;
  copied?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-ring/50 hover:bg-accent/5"
    >
      <div
        className="shrink-0 size-8 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: bgColor }}
      >
        {copied ? (
          <Check size={16} className="text-white" />
        ) : (
          <img
            src={logo}
            alt={alt}
            className="size-4"
            style={{ filter: "brightness(0) invert(1)" }}
          />
        )}
      </div>
      <span className="text-sm font-medium text-foreground">
        {copied ? "Copied!" : label}
      </span>
    </button>
  );
}

/**
 * Copy URL card — uses Copy icon instead of a logo
 */
function CopyUrlCard({
  onClick,
  copied,
}: {
  onClick: () => void;
  copied?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 text-left transition-colors hover:border-ring/50 hover:bg-accent/5"
    >
      <div className="shrink-0 size-8 rounded-lg bg-muted flex items-center justify-center">
        {copied ? (
          <Check size={16} className="text-green-600" />
        ) : (
          <Copy01 size={16} className="text-muted-foreground" />
        )}
      </div>
      <span className="text-sm font-medium text-foreground">
        {copied ? "Copied!" : "Copy URL"}
      </span>
    </button>
  );
}

/**
 * Typegen section inner — uses Suspense-based useMCPClient
 */
function TypegenSectionInner({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);

  const mcpId = virtualMcp.id;
  const agentName = virtualMcp.title || `agent-${mcpId.slice(0, 8)}`;
  const command = apiKey
    ? `bunx @decocms/typegen@latest --mcp ${mcpId} --key ${apiKey} --output client.ts`
    : `bunx @decocms/typegen@latest --mcp ${mcpId} --key <api-key> --output client.ts`;

  const meshUrl = window.location.origin;
  const keyLine = apiKey ? `MESH_API_KEY=${apiKey}` : `MESH_API_KEY=<api-key>`;
  const urlLine = `MESH_BASE_URL=${meshUrl}`;
  const envBlock = `${keyLine}\n${urlLine}`;

  const handleGenerateKey = async () => {
    setGenerating(true);
    try {
      const result = (await client.callTool({
        name: "API_KEY_CREATE",
        arguments: {
          name: `typegen-${agentName}`,
          permissions: { [mcpId]: ["*"] },
        },
      })) as { structuredContent?: { key?: string } };
      const key = result.structuredContent?.key;
      if (!key) throw new Error("No key in response");
      setApiKey(key);
    } catch {
      toast.error("Failed to generate API key");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCmd = async () => {
    await navigator.clipboard.writeText(command);
    setCopiedCmd(true);
    toast.success("Command copied");
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const handleCopyEnv = async () => {
    await navigator.clipboard.writeText(envBlock);
    setCopiedEnv(true);
    toast.success("Environment variables copied");
    setTimeout(() => setCopiedEnv(false), 2000);
  };

  return (
    <div className="flex flex-col gap-2">
      {apiKey && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Store this key securely — it won't be shown again.
        </p>
      )}

      <div className="rounded-md border border-input bg-muted/50 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
            {command}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCopyCmd}
          >
            {copiedCmd ? (
              <Check size={12} className="text-green-600" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-input bg-muted/50 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
            <span className={cn({ "opacity-50": !apiKey })}>{keyLine}</span>
            <br />
            <span>{urlLine}</span>
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={handleCopyEnv}
          >
            {copiedEnv ? (
              <Check size={12} className="text-green-600" />
            ) : (
              <Copy01 size={12} />
            )}
          </Button>
        </div>
      </div>

      {!apiKey && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start gap-1.5 mt-1"
          onClick={handleGenerateKey}
          disabled={generating}
        >
          {generating ? (
            <Loading01 size={14} className="animate-spin" />
          ) : (
            <Key01 size={14} />
          )}
          <span>{generating ? "Generating…" : "Generate API key"}</span>
        </Button>
      )}
    </div>
  );
}

function TypegenSection({ virtualMcp }: { virtualMcp: VirtualMCPEntity }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <Terminal size={14} />
        <span className="font-medium">Typed client</span>
        <ChevronDown
          size={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="pt-1 pb-1">
          <Suspense
            fallback={
              <div className="h-20 animate-pulse rounded-md bg-muted" />
            }
          >
            <TypegenSectionInner virtualMcp={virtualMcp} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * Share Modal - Virtual MCP sharing and IDE integration
 */
export function VirtualMCPShareModal({
  open,
  onOpenChange,
  virtualMcp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualMcp: VirtualMCPEntity;
}) {
  const [mode, setMode] = useState<AgentMode>("code_execution");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedClaude, setCopiedClaude] = useState(false);

  const handleModeChange = (value: string) => {
    if (
      value === "passthrough" ||
      value === "smart_tool_selection" ||
      value === "code_execution"
    ) {
      setMode(value);
    }
  };

  const virtualMcpUrl = new URL(
    `/mcp/virtual-mcp/${virtualMcp.id}`,
    window.location.origin,
  );
  virtualMcpUrl.searchParams.set("mode", mode);

  const serverName =
    virtualMcp.title || `agent-${virtualMcp.id?.slice(0, 8) ?? "default"}`;

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(virtualMcpUrl.href);
    setCopiedUrl(true);
    toast.success("Agent URL copied to clipboard");
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleInstallCursor = () => {
    const slugifiedServerName = slugify(serverName);
    const connectionConfig = {
      type: "http",
      url: virtualMcpUrl.href,
      headers: { "x-mesh-client": "Cursor" },
    };
    const base64Config = utf8ToBase64(
      JSON.stringify(connectionConfig, null, 2),
    );
    const deeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(slugifiedServerName)}&config=${encodeURIComponent(base64Config)}`;
    window.open(deeplink, "_blank");
    toast.success("Opening Cursor...");
  };

  const handleInstallClaude = async () => {
    const slugifiedServerName = slugify(serverName);
    const connectionConfig = {
      type: "http",
      url: virtualMcpUrl.href,
      headers: { "x-mesh-client": "Claude Code" },
    };
    const configJson = JSON.stringify(connectionConfig, null, 2);
    const command = `claude mcp add-json "${slugifiedServerName}" '${configJson.replace(/'/g, "'\\''")}'`;
    await navigator.clipboard.writeText(command);
    setCopiedClaude(true);
    toast.success("Claude Code command copied to clipboard");
    setTimeout(() => setCopiedClaude(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {/* Mode Selection — original radio card layout */}
          <div className="flex flex-col gap-3">
            <div>
              <h4 className="text-sm font-medium text-foreground mt-1">
                How should this agent work?
              </h4>
            </div>
            <RadioGroup
              value={mode}
              onValueChange={handleModeChange}
              className="flex flex-col gap-2"
            >
              {/* Passthrough Option */}
              <label
                htmlFor="mode-passthrough"
                className={cn(
                  "flex items-center gap-3 px-3 py-3 rounded-lg border cursor-pointer transition-colors",
                  mode === "passthrough"
                    ? "border-ring bg-accent/30"
                    : "border-border hover:border-ring/50",
                )}
              >
                <div className="p-1.5 shrink-0">
                  <ArrowsRight className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      Direct access
                    </span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <InfoCircle className="size-3.5 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">
                            All tools are exposed directly via tools/list. Best
                            for small tool surfaces with deterministic behavior.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Best for small teams or when you need predictable behavior
                  </p>
                </div>
                <RadioGroupItem id="mode-passthrough" value="passthrough" />
              </label>

              {/* Smart Tool Selection Option */}
              <label
                htmlFor="mode-smart"
                className={cn(
                  "flex items-center gap-3 px-3 py-3 rounded-lg border cursor-pointer transition-colors",
                  mode === "smart_tool_selection"
                    ? "border-ring bg-accent/30"
                    : "border-border hover:border-ring/50",
                )}
              >
                <div className="p-1.5 shrink-0">
                  <Lightbulb02 className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      Smart discovery
                    </span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <InfoCircle className="size-3.5 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">
                            Uses meta-tools (GATEWAY_SEARCH_TOOLS,
                            GATEWAY_DESCRIBE_TOOLS, GATEWAY_CALL_TOOL) to keep
                            the tool list small and request details on demand.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Ideal for large teams with many tools - AI finds what it
                    needs
                  </p>
                </div>
                <RadioGroupItem id="mode-smart" value="smart_tool_selection" />
              </label>

              {/* Code Execution Option */}
              <label
                htmlFor="mode-code"
                className={cn(
                  "relative flex items-center gap-3 px-3 py-3 rounded-lg border cursor-pointer transition-colors",
                  mode === "code_execution"
                    ? "border-ring bg-accent/30"
                    : "border-border hover:border-ring/50",
                )}
              >
                <div className="p-1.5 shrink-0">
                  <Code01 className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      Smart execution
                    </span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <InfoCircle className="size-3.5 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">
                            Exposes meta-tools for discovery + sandboxed
                            execution (GATEWAY_RUN_CODE). Reduces overhead on
                            large surfaces by shifting work into a controlled
                            runtime.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Maximum flexibility - AI can write code to orchestrate tools
                  </p>
                </div>
                <RadioGroupItem id="mode-code" value="code_execution" />
                <Badge
                  variant="outline"
                  className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-background z-10"
                >
                  Recommended
                </Badge>
              </label>
            </RadioGroup>
          </div>

          {/* Client actions */}
          <div className="flex flex-col gap-2">
            <ClientCard
              logo="/logos/cursor.svg"
              alt="Cursor"
              label="Install on Cursor"
              bgColor="#181818"
              onClick={handleInstallCursor}
            />
            <ClientCard
              logo="/logos/Claude Code.svg"
              alt="Claude Code"
              label="Install on Claude Code"
              bgColor="#D97757"
              onClick={handleInstallClaude}
              copied={copiedClaude}
            />
            <CopyUrlCard onClick={handleCopyUrl} copied={copiedUrl} />
          </div>

          {/* Typegen — collapsible */}
          <div className="border-t border-border pt-2">
            <TypegenSection virtualMcp={virtualMcp} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
