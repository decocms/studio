import { useState, useRef, useEffect } from "react";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import {
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import type { VmMapEntry } from "@decocms/mesh-sdk";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";
import { useInsetContext } from "@/web/layouts/agent-shell-layout";
import {
  Loading01,
  Play,
  StopCircle,
  ChevronDown,
  Plus,
  MessageChatCircle,
  LinkExternal01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useChatBridge, useChatTask } from "@/web/components/chat/context";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { VmErrorState } from "../vm-error-state";
import { VmSuspendedState } from "../vm-suspended-state";
import { useVmEvents } from "../hooks/use-vm-events";
import {
  useIsVmStartPending,
  useVmStart,
  vmUserStop,
} from "../hooks/use-vm-start";
import { VmTerminal } from "./terminal";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { EmptyState } from "../../empty-state";
import { LiveTimer } from "../../live-timer";
import { useActiveGithubRepo } from "@/web/hooks/use-active-github-repo";
import { authClient } from "@/web/lib/auth-client";
import { PACKAGE_MANAGER_CONFIG } from "@/shared/runtime-defaults";
import type { PackageManager } from "@/shared/runtime-defaults";
import { toast } from "sonner";

interface VmData {
  /** Null for blank/tool sandboxes (no dev server). Mirrors SDK schema; today VM_START always provisions one. */
  previewUrl: string | null;
  vmId: string;
  branch: string;
  isNewVm: boolean;
  runnerKind?: "host" | "docker" | "freestyle" | "agent-sandbox";
}

type ViewStatus =
  | "idle"
  | "creating"
  | "running"
  | "suspended"
  | "stopping"
  | "error";

const WELL_KNOWN_STARTERS = ["dev", "start"];

export function EnvContent({ daemonOpen = false }: { daemonOpen?: boolean }) {
  const { org } = useProjectContext();
  const inset = useInsetContext();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();

  // thread.branch is the only source for vmMap resolution.
  const { currentBranch, setCurrentTaskBranch } = useChatTask();
  const userId = session?.user?.id;
  const vmMapMetadata = inset?.entity?.metadata as
    | { vmMap?: Record<string, Record<string, VmMapEntry>> }
    | undefined;
  const existingVm =
    userId && currentBranch
      ? vmMapMetadata?.vmMap?.[userId]?.[currentBranch]
      : undefined;

  const vmData: VmData | null =
    existingVm && currentBranch
      ? {
          previewUrl: existingVm.previewUrl,
          vmId: existingVm.vmId,
          branch: currentBranch,
          isNewVm: false,
          runnerKind: existingVm.runnerKind,
        }
      : null;

  // Transient override used during user-initiated transitions
  // ("creating" / "stopping" / "error"). Cleared via effect below once the
  // derived status catches up.
  const [override, setOverride] = useState<ViewStatus | null>(null);

  const [statusLabel, setStatusLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [execInFlight, setExecInFlight] = useState(false);
  // Tracks scripts whose kill request is in flight or whose underlying
  // running-state hasn't yet caught up with the kill — drives the
  // transient "Stopping…" affordance on the run/restart button. Cleared
  // either by the sync prune below (state confirms not-running) or by
  // handleKill itself on request error (revert to "Restart").
  const [killingScripts, setKillingScripts] = useState<Set<string>>(new Set());
  const startingRef = useRef(false);
  const startedAtRef = useRef<number>(Date.now());

  const [activeTab, setActiveTabRaw] = useState<string>("setup");
  const [openScriptTabs, setOpenScriptTabs] = useState<string[]>([]);
  const terminalRefs = useRef(new Map<string, XTerminal>());

  const { sendMessage } = useChatBridge();
  const { setChatOpen } = usePanelActions();

  const [hasSelection, setHasSelection] = useState(false);
  const getSelectedTextRef = useRef<(() => string) | null>(null);

  const setActiveTab = (tab: string) => {
    setActiveTabRaw(tab);
    setHasSelection(false);
    getSelectedTextRef.current = null;
  };

  const handleSelectionChange = (
    tab: string,
    has: boolean,
    getText: () => string,
  ) => {
    if (tab !== activeTab) return;
    setHasSelection(has);
    getSelectedTextRef.current = has ? getText : null;
  };

  const handleAddToChat = () => {
    const text = getSelectedTextRef.current?.();
    if (!text) return;
    setChatOpen(true);
    sendMessage({
      parts: [{ type: "text", text: `<server-logs>\n${text}\n</server-logs>` }],
    });
    const activeTerminal = terminalRefs.current.get(activeTab);
    activeTerminal?.clearSelection();
  };

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const vmEvents = useVmEvents();

  const vmStartPending = useIsVmStartPending(
    inset?.entity?.id,
    currentBranch ?? undefined,
  );
  const derivedStatus: ViewStatus = vmEvents.suspended
    ? "suspended"
    : vmEvents.notFound
      ? "creating"
      : vmData
        ? "running"
        : vmStartPending
          ? "creating"
          : "idle";
  const status: ViewStatus = override ?? derivedStatus;

  // Clear the override when the derived state catches up.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — clears transient override once derivedStatus catches up; no render-time equivalent for "wait for external async state to reach a target"
  useEffect(() => {
    if (override === "creating" && derivedStatus === "running") {
      setOverride(null);
    }
    if (override === "stopping" && derivedStatus === "idle") {
      setOverride(null);
    }
  }, [derivedStatus, override]);

  // Prune `killingScripts` entries once SSE confirms the process stopped:
  // checks activeProcesses uniformly across all script types.
  // Render-time setState is fine here — React bails out when the next set is equal.
  if (killingScripts.size > 0) {
    let changed = false;
    const next = new Set(killingScripts);
    for (const name of killingScripts) {
      const stillRunning = vmEvents.activeProcesses.includes(name);
      if (!stillRunning) {
        next.delete(name);
        changed = true;
      }
    }
    if (changed) setKillingScripts(next);
  }

  // Self-heal stale vmMap entries: SSE probe flips notFound on 404, VM_START
  // writes a fresh entry. Dedup by dead vmId to avoid looping on repeat 404s.
  // Routed through useVmStart so MCP protocol errors surface (see call-vm-tool).
  const selfHealStart = useVmStart(client);
  const { mutate: triggerSelfHeal, isPending: selfHealPending } = selfHealStart;
  const virtualMcpId = inset?.entity?.id;
  const deadVmId = vmEvents.notFound ? (existingVm?.vmId ?? null) : null;
  const reprovisionedForVmIdRef = useRef<string | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — one-shot reprovision trigger gated on the notFound→deadVmId derivation
  useEffect(() => {
    if (!deadVmId || !virtualMcpId) return;
    if (selfHealPending) return;
    if (reprovisionedForVmIdRef.current === deadVmId) return;
    reprovisionedForVmIdRef.current = deadVmId;
    const args: { virtualMcpId: string; branch?: string } = { virtualMcpId };
    if (currentBranch) args.branch = currentBranch;
    triggerSelfHeal(args, {
      onError: (err) => {
        console.error("[env] reprovision VM_START failed", err);
      },
    });
  }, [deadVmId, virtualMcpId, currentBranch, selfHealPending, triggerSelfHeal]);

  const scriptsAppliedRef = useRef(false);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — responds to vmEvents.scripts discovery; drives one-time tab auto-open
  useEffect(() => {
    if (vmEvents.scripts.length > 0 && !scriptsAppliedRef.current) {
      scriptsAppliedRef.current = true;
      for (const name of WELL_KNOWN_STARTERS) {
        if (vmEvents.scripts.includes(name)) {
          setOpenScriptTabs([name]);
          setActiveTab(name);
          break;
        }
      }
    }
  }, [vmEvents.scripts]);

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ text?: string }> }).content;
    if (content?.[0]?.text?.startsWith("Error:")) {
      throw new Error(content[0].text);
    }
    return (
      (result as { structuredContent?: unknown }).structuredContent ?? result
    );
  };

  const handleExec = async (scriptName: string) => {
    if (execInFlight || !vmData || !virtualMcpId || !currentBranch) return;
    setExecInFlight(true);
    try {
      const qs = new URLSearchParams({
        virtualMcpId,
        branch: currentBranch,
      }).toString();
      const res = await fetch(
        `/api/${encodeURIComponent(org.slug)}/vm-exec/exec/${encodeURIComponent(scriptName)}?${qs}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Exec failed: ${res.statusText}`);
    } finally {
      setExecInFlight(false);
    }
  };

  const handleKill = async (scriptName: string) => {
    if (!vmData || !virtualMcpId || !currentBranch) return;
    if (killingScripts.has(scriptName)) return;
    setKillingScripts((prev) => {
      const next = new Set(prev);
      next.add(scriptName);
      return next;
    });
    try {
      const qs = new URLSearchParams({
        virtualMcpId,
        branch: currentBranch,
      }).toString();
      const res = await fetch(
        `/api/${encodeURIComponent(org.slug)}/vm-exec/kill/${encodeURIComponent(scriptName)}?${qs}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Kill failed: ${res.statusText}`);
      // Leave the entry in `killingScripts`; the render-time prune below
      // clears it once SSE confirms the process is no longer running.
    } catch {
      setKillingScripts((prev) => {
        const next = new Set(prev);
        next.delete(scriptName);
        return next;
      });
      toast.error(`Failed to stop ${scriptName}`);
    }
  };

  const handleAddScript = (scriptName: string) => {
    if (!openScriptTabs.includes(scriptName)) {
      setOpenScriptTabs((prev) => [...prev, scriptName]);
    }
    setActiveTab(scriptName);
    handleExec(scriptName);
  };

  const handleStart = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    if (inset?.entity?.id && currentBranch) {
      vmUserStop.clear(inset.entity.id, currentBranch);
    }
    startedAtRef.current = Date.now();
    setOverride("creating");
    setStatusLabel("Connecting...");
    setErrorMsg("");
    scriptsAppliedRef.current = false;
    setOpenScriptTabs([]);
    setActiveTab("setup");

    try {
      if (!inset?.entity) throw new Error("No virtual MCP context");
      const args: { virtualMcpId: string; branch?: string } = {
        virtualMcpId: inset.entity.id,
      };
      if (currentBranch) args.branch = currentBranch;
      const data = (await callTool("VM_START", args)) as VmData;

      if (!data.vmId || !data.branch) {
        throw new Error("Invalid VM response — missing fields");
      }

      // Server-generated branch: persist so subsequent renders resolve via vmMap[userId][branch].
      if (!currentBranch) {
        setCurrentTaskBranch(data.branch);
      }
      setStatusLabel("");
      invalidateVirtualMcpQueries(queryClient);
      // override stays "creating" until the vmMap refetch populates vmData,
      // at which point the sync-effect above flips it to null → derivedStatus
      // takes over as "running".
    } catch (error) {
      setOverride("error");
      setErrorMsg(
        error instanceof Error ? error.message : "Failed to start VM",
      );
    } finally {
      startingRef.current = false;
    }
  };

  const handleStop = async () => {
    const branchToStop = vmData?.branch ?? currentBranch;
    setOverride("stopping");

    const virtualMcpId = inset?.entity?.id;
    if (virtualMcpId && branchToStop)
      vmUserStop.mark(virtualMcpId, branchToStop);
    if (virtualMcpId && branchToStop) {
      try {
        await client.callTool({
          name: "VM_DELETE",
          arguments: { virtualMcpId, branch: branchToStop },
        });
      } catch {
        // Best effort
      }
    }

    invalidateVirtualMcpQueries(queryClient);
    // override stays "stopping" until the vmMap refetch removes the entry,
    // at which point the sync-effect above flips it to null → derivedStatus
    // takes over as "idle".
  };

  const githubRepo = useActiveGithubRepo();

  const runtime = (
    inset?.entity?.metadata as
      | { runtime?: { selected: string | null; port?: string | null } | null }
      | undefined
  )?.runtime;
  const NONE_VALUE = "__none__";
  const packageManagers = Object.keys(
    PACKAGE_MANAGER_CONFIG,
  ) as PackageManager[];

  const handleFieldUpdate = async (
    field: "selected" | "port",
    value: string | null,
  ) => {
    if (!inset?.entity) return;
    try {
      await client.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: inset.entity.id,
          data: {
            metadata: {
              runtime: {
                ...runtime,
                [field]: value,
              },
            },
          },
        },
      });
      invalidateVirtualMcpQueries(queryClient);
    } catch {
      toast.error("Failed to update setting");
    }
  };

  // VM stopped — show config + Start. Repo card only renders when one is connected;
  // the daemon supports a blank-clone bootstrap so the rest of the panel still works.
  if (status === "idle" || status === "stopping") {
    const isStopping = status === "stopping";
    return (
      <div className="flex flex-col items-center justify-center w-full h-full p-6">
        <div className="flex flex-col gap-4 w-full max-w-xs">
          {githubRepo && (
            <a
              href={`https://github.com/${githubRepo.owner}/${githubRepo.name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 rounded-lg border border-border hover:bg-accent/50 transition-colors"
            >
              <GitHubIcon size={24} />
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-sm font-medium truncate">
                  {githubRepo.owner}/{githubRepo.name}
                </span>
                <span className="text-xs text-muted-foreground truncate">
                  github.com/{githubRepo.owner}/{githubRepo.name}
                </span>
              </div>
              <LinkExternal01
                size={14}
                className="text-muted-foreground shrink-0"
              />
            </a>
          )}

          <div className="flex flex-wrap items-end justify-between gap-2 w-full">
            <div className="flex flex-col gap-1">
              <Label htmlFor="env-runtime" className="text-xs font-medium">
                Runtime
              </Label>
              <Select
                value={runtime?.selected ?? NONE_VALUE}
                onValueChange={(v) =>
                  handleFieldUpdate("selected", v === NONE_VALUE ? null : v)
                }
              >
                <SelectTrigger id="env-runtime" className="w-28">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>None</SelectItem>
                  {packageManagers.map((pm) => (
                    <SelectItem key={pm} value={pm}>
                      {pm}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="env-port" className="text-xs font-medium">
                Port
              </Label>
              <Input
                id="env-port"
                placeholder="3001"
                className="w-20 h-8"
                defaultValue={runtime?.port ?? ""}
                onBlur={(e) =>
                  handleFieldUpdate("port", e.target.value || null)
                }
              />
            </div>
            <Button onClick={handleStart} disabled={isStopping}>
              {isStopping ? (
                <Loading01 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {isStopping ? "Stopping..." : "Run"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "creating") {
    const label = vmEvents.notFound
      ? "Sandbox was stopped, we're restarting it…"
      : statusLabel;
    return (
      <div className="flex flex-col items-center justify-center w-full h-full gap-4">
        <Loading01 size={24} className="animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{label}</p>
        <LiveTimer since={startedAtRef.current} />
      </div>
    );
  }

  if (status === "error") {
    return <VmErrorState errorMsg={errorMsg} onRetry={handleStart} />;
  }

  if (status === "suspended") {
    return <VmSuspendedState onResume={handleStart} />;
  }

  const allTabs = [
    "setup",
    ...openScriptTabs,
    ...(daemonOpen ? ["daemon"] : []),
  ];

  const addableScripts = vmEvents.scripts.filter(
    (s) => !openScriptTabs.includes(s),
  );

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex flex-col h-full">
        {/* Terminal tabs + action bar */}
        <div className="flex h-12 items-center border-b border-border px-2 shrink-0">
          {allTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex items-center h-full px-3 text-sm whitespace-nowrap border-b-2 mb-[-1px] capitalize transition-all hover:text-foreground",
                activeTab === tab
                  ? "text-foreground border-primary"
                  : "text-muted-foreground border-transparent",
              )}
            >
              {tab}
            </button>
          ))}

          {addableScripts.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center h-full px-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {addableScripts.map((script) => (
                  <DropdownMenuItem
                    key={script}
                    onClick={() => handleAddScript(script)}
                  >
                    {script}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <div className="flex-1 flex justify-center">
            {vmData?.vmId && (
              <div className="flex items-center">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded-l bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors border-r border-border/50"
                      onClick={() =>
                        navigator.clipboard.writeText(vmData?.vmId ?? "")
                      }
                    >
                      {vmData.vmId}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy VM ID</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 self-stretch rounded-r bg-muted px-0.5 text-[10px] text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors"
                    >
                      <ChevronDown size={10} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center">
                    <DropdownMenuItem onClick={handleStop}>
                      <StopCircle size={12} />
                      Stop Server
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            {hasSelection && (
              <button
                type="button"
                onClick={handleAddToChat}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <MessageChatCircle size={12} />
                Add to chat
              </button>
            )}
            {activeTab !== "setup" &&
              activeTab !== "daemon" &&
              openScriptTabs.includes(activeTab) &&
              (() => {
                const isRunning = vmEvents.activeProcesses.includes(activeTab);
                const isKilling = killingScripts.has(activeTab);
                // Hide the dropdown chevron during the Stopping… window so a
                // second Stop click can't double-fire while the first is in
                // flight; the prune effect removes it once SSE confirms idle.
                const showRunningAffordance = isRunning && !isKilling;
                const busy = execInFlight || isKilling;
                const onRun = () => handleExec(activeTab);
                const onStop = () => handleKill(activeTab);
                const label = execInFlight
                  ? "Running..."
                  : isKilling
                    ? "Stopping..."
                    : isRunning
                      ? "Restart"
                      : "Run";
                return (
                  <div className="flex items-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onRun}
                      className={cn(
                        "flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50",
                        showRunningAffordance
                          ? "rounded-l-md border-r-0"
                          : "rounded-md",
                      )}
                    >
                      {busy ? (
                        <Loading01 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} />
                      )}
                      {label}
                    </button>
                    {showRunningAffordance && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={busy}
                            className="flex items-center self-stretch rounded-r-md border border-border px-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                          >
                            <ChevronDown size={12} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={onStop}>
                            <StopCircle size={12} />
                            Stop
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              })()}
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {allTabs.map((tab) => (
            <div
              key={tab}
              className={cn("h-full", activeTab === tab ? "block" : "hidden")}
            >
              {vmEvents.hasData(tab) || tab === "setup" || tab === "daemon" ? (
                <VmTerminal
                  source={tab}
                  onReady={(t) => {
                    terminalRefs.current.set(tab, t);
                  }}
                  onSelectionChange={(has, getText) =>
                    handleSelectionChange(tab, has, getText)
                  }
                  className="h-full"
                />
              ) : (
                <EmptyState
                  className="h-full"
                  image={null}
                  title={`Script "${tab}" not running`}
                  description={`Click Run to start "${tab}".`}
                  actions={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={execInFlight}
                      onClick={() => handleExec(tab)}
                    >
                      {execInFlight ? (
                        <Loading01 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      Run
                    </Button>
                  }
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
