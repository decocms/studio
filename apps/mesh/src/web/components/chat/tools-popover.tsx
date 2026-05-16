import {
  displayToolName,
  getGatewayClientId,
  stripToolNamespace,
} from "@decocms/mcp-utils/aggregate";
import {
  getPrompt,
  listPrompts,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { useCurrentEditor } from "@tiptap/react";
import {
  BookOpen01,
  Globe02,
  Image01,
  Link01,
  Loading01,
  Plus,
  Settings04,
  ShieldTick,
} from "@untitledui/icons";
import { Suspense, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { track } from "@/web/lib/posthog-client";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "./dialog-prompt-arguments.tsx";
import { insertMention } from "./tiptap/mention";
import { KEYS } from "@/web/lib/query-keys";
import { useSound } from "@/web/hooks/use-sound.ts";
import { switch005Sound } from "@deco/ui/lib/switch-005.ts";
import { useChatPrefs } from "./context";
import {
  APPROVAL_LEVEL_OPTIONS,
  usePreferences,
} from "@/web/hooks/use-preferences.ts";
import { processFile, type UnsupportedFileInfo } from "./tiptap/file";
import {
  getAcceptedMimeTypesForModel,
  modelSupportsFiles,
} from "./select-model";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import { KEYBOARD_SHORTCUTS } from "@/web/lib/keyboard-shortcuts";

const PLAN_MODE_SHORTCUT = KEYBOARD_SHORTCUTS.togglePlanMode.keys
  .map((k) => (k === "Shift" ? "⇧" : k))
  .join("");

const FEATURED_CONNECTION_ICONS = [
  { src: "/connections/gmail.png", name: "Gmail" },
  { src: "/connections/perplexity.png", name: "Perplexity" },
  { src: "/connections/github.png", name: "GitHub" },
];

function ConnectionIcons() {
  return (
    <div className="flex items-center -space-x-1.5">
      {FEATURED_CONNECTION_ICONS.map((icon) => (
        <img
          key={icon.name}
          src={icon.src}
          alt={icon.name}
          className="size-5 rounded-sm ring-1 ring-border object-cover bg-white"
        />
      ))}
    </div>
  );
}

interface ToolsPopoverProps {
  disabled?: boolean;
  onOpenConnections: () => void;
  virtualMcpId: string | null;
  selectedModel: AiProviderModel | null | undefined;
  isStreaming: boolean;
  onUnsupportedFile?: (info: UnsupportedFileInfo) => void;
}

export function ToolsPopover({
  disabled,
  onOpenConnections,
  virtualMcpId,
  selectedModel,
  isStreaming,
  onUnsupportedFile,
}: ToolsPopoverProps) {
  const [open, setOpen] = useState(false);
  const playSwitchSound = useSound(switch005Sound);
  const { org } = useProjectContext();
  const { editor } = useCurrentEditor();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const supportsFiles = modelSupportsFiles(selectedModel);

  const handleAddFileClick = () => {
    if (!supportsFiles || isStreaming) return;
    setOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !editor) return;

    const fileArray = Array.from(files);
    const { from } = editor.state.selection;

    try {
      for (const file of fileArray) {
        await processFile(
          editor,
          selectedModel ?? null,
          file,
          from,
          onUnsupportedFile,
        );
      }
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryKey = KEYS.virtualMcpPrompts(virtualMcpId, org.id);

  const { data, isLoading: isPromptsLoading } = useQuery({
    queryKey,
    queryFn: () => listPrompts(client!),
    staleTime: 60000,
    enabled: open && !!client,
  });
  const prompts = data?.prompts ?? [];

  const [activePrompt, setActivePrompt] = useState<Prompt | null>(null);

  const { chatMode, setChatMode } = useChatPrefs();
  const [preferences, setPreferences] = usePreferences();
  const currentApprovalOption =
    APPROVAL_LEVEL_OPTIONS.find(
      (opt) => opt.value === preferences.toolApprovalLevel,
    ) ?? APPROVAL_LEVEL_OPTIONS[0]!;
  const currentApprovalShort = currentApprovalOption.short;

  const handleApprovalLevelChange = (next: string) => {
    const matched = APPROVAL_LEVEL_OPTIONS.find((opt) => opt.value === next);
    if (!matched) return;
    if (matched.value === preferences.toolApprovalLevel) {
      // No-op: same level re-selected, just close the popover.
      setOpen(false);
      return;
    }
    playSwitchSound();
    track("chat_approval_level_changed", {
      from_level: preferences.toolApprovalLevel,
      to_level: matched.value,
      source: "tools_popover",
    });
    setPreferences({ ...preferences, toolApprovalLevel: matched.value });
    setOpen(false);
  };

  const isPlanMode = chatMode === "plan";

  const handleTogglePlanMode = () => {
    playSwitchSound();
    const nextMode = isPlanMode ? "default" : "plan";
    track("chat_mode_changed", {
      from_mode: chatMode,
      to_mode: nextMode,
      source: "tools_popover",
    });
    setChatMode(nextMode);
    setOpen(false);
  };

  const handleConnections = () => {
    onOpenConnections();
    setOpen(false);
  };

  const insertPrompt = async (
    prompt: Prompt,
    values?: PromptArgumentValues,
  ) => {
    if (!editor || !client) return;

    const clientId = getGatewayClientId(prompt._meta);
    const range = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };

    try {
      const result = await getPrompt(client, prompt.name, values);
      insertMention(editor, range, {
        id: prompt.name,
        name: stripToolNamespace(prompt.name, clientId),
        metadata: result.messages,
        char: "/",
      });
    } catch {
      toast.error("Failed to load prompt. Please try again.");
    }
  };

  const handlePromptSelect = async (prompt: Prompt) => {
    setOpen(false);
    const hasArgs = !!(prompt.arguments && prompt.arguments.length > 0);
    track("chat_prompt_inserted", {
      prompt_name: prompt.name,
      with_arguments: hasArgs,
    });
    if (hasArgs) {
      setActivePrompt(prompt);
      return;
    }
    await insertPrompt(prompt);
  };

  const handlePromptArgsSubmit = async (values: PromptArgumentValues) => {
    if (!activePrompt) return;
    await insertPrompt(activePrompt, values);
    setActivePrompt(null);
  };

  const handleForceImageGeneration = () => {
    playSwitchSound();
    const nextMode = chatMode === "gen-image" ? "default" : "gen-image";
    track("chat_mode_changed", {
      from_mode: chatMode,
      to_mode: nextMode,
      source: "tools_popover",
    });
    setChatMode(nextMode);
    setOpen(false);
  };

  const handleForceWebSearch = () => {
    playSwitchSound();
    const nextMode = chatMode === "web-search" ? "default" : "web-search";
    track("chat_mode_changed", {
      from_mode: chatMode,
      to_mode: nextMode,
      source: "tools_popover",
    });
    setChatMode(nextMode);
    setOpen(false);
  };

  const isImageActive = chatMode === "gen-image";
  const isWebSearchActive = chatMode === "web-search";

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={getAcceptedMimeTypesForModel(selectedModel ?? null)}
        className="hidden"
        onChange={handleFileSelect}
        disabled={isStreaming}
      />

      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          if (next && !open) {
            track("chat_tools_popover_opened", {
              chat_mode: chatMode,
            });
          }
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={disabled}
            title="Tools"
            aria-label="Tools"
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings04 size={14} />
            <span className="inline-block overflow-hidden whitespace-nowrap max-w-0 opacity-0 transition-[max-width,opacity] duration-200 ease-out @[496px]/chat-bottom:max-w-24 @[496px]/chat-bottom:opacity-100">
              Tools
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 p-1.5 space-y-1">
          {!supportsFiles ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuItem
                  aria-disabled="true"
                  className="opacity-50 cursor-not-allowed"
                  onSelect={(e) => e.preventDefault()}
                >
                  <Plus size={16} />
                  <span className="flex-1">Add file</span>
                </DropdownMenuItem>
              </TooltipTrigger>
              <TooltipContent side="right">
                The selected model does not support reading files or images.
              </TooltipContent>
            </Tooltip>
          ) : (
            <DropdownMenuItem
              onClick={handleAddFileClick}
              disabled={isStreaming}
            >
              <Plus size={16} />
              <span className="flex-1">Add file</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuItem
            onClick={handleTogglePlanMode}
            className={cn(isPlanMode && "text-violet-600 dark:text-violet-400")}
          >
            <BookOpen01
              size={16}
              className={cn(isPlanMode && "text-violet-500")}
            />
            <span className="flex-1">Plan mode</span>
            <span
              className={cn(
                "text-xs text-muted-foreground",
                isPlanMode && "text-violet-500 font-medium",
              )}
            >
              {PLAN_MODE_SHORTCUT}
            </span>
          </DropdownMenuItem>

          {/* Create image */}
          <DropdownMenuItem
            onClick={handleForceImageGeneration}
            className={cn(isImageActive && "text-pink-600 dark:text-pink-400")}
          >
            <Image01
              size={16}
              className={cn(isImageActive && "text-pink-500")}
            />
            <span className="flex-1">Create image</span>
            {isImageActive && (
              <span className="text-xs text-pink-500 font-medium">On</span>
            )}
          </DropdownMenuItem>

          {/* Web search */}
          <DropdownMenuItem
            onClick={handleForceWebSearch}
            className={cn(
              isWebSearchActive && "text-blue-600 dark:text-blue-400",
            )}
          >
            <Globe02
              size={16}
              className={cn(isWebSearchActive && "text-blue-500")}
            />
            <span className="flex-1">Web search</span>
            {isWebSearchActive && (
              <span className="text-xs text-blue-500 font-medium">On</span>
            )}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <span className="flex size-4 items-center justify-center text-base font-medium text-muted-foreground">
                /
              </span>
              <span className="flex-1">Prompts</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80 max-h-72 overflow-y-auto p-1.5">
              {isPromptsLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <Loading01 size={14} className="animate-spin" />
                  Loading prompts…
                </div>
              ) : prompts.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No prompts available
                </div>
              ) : (
                prompts.map((prompt) => (
                  <DropdownMenuItem
                    key={prompt.name}
                    onClick={() => handlePromptSelect(prompt)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="font-medium text-sm capitalize">
                      {prompt.title ||
                        displayToolName(
                          prompt.name,
                          getGatewayClientId(prompt._meta),
                        )}
                    </span>
                    {prompt.description && (
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {prompt.description}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <ShieldTick size={16} />
              <span className="flex-1">Approval</span>
              <span className="text-xs text-muted-foreground">
                {currentApprovalShort}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48 p-1.5">
              <DropdownMenuRadioGroup
                value={preferences.toolApprovalLevel}
                onValueChange={handleApprovalLevelChange}
              >
                {APPROVAL_LEVEL_OPTIONS.map((opt) => (
                  <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem onClick={handleConnections}>
            <Link01 size={16} />
            <span className="flex-1">Connections</span>
            <Suspense>
              <ConnectionIcons />
            </Suspense>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptArgsDialog
        prompt={activePrompt}
        setPrompt={setActivePrompt}
        onSubmit={handlePromptArgsSubmit}
      />
    </>
  );
}
