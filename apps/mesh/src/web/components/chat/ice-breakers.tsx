import {
  displayToolName,
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@deco/ui/components/drawer.tsx";
import { CollectionSearch } from "@/web/components/collections/collection-search.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
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
import { useChatStream, useChatPrefs } from "./context";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "./dialog-prompt-arguments";
import { createMentionDoc } from "./tiptap/mention/node";
import { appendToTiptapDoc } from "./tiptap/utils";

// ---------- Types ----------

interface PromptItem {
  prompt: Prompt;
}

interface IceBreakersUIProps {
  items: PromptItem[];
  onSelect: (prompt: Prompt) => void;
  loadingPrompt?: Prompt | null;
  className?: string;
}

// ---------- UI ----------

const VISIBLE_COUNT = 3;

const PILL_BASE =
  "inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-muted text-muted-foreground text-sm font-medium transition-colors cursor-pointer";

const CARD_BASE =
  "flex flex-col gap-1.5 p-4 rounded-xl bg-accent/40 text-sm leading-snug transition-colors cursor-pointer text-left";

function PromptCard({
  item,
  onSelect,
  isLoading,
  isDisabled,
  variant = "pill",
}: {
  item: PromptItem;
  onSelect: (prompt: Prompt) => void;
  isLoading: boolean;
  isDisabled: boolean;
  variant?: "pill" | "card";
}) {
  const { prompt } = item;
  const clientId = getGatewayClientId(prompt._meta);
  const name = prompt.title ?? displayToolName(prompt.name, clientId);
  const description = prompt.description || null;

  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={() => onSelect(prompt)}
        disabled={isDisabled || isLoading}
        className={cn(
          CARD_BASE,
          "hover:bg-accent/60 text-foreground",
          isLoading && "bg-accent/40",
          (isDisabled || isLoading) && "cursor-not-allowed opacity-50",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium truncate capitalize">{name}</span>
          {isLoading && <Spinner size="xs" />}
        </div>
        {description && (
          <span className="text-xs text-muted-foreground line-clamp-2">
            {description}
          </span>
        )}
      </button>
    );
  }

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(prompt)}
          disabled={isDisabled || isLoading}
          className={cn(
            PILL_BASE,
            "hover:bg-muted/70 hover:text-foreground",
            isLoading && "bg-muted/50",
            (isDisabled || isLoading) && "cursor-not-allowed opacity-50",
          )}
        >
          <span className="capitalize">{name}</span>
          {isLoading && <Spinner size="xs" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs">{description ?? name}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function AllPromptsModal({
  items,
  open,
  onOpenChange,
  onSelect,
  loadingPrompt,
}: {
  items: PromptItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (prompt: Prompt) => void;
  loadingPrompt: Prompt | null | undefined;
}) {
  const [search, setSearch] = useState("");
  const isAnyLoading = !!loadingPrompt;

  const filtered = search.trim()
    ? items.filter((item) => {
        const q = search.toLowerCase();
        return (
          item.prompt.name.toLowerCase().includes(q) ||
          (item.prompt.title ?? "").toLowerCase().includes(q) ||
          (item.prompt.description ?? "").toLowerCase().includes(q)
        );
      })
    : items;

  const isMobile = useIsMobile();

  const gridContent = (
    <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 p-5">
        {filtered.length === 0 && (
          <p className="col-span-4 text-sm text-muted-foreground text-center py-8">
            No prompts match &ldquo;{search}&rdquo;
          </p>
        )}
        {filtered.map((item) => (
          <PromptCard
            key={item.prompt.name}
            item={item}
            variant="card"
            onSelect={(prompt) => {
              onOpenChange(false);
              onSelect(prompt);
            }}
            isLoading={loadingPrompt?.name === item.prompt.name}
            isDisabled={
              isAnyLoading && loadingPrompt?.name !== item.prompt.name
            }
          />
        ))}
      </div>
    </div>
  );

  const searchBar = (
    <CollectionSearch
      value={search}
      onChange={setSearch}
      placeholder="Search prompts..."
      onKeyDown={(e) => {
        if (e.key === "Escape") setSearch("");
      }}
    />
  );

  if (isMobile) {
    return (
      <TooltipProvider delayDuration={400}>
        <Drawer open={open} onOpenChange={onOpenChange}>
          <DrawerContent className="h-[85vh] flex flex-col p-0 gap-0">
            <DrawerHeader className="sr-only">
              <DrawerTitle>All prompts</DrawerTitle>
            </DrawerHeader>
            <div className="flex items-center h-12 border-b border-border px-4 shrink-0">
              <span className="text-sm font-medium text-foreground">
                Prompts
              </span>
            </div>
            {searchBar}
            {gridContent}
          </DrawerContent>
        </Drawer>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[1100px] h-[680px] p-0 gap-0 overflow-hidden flex flex-col">
          <DialogHeader className="sr-only">
            <DialogTitle>All prompts</DialogTitle>
          </DialogHeader>
          <div className="flex items-center h-12 border-b border-border px-4 shrink-0">
            <span className="text-sm font-medium text-foreground">Prompts</span>
          </div>
          {searchBar}
          {gridContent}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/** Compact icebreakers: up to 3 prompt cards (centered) or 3 cards + "+N" overflow. */
function IceBreakersUI({
  items,
  onSelect,
  loadingPrompt,
  className,
}: IceBreakersUIProps) {
  const [modalOpen, setModalOpen] = useState(false);

  if (items.length === 0) return null;

  const visible = items.slice(0, VISIBLE_COUNT);
  const hidden = items.slice(VISIBLE_COUNT);
  const isAnyLoading = !!loadingPrompt;

  const cards = visible.map((item) => (
    <PromptCard
      key={item.prompt.name}
      item={item}
      onSelect={onSelect}
      isLoading={loadingPrompt?.name === item.prompt.name}
      isDisabled={isAnyLoading && loadingPrompt?.name !== item.prompt.name}
    />
  ));

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className={cn("w-full flex flex-wrap gap-2 justify-center", className)}
      >
        {cards}
        {hidden.length > 0 && (
          <button
            type="button"
            disabled={isAnyLoading}
            onClick={() => setModalOpen(true)}
            className={cn(
              PILL_BASE,
              "hover:bg-muted/70 hover:text-foreground",
              isAnyLoading && "opacity-50 cursor-not-allowed",
            )}
          >
            +{hidden.length} more
          </button>
        )}
      </div>
      <AllPromptsModal
        items={items}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSelect={onSelect}
        loadingPrompt={loadingPrompt}
      />
    </TooltipProvider>
  );
}

// ---------- State machine ----------

interface IceBreakersProps {
  className?: string;
}

function IceBreakersFallback() {
  return null;
}

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
      if (!action.prompt.arguments || action.prompt.arguments.length === 0) {
        return { stage: "loading", prompt: action.prompt };
      }
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

// ---------- Data fetching ----------

function IceBreakersContent({ connectionId }: { connectionId: string | null }) {
  const { sendMessage } = useChatStream();
  const { tiptapDocRef } = useChatPrefs();
  const { org } = useProjectContext();

  // Fetch prompts from the aggregated virtual MCP
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data } = useMCPPromptsList({ client, staleTime: 60000 });
  const prompts = data?.prompts ?? [];

  const items: PromptItem[] = prompts.map((prompt) => ({ prompt }));

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

      const newTiptapDoc = appendToTiptapDoc(tiptapDocRef.current, {
        type: "paragraph",
        content: [
          createMentionDoc({
            id: prompt.name,
            name: stripToolNamespace(
              prompt.name,
              getGatewayClientId(prompt._meta),
            ),
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
    if (prompt.arguments && prompt.arguments.length > 0) {
      dispatch({ type: "SELECT_PROMPT", prompt });
      setDialogPrompt(prompt);
      return;
    }

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

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <IceBreakersUI
        items={items}
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
    </>
  );
}

// ---------- Export ----------

export function IceBreakers({ className }: IceBreakersProps) {
  const { selectedVirtualMcp } = useChatPrefs();
  const { org } = useProjectContext();
  const decopilotId = getWellKnownDecopilotVirtualMCP(org.id).id;
  const connectionId = selectedVirtualMcp?.id ?? decopilotId;

  return (
    <div className={cn("w-full @container", className)}>
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
