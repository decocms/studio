import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SELF_MCP_ALIAS_ID,
  useChatBridge,
  useMCPClientOptional,
  useProjectContext,
  Locator,
} from "@decocms/mesh-sdk";
import { useAiProviderKeyList } from "@/web/hooks/collections/use-llm";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useConnectionWatch } from "@/web/hooks/use-connection-watch";
import { KEYS } from "@/web/lib/query-keys";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  gitBranch,
  gitBranchList,
  gitCheckoutBranch,
  gitStatus,
  gitDiff,
  gitLog,
  gitCommit,
  gitCheckoutNewBranch,
  type ChangedFile,
} from "@/web/lib/git-api";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@deco/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  AlertTriangle,
  Check,
  GitBranch01,
  GitCommit as GitCommitIcon,
  Loading01,
  File06,
  Plus,
  Minus,
  Edit04,
  RefreshCw01,
  ChevronDown,
  ChevronRight,
  Stars01,
} from "@untitledui/icons";

const GIT_QUERY_KEYS = {
  branch: KEYS.gitBranch,
  branchList: KEYS.gitBranchList,
  status: KEYS.gitStatus,
  diff: KEYS.gitDiff,
  log: KEYS.gitLog,
};

// ============================================================================
// AI Helpers
// ============================================================================

/** Keywords to match cheap/fast models, in priority order */
const FAST_MODEL_KEYWORDS = [
  "haiku",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash",
  "flash-lite",
  "ministral",
];

/**
 * Call LLM_DO_GENERATE on a model connection's MCP client.
 */
async function llmGenerate(
  modelClient: Client,
  modelId: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("LLM generation timed out")), 15_000),
  );
  const result = await Promise.race([
    modelClient.callTool({
      name: "LLM_DO_GENERATE",
      arguments: {
        modelId,
        callOptions: {
          prompt: [
            { role: "system", content: systemPrompt },
            { role: "user", content: [{ type: "text", text: userMessage }] },
          ],
          maxOutputTokens: 500,
          temperature: 0,
          providerOptions: {
            openrouter: { reasoning: { exclude: true } },
          },
        },
      },
    }),
    timeout,
  ]);

  // structuredContent follows LanguageModelGenerateOutputSchema:
  // { content: [{ type: "text", text: "..." }, ...], finishReason, usage }
  const structured = result.structuredContent as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  if (structured?.content) {
    const textPart = structured.content.find((p) => p.type === "text");
    if (textPart?.text) return textPart.text.trim();
  }

  // Fallback: parse from MCP text content envelope
  if (result.content && Array.isArray(result.content)) {
    const textEntry = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    if (textEntry) {
      try {
        const parsed = JSON.parse((textEntry as { text: string }).text);
        // Could be the full output schema wrapped in text
        const inner = parsed.content ?? parsed;
        if (Array.isArray(inner)) {
          const tp = inner.find((p: { type: string }) => p.type === "text");
          if (tp?.text) return tp.text.trim();
        }
        if (parsed.text) return parsed.text.trim();
      } catch {
        return (textEntry as { text: string }).text.trim();
      }
    }
  }
  return "";
}

/**
 * List available models from the model connection and pick the cheapest fast one.
 */
async function pickFastModel(modelClient: Client): Promise<string | null> {
  try {
    const result = await modelClient.callTool({
      name: "COLLECTION_LLM_LIST",
      arguments: {},
    });
    const structured = result.structuredContent as
      | { items?: { id: string }[] }
      | undefined;
    const items = structured?.items ?? [];
    const ids = items.map((m) => m.id);

    for (const keyword of FAST_MODEL_KEYWORDS) {
      const match = ids.find((id) => id.toLowerCase().includes(keyword));
      if (match) return match;
    }
    // Fallback to first available model
    return ids[0] ?? null;
  } catch {
    return null;
  }
}

const COMMIT_MESSAGE_PROMPT = `You generate concise git commit messages. Given a diff and list of changed files, write a single-line commit message following conventional commits format (e.g. "feat: ...", "fix: ...", "chore: ..."). No explanation, just the message. Max 72 characters.`;

/**
 * Hook to check if AI commit messages are available.
 * Uses the new AI provider key system — if there's at least one key,
 * we can use the self MCP's LLM_DO_GENERATE tool.
 */
function useModelClient(): {
  modelClient: Client | null;
  modelId: string | null;
} {
  const { org } = useProjectContext();
  let keys: { id: string }[] = [];
  try {
    keys = useAiProviderKeyList();
  } catch {
    // Suspense boundary may not be present; treat as no keys
  }
  const hasKeys = keys.length > 0;

  const modelClient = useMCPClientOptional({
    connectionId: hasKeys ? SELF_MCP_ALIAS_ID : undefined,
    orgId: org.id,
  });

  return { modelClient: hasKeys ? modelClient : null, modelId: null };
}

// ============================================================================
// Status helpers
// ============================================================================

function statusIcon(status: ChangedFile["status"]) {
  switch (status) {
    case "M":
      return <Edit04 size={14} className="text-yellow-500" />;
    case "A":
    case "?":
      return <Plus size={14} className="text-green-500" />;
    case "D":
      return <Minus size={14} className="text-red-500" />;
    default:
      return <File06 size={14} className="text-muted-foreground" />;
  }
}

function statusLabel(status: ChangedFile["status"]) {
  switch (status) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "?":
      return "Untracked";
    case "R":
      return "Renamed";
    default:
      return status;
  }
}

// ============================================================================
// Branch Section
// ============================================================================

function BranchSection({
  client,
  connectionId,
  watcher,
}: {
  client: Client;
  connectionId: string;
  watcher: { pause: () => void; resume: () => void };
}) {
  const queryClient = useQueryClient();

  const { data: branch, isLoading } = useQuery({
    queryKey: GIT_QUERY_KEYS.branch(connectionId),
    queryFn: () => gitBranch(client),
    staleTime: 10_000,
  });

  const { data: branches = [] } = useQuery({
    queryKey: GIT_QUERY_KEYS.branchList(connectionId),
    queryFn: () => gitBranchList(client),
    staleTime: 30_000,
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.branch(connectionId),
    });
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.branchList(connectionId),
    });
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.status(connectionId),
    });
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.log(connectionId),
    });
  };

  const switchBranch = useMutation({
    mutationFn: async (name: string) => {
      watcher.pause();
      const result = await gitCheckoutBranch(client, name);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            "Failed to switch branch",
        );
      }
      return result;
    },
    onSettled: () => {
      setTimeout(() => watcher.resume(), 1000);
      invalidateAll();
    },
  });

  const createBranch = useMutation({
    mutationFn: async (name: string) => {
      watcher.pause();
      const result = await gitCheckoutNewBranch(client, name);
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() ||
            result.stdout.trim() ||
            "Failed to create branch",
        );
      }
      return result;
    },
    onSettled: () => {
      setTimeout(() => watcher.resume(), 1000);
      invalidateAll();
    },
  });

  const isMain = branch === "main" || branch === "master";
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loading01 size={14} className="animate-spin" />
        Loading branch...
      </div>
    );
  }

  // Determine if search value could be a new branch name (no exact match)
  const trimmedSearch = searchValue.trim();
  const isNewBranch =
    trimmedSearch.length > 0 &&
    !branches.some((b) => b.toLowerCase() === trimmedSearch.toLowerCase());

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={switchBranch.isPending}
              className="flex items-center gap-2 min-w-0 text-sm font-medium hover:bg-muted/50 rounded px-1.5 py-1 -ml-1.5 transition-colors"
            >
              <GitBranch01
                size={16}
                className="text-muted-foreground shrink-0"
              />
              <span className="truncate">{branch}</span>
              <ChevronDown
                size={14}
                className="text-muted-foreground shrink-0"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[280px] p-0" align="start">
            <Command shouldFilter={true}>
              <CommandInput
                placeholder="Switch or create branch..."
                value={searchValue}
                onValueChange={setSearchValue}
              />
              <CommandList>
                <CommandEmpty>No branches found.</CommandEmpty>
                <CommandGroup heading="Branches">
                  {branches.map((b) => (
                    <CommandItem
                      key={b}
                      value={b}
                      onSelect={() => {
                        if (b !== branch) {
                          switchBranch.mutate(b);
                        }
                        setOpen(false);
                        setSearchValue("");
                      }}
                    >
                      <GitBranch01 size={14} className="shrink-0" />
                      <span className="truncate">{b}</span>
                      {b === branch && (
                        <Check
                          size={14}
                          className="ml-auto shrink-0 text-foreground"
                        />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {isNewBranch && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Create">
                      <CommandItem
                        value={`create:${trimmedSearch}`}
                        onSelect={() => {
                          createBranch.mutate(trimmedSearch);
                          setOpen(false);
                          setSearchValue("");
                        }}
                      >
                        <Plus size={14} className="shrink-0" />
                        <span className="truncate">
                          Create <strong>{trimmedSearch}</strong>
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {isMain && (
          <Badge
            variant="outline"
            className="text-yellow-600 border-yellow-600/30 text-xs shrink-0"
          >
            <AlertTriangle size={12} className="mr-1" />
            main
          </Badge>
        )}
      </div>

      {(switchBranch.isError || createBranch.isError) && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm">
          <p className="text-destructive font-medium mb-1">
            <AlertTriangle size={12} className="inline mr-1.5" />
            {switchBranch.isError
              ? "Cannot switch branch"
              : "Cannot create branch"}
          </p>
          <pre className="text-muted-foreground text-xs whitespace-pre-wrap break-words">
            {(switchBranch.error ?? createBranch.error)?.message}
          </pre>
        </div>
      )}

      {isMain && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm">
          <p className="text-yellow-600 font-medium mb-2">
            You're on the main branch
          </p>
          <p className="text-muted-foreground text-xs mb-2">
            Create a new branch before committing changes.
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Changed Files List
// ============================================================================

function ChangedFilesList({
  client,
  connectionId,
  onFileClick,
}: {
  client: Client;
  connectionId: string;
  onFileClick?: (filePath: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);

  const { data: files = [], isLoading } = useQuery({
    queryKey: GIT_QUERY_KEYS.status(connectionId),
    queryFn: () => gitStatus(client),
    staleTime: 10_000,
  });

  const { data: diff } = useQuery({
    queryKey: GIT_QUERY_KEYS.diff(connectionId),
    queryFn: () => gitDiff(client),
    enabled: showDiff && files.length > 0,
    staleTime: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loading01 size={14} className="animate-spin" />
        Checking for changes...
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-2">
        <Check size={14} className="inline mr-1.5 text-green-500" />
        No uncommitted changes
      </div>
    );
  }

  return (
    <div className="space-y-2 min-w-0">
      <button
        type="button"
        onClick={() => setShowDiff(!showDiff)}
        className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80"
      >
        {showDiff ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {files.length} changed {files.length === 1 ? "file" : "files"}
      </button>
      <div className="space-y-0.5">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onFileClick?.(file.path)}
            className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-muted/50 min-w-0 w-full text-left"
          >
            <span className="shrink-0">{statusIcon(file.status)}</span>
            <span className="truncate flex-1 font-mono">{file.path}</span>
            <span className="text-muted-foreground shrink-0">
              {statusLabel(file.status)}
            </span>
          </button>
        ))}
      </div>

      {showDiff && diff && (
        <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 overflow-x-auto max-h-60 whitespace-pre-wrap break-all">
          {diff}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// Commit Form
// ============================================================================

function CommitForm({
  client,
  connectionId,
  modelClient,
  watcher,
  onCommitted,
}: {
  client: Client;
  connectionId: string;
  modelClient: Client | null;
  watcher: { pause: () => void; resume: () => void };
  onCommitted?: () => void;
}) {
  const queryClient = useQueryClient();
  const chatBridge = useChatBridge();
  const [message, setMessage] = useState("");

  const { data: files = [] } = useQuery({
    queryKey: GIT_QUERY_KEYS.status(connectionId),
    queryFn: () => gitStatus(client),
    staleTime: 10_000,
  });

  const { data: branch } = useQuery({
    queryKey: GIT_QUERY_KEYS.branch(connectionId),
    queryFn: () => gitBranch(client),
    staleTime: 10_000,
  });

  const invalidateAfterCommit = () => {
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.status(connectionId),
    });
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.log(connectionId),
    });
    queryClient.invalidateQueries({
      queryKey: GIT_QUERY_KEYS.diff(connectionId),
    });
  };

  const commit = useMutation({
    mutationFn: async (msg: string) => {
      watcher.pause();
      const result = await gitCommit(client, msg);
      if (result.exitCode !== 0) {
        const errorMsg =
          result.stderr.trim() || result.stdout.trim() || "Commit failed";
        throw new Error(errorMsg);
      }
      return result;
    },
    onSuccess: () => {
      setMessage("");
      // Cancel in-flight refetches (e.g. from the topbar watcher reacting to
      // pre-commit hook file writes) so they don't overwrite the optimistic data.
      queryClient.cancelQueries({
        queryKey: GIT_QUERY_KEYS.status(connectionId),
      });
      queryClient.cancelQueries({
        queryKey: GIT_QUERY_KEYS.diff(connectionId),
      });
      // Optimistically clear status so the topbar button updates instantly
      queryClient.setQueryData(GIT_QUERY_KEYS.status(connectionId), []);
      queryClient.setQueryData(GIT_QUERY_KEYS.diff(connectionId), "");
      onCommitted?.();
    },
    onSettled: () => {
      // Resume watcher after a delay to let filesystem settle, then
      // invalidate so the real status is fetched once things are stable.
      setTimeout(() => {
        watcher.resume();
        invalidateAfterCommit();
      }, 1000);
    },
  });

  const generateMessage = useMutation({
    mutationFn: async () => {
      if (!modelClient || files.length === 0) return "";
      const modelId = await pickFastModel(modelClient);
      if (!modelId) return "";

      const diff = await gitDiff(client);
      const fileList = files.map((f) => `${f.status} ${f.path}`).join("\n");
      const context = `Changed files:\n${fileList}\n\nDiff (truncated):\n${diff.slice(0, 3000)}`;

      const result = await llmGenerate(
        modelClient,
        modelId,
        COMMIT_MESSAGE_PROMPT,
        context,
      );
      return result ? result.replace(/^["']|["']$/g, "") : "";
    },
    onSuccess: (msg) => {
      if (msg) setMessage(msg);
    },
  });

  const isMain = branch === "main" || branch === "master";
  const canCommit = files.length > 0 && message.trim() && !isMain;
  const hasChanges = files.length > 0;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            generateMessage.isPending
              ? "Generating commit message..."
              : "Describe your changes..."
          }
          className="text-sm min-h-[80px] resize-none"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
              commit.mutate(message.trim());
            }
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground shrink-0">
          {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Enter
        </span>
        <div className="flex items-center gap-1.5">
          {modelClient && hasChanges && (
            <Button
              size="sm"
              variant="outline"
              disabled={generateMessage.isPending}
              onClick={() => generateMessage.mutate()}
              title="Generate commit message with AI"
            >
              {generateMessage.isPending ? (
                <Loading01 size={14} className="animate-spin" />
              ) : (
                <Stars01 size={14} />
              )}
            </Button>
          )}
          <Button
            size="sm"
            disabled={!canCommit || commit.isPending}
            onClick={() => commit.mutate(message.trim())}
          >
            {commit.isPending ? (
              <Loading01 size={14} className="animate-spin mr-1.5" />
            ) : (
              <GitCommitIcon size={14} className="mr-1.5" />
            )}
            Commit
          </Button>
        </div>
      </div>
      {commit.isError && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-2">
          <p className="text-destructive font-medium text-xs">
            <AlertTriangle size={12} className="inline mr-1.5" />
            Commit failed
          </p>
          <pre className="text-muted-foreground text-xs font-mono whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto bg-background/50 rounded p-2">
            {commit.error.message}
          </pre>
          {chatBridge && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => {
                chatBridge.sendMessage(
                  `My pre-commit hook failed with the following error. Help me fix it:\n\n\`\`\`\n${commit.error.message}\n\`\`\``,
                );
              }}
            >
              <Stars01 size={14} className="mr-1.5" />
              Help me fix
            </Button>
          )}
        </div>
      )}
      {generateMessage.isError && (
        <p className="text-xs text-muted-foreground">
          Could not generate message — write one manually.
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Commit History
// ============================================================================

function CommitHistory({
  client,
  connectionId,
}: {
  client: Client;
  connectionId: string;
}) {
  const { data: commits = [], isLoading } = useQuery({
    queryKey: GIT_QUERY_KEYS.log(connectionId),
    queryFn: () => gitLog(client, 15),
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loading01 size={14} className="animate-spin" />
        Loading history...
      </div>
    );
  }

  if (commits.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No commits yet</p>;
  }

  return (
    <div className="space-y-0.5">
      {commits.map((commit) => (
        <div
          key={commit.hash}
          className="flex items-start gap-2 py-2 px-2 rounded hover:bg-muted/50 text-xs min-w-0"
        >
          <span className="font-mono text-muted-foreground shrink-0 pt-0.5">
            {commit.shortHash}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{commit.message}</p>
            <p className="text-muted-foreground truncate">
              {commit.author} &middot; {formatRelativeDate(commit.date)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// ============================================================================
// Main Panel
// ============================================================================

export function GitPanel({
  client,
  connectionId,
  connectionUrl,
  onClose,
}: {
  client: Client;
  connectionId: string;
  connectionUrl?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { modelClient } = useModelClient();
  const navigate = useNavigate();
  const { locator } = useProjectContext();
  const { org, project } = Locator.parse(locator);

  const handleFileClick = (filePath: string) => {
    navigate({
      to: "/$org/$project/$pluginId/viewer",
      params: { org, project, pluginId: "object-storage" },
      search: { key: filePath },
    });
    onClose();
  };

  const refreshAll = () => {
    queryClient.invalidateQueries({
      queryKey: ["git"],
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[2] === connectionId,
    });
  };

  // Invalidate git queries reactively via SSE file watch
  const watcher = useConnectionWatch(connectionId, connectionUrl, refreshAll);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h2 className="text-sm font-semibold">Save Changes</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshAll}
            className="h-7 w-7 p-0"
          >
            <RefreshCw01 size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
          >
            <span className="sr-only">Close</span>
            &times;
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="p-4 space-y-6">
          {/* Branch */}
          <section>
            <BranchSection
              client={client}
              connectionId={connectionId}
              watcher={watcher}
            />
          </section>

          {/* Changed Files */}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Changes
            </h3>
            <ChangedFilesList
              client={client}
              connectionId={connectionId}
              onFileClick={handleFileClick}
            />
          </section>

          {/* Commit Form */}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Commit
            </h3>
            <CommitForm
              client={client}
              connectionId={connectionId}
              modelClient={modelClient}
              watcher={watcher}
              onCommitted={onClose}
            />
          </section>

          {/* History */}
          <section>
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              History
            </h3>
            <CommitHistory client={client} connectionId={connectionId} />
          </section>
        </div>
      </div>
    </div>
  );
}
