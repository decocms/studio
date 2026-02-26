import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  getPrompt,
  getWellKnownDecopilotVirtualMCP,
  useMCPClient,
  useMCPPromptsList,
  useProjectContext,
} from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { Suspense, useReducer, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "../error-boundary";
import { useChatStable } from "./context";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "./dialog-prompt-arguments";
import { createMentionDoc } from "./tiptap/mention/node";
import { appendToTiptapDoc } from "./tiptap/utils";

interface IceBreakersUIProps {
  prompts: Prompt[];
  onSelect: (prompt: Prompt) => void;
  loadingPrompt?: Prompt | null;
  className?: string;
}

const MAX_VISIBLE = 3;

function PromptPill({
  prompt,
  onSelect,
  isSelected,
  isDisabled,
  isLoading,
}: {
  prompt: Prompt;
  onSelect: (prompt: Prompt) => void;
  isSelected?: boolean;
  isDisabled?: boolean;
  isLoading?: boolean;
}) {
  const promptText = prompt.description ?? prompt.name;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(prompt)}
          disabled={isDisabled || isLoading}
          className={cn(
            "px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-full hover:bg-accent/50 transition-colors cursor-pointer flex items-center gap-1.5",
            isSelected && "bg-accent/50 text-foreground",
            isLoading && "bg-accent/50 text-foreground",
            (isDisabled || isLoading) &&
              "cursor-not-allowed hover:bg-accent/50",
          )}
        >
          {(prompt.title ?? prompt.name).replace(/_/g, " ")}
          {isLoading && <Spinner size="xs" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p className="text-xs">{promptText}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * IceBreakersUI - Displays prompts as clickable conversation starters
 *
 * Shows prompts as compact pills that, when clicked, submit the prompt as the first message
 */
function IceBreakersUI({
  prompts,
  onSelect,
  loadingPrompt,
  className,
}: IceBreakersUIProps) {
  if (prompts.length === 0) return null;

  const visiblePrompts = prompts.slice(0, MAX_VISIBLE);
  const hiddenPrompts = prompts.slice(MAX_VISIBLE);
  const hasMore = hiddenPrompts.length > 0;
  const isAnyLoading = !!loadingPrompt;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          "flex flex-wrap items-center justify-center gap-2",
          className,
        )}
      >
        {visiblePrompts.map((prompt) => (
          <PromptPill
            key={prompt.name}
            prompt={prompt}
            onSelect={onSelect}
            isLoading={loadingPrompt?.name === prompt.name}
            isDisabled={isAnyLoading && loadingPrompt?.name !== prompt.name}
          />
        ))}
        {hasMore && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={isAnyLoading}
                className={cn(
                  "size-7 flex items-center justify-center text-xs text-muted-foreground hover:text-foreground border border-border rounded-full hover:bg-accent/50 transition-colors cursor-pointer",
                  isAnyLoading && "opacity-60 cursor-not-allowed",
                )}
              >
                +{hiddenPrompts.length}
              </button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="center" className="w-auto p-2">
              <div className="flex flex-col gap-1">
                {hiddenPrompts.map((prompt) => {
                  const promptText = prompt.description ?? prompt.name;
                  const isLoading = loadingPrompt?.name === prompt.name;
                  return (
                    <Tooltip key={prompt.name}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(prompt)}
                          disabled={isAnyLoading && !isLoading}
                          className={cn(
                            "px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-md transition-colors cursor-pointer text-left flex items-center gap-1.5",
                            isLoading && "bg-accent/50 text-foreground",
                            isAnyLoading &&
                              !isLoading &&
                              "opacity-60 cursor-not-allowed",
                          )}
                        >
                          {(prompt.title ?? prompt.name).replace(/_/g, " ")}
                          {isLoading && <Spinner size="xs" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">{promptText}</p>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </TooltipProvider>
  );
}

interface IceBreakersProps {
  className?: string;
}

/**
 * Fallback component for Suspense that maintains min-height to prevent layout shift
 * Shows skeleton pills matching the actual IceBreakers appearance
 */
function IceBreakersFallback() {
  return (
    <>
      <Skeleton className="h-6 w-20 rounded-full border border-border" />
      <Skeleton className="h-6 w-24 rounded-full border border-border" />
    </>
  );
}

/**
 * State machine for ice breakers
 */
type IceBreakerState =
  | { stage: "idle" }
  | {
      stage: "loading";
      prompt: Prompt;
      arguments?: PromptArgumentValues;
    };

type IceBreakerAction =
  | { type: "SELECT_PROMPT"; prompt: Prompt }
  | {
      type: "START_LOADING";
      prompt: Prompt;
      arguments?: PromptArgumentValues;
    }
  | { type: "RESET" };

function iceBreakerReducer(
  state: IceBreakerState,
  action: IceBreakerAction,
): IceBreakerState {
  switch (action.type) {
    case "SELECT_PROMPT":
      // If prompt has no arguments, go directly to loading
      if (!action.prompt.arguments || action.prompt.arguments.length === 0) {
        return { stage: "loading", prompt: action.prompt };
      }
      // Otherwise, will open dialog - stay idle until dialog submits
      return { stage: "idle" };

    case "START_LOADING":
      return {
        stage: "loading",
        prompt: action.prompt,
        arguments: action.arguments,
      };

    case "RESET":
      return { stage: "idle" };

    default:
      return state;
  }
}

/**
 * Inner component that fetches and displays prompts for a specific MCP connection
 * @param connectionId - The connection ID, or null for the management MCP
 */
function IceBreakersContent({ connectionId }: { connectionId: string | null }) {
  const { tiptapDocRef, sendMessage } = useChatStable();
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
  });
  const { data } = useMCPPromptsList({ client, staleTime: 60000 });
  const prompts = data?.prompts ?? [];
  const [state, dispatch] = useReducer(iceBreakerReducer, { stage: "idle" });
  const [dialogPrompt, setDialogPrompt] = useState<Prompt | null>(null);

  const loadPrompt = async (prompt: Prompt, args?: PromptArgumentValues) => {
    if (!client) {
      toast.error("MCP client not available");
      dispatch({ type: "RESET" });
      return;
    }

    try {
      const result = await getPrompt(client, prompt.name, args);

      dispatch({ type: "RESET" });

      // Append prompt to current tiptapDoc and send
      // Wrap mention in a paragraph since it's an inline node
      const newTiptapDoc = appendToTiptapDoc(tiptapDocRef.current, {
        type: "paragraph",
        content: [
          createMentionDoc({
            id: prompt.name,
            name: prompt.name,
            metadata: result.messages,
            char: "/",
          }),
        ],
      });

      await sendMessage(newTiptapDoc);
    } catch (error) {
      console.error("[ice-breakers] Failed to fetch prompt:", error);
      toast.error("Failed to load prompt. Please try again.");
      dispatch({ type: "RESET" });
    }
  };

  const handlePromptSelection = async (prompt: Prompt) => {
    // If prompt has arguments, open dialog
    if (prompt.arguments && prompt.arguments.length > 0) {
      dispatch({ type: "SELECT_PROMPT", prompt });
      setDialogPrompt(prompt);
      return;
    }

    // No arguments - fetch directly
    dispatch({ type: "START_LOADING", prompt });
    await loadPrompt(prompt);
  };

  const handleDialogSubmit = async (values: PromptArgumentValues) => {
    if (!dialogPrompt) return;

    dispatch({
      type: "START_LOADING",
      prompt: dialogPrompt,
      arguments: values,
    });
    setDialogPrompt(null);
    await loadPrompt(dialogPrompt, values);
  };

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className="relative w-full">
      <IceBreakersUI
        prompts={prompts}
        onSelect={handlePromptSelection}
        loadingPrompt={state.stage === "loading" ? state.prompt : null}
      />
      <PromptArgsDialog
        prompt={dialogPrompt}
        setPrompt={() => {
          setDialogPrompt(null);
          dispatch({ type: "RESET" });
        }}
        onSubmit={handleDialogSubmit}
      />
    </div>
  );
}

/**
 * Ice breakers component that uses suspense to fetch MCP prompts.
 * Uses the chat context for connection selection and message sending.
 * Includes ErrorBoundary, Suspense, and container internally.
 */
export function IceBreakers({ className }: IceBreakersProps) {
  const { selectedVirtualMcp } = useChatStable();
  // When selectedVirtualMcp is null, use decopilot ID (default agent)
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const connectionId = selectedVirtualMcp?.id ?? decopilotId;

  return (
    <div
      style={{ minHeight: "32px" }}
      className={cn(
        "flex flex-wrap items-center justify-center gap-2",
        className,
      )}
    >
      <ErrorBoundary fallback={null}>
        <Suspense
          key={connectionId ?? "default"}
          fallback={<IceBreakersFallback />}
        >
          <IceBreakersContent connectionId={connectionId} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
