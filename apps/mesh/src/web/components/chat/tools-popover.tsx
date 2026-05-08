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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@deco/ui/lib/utils.ts";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { useCurrentEditor } from "@tiptap/react";
import {
  BookOpen01,
  Check,
  ChevronDown,
  Globe02,
  Image01,
  Link01,
  Loading01,
  Settings04,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
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
  useAiProviderModels,
  type AiProviderModel,
} from "@/web/hooks/collections/use-ai-providers";
import { getProviderLogo } from "@/web/utils/ai-providers-logos";

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
}

export function ToolsPopover({
  disabled,
  onOpenConnections,
  virtualMcpId,
}: ToolsPopoverProps) {
  const [open, setOpen] = useState(false);
  const playSwitchSound = useSound(switch005Sound);
  const { org } = useProjectContext();
  const { editor } = useCurrentEditor();
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

  // Image & deep research model state from chat prefs
  const {
    credentialId,
    imageModel,
    setImageModel,
    deepResearchModel,
    setDeepResearchModel,
    chatMode,
    setChatMode,
    simpleModeEnabled,
  } = useChatPrefs();
  const isPlanMode = chatMode === "plan";

  // Fetch models for submenus (only when a submenu is hovered/open)
  const [imageSubOpen, setImageSubOpen] = useState(false);
  const [searchSubOpen, setSearchSubOpen] = useState(false);
  const { models: allModels, isLoading: isModelsLoading } = useAiProviderModels(
    imageSubOpen || searchSubOpen ? (credentialId ?? undefined) : undefined,
  );
  const imageModels = allModels.filter((m) =>
    m.capabilities?.includes("image"),
  );
  const deepResearchModels = allModels.filter((m) => {
    const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
    return n.includes("sonar") || n.includes("deepresearch");
  });

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

  const handleImageModelSelect = (model: AiProviderModel) => {
    playSwitchSound();
    track("chat_image_model_selected", {
      model_id: model.modelId,
      model_title: model.title,
      provider: model.providerId ?? null,
    });
    setImageModel(model);
    setOpen(false);
  };

  const handleSearchModelSelect = (model: AiProviderModel) => {
    playSwitchSound();
    track("chat_search_model_selected", {
      model_id: model.modelId,
      model_title: model.title,
      provider: model.providerId ?? null,
    });
    setDeepResearchModel(model);
    setOpen(false);
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
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings04 size={14} />
            <span className="hidden sm:inline">Tools</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 p-1.5">
          <DropdownMenuItem
            onClick={handleTogglePlanMode}
            className={cn(isPlanMode && "text-violet-600 dark:text-violet-400")}
          >
            <BookOpen01
              size={16}
              className={cn(isPlanMode && "text-violet-500")}
            />
            <span className="flex-1">Plan mode</span>
            {isPlanMode && (
              <span className="text-xs text-violet-500 font-medium">On</span>
            )}
          </DropdownMenuItem>

          {/* Create image */}
          {simpleModeEnabled ? (
            <DropdownMenuItem
              onClick={handleForceImageGeneration}
              className={cn(
                isImageActive && "text-pink-600 dark:text-pink-400",
              )}
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
          ) : (
            <DropdownMenuSub open={imageSubOpen} onOpenChange={setImageSubOpen}>
              <div className="flex items-center rounded-lg">
                <DropdownMenuItem
                  onClick={handleForceImageGeneration}
                  disabled={!imageModel}
                  className={cn(
                    "flex-1 rounded-r-none pr-1",
                    isImageActive && "text-pink-600 dark:text-pink-400",
                  )}
                >
                  <Image01
                    size={16}
                    className={cn(isImageActive && "text-pink-500")}
                  />
                  <span className="flex-1">Create image</span>
                  {isImageActive && (
                    <span className="text-xs text-pink-500 font-medium">
                      On
                    </span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuPrimitive.SubTrigger
                  className={cn(
                    "flex items-center justify-center rounded-r-lg rounded-l-none px-1.5 py-1.5 text-muted-foreground outline-hidden select-none",
                    "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                    "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
                  )}
                >
                  <ChevronDown size={14} />
                </DropdownMenuPrimitive.SubTrigger>
              </div>
              <DropdownMenuSubContent className="w-80 max-h-72 overflow-y-auto p-1.5">
                {isModelsLoading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                    <Loading01 size={14} className="animate-spin" />
                    Loading models…
                  </div>
                ) : imageModels.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    No image models available
                  </div>
                ) : (
                  imageModels.map((model) => {
                    const isSelected = imageModel?.modelId === model.modelId;
                    const logo = getProviderLogo(model);
                    const displayName = model.title.includes(": ")
                      ? model.title.split(": ").slice(1).join(": ")
                      : model.title;
                    return (
                      <DropdownMenuItem
                        key={model.modelId}
                        onClick={() => handleImageModelSelect(model)}
                        className="flex items-center gap-2"
                      >
                        <img
                          src={logo}
                          alt=""
                          className="size-4 shrink-0 rounded-sm dark:bg-white dark:p-px"
                        />
                        <span className="flex-1 text-sm truncate">
                          {displayName}
                        </span>
                        {isSelected && (
                          <Check size={14} className="text-pink-500 shrink-0" />
                        )}
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {/* Web search */}
          {simpleModeEnabled ? (
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
          ) : (
            deepResearchModel && (
              <DropdownMenuSub
                open={searchSubOpen}
                onOpenChange={setSearchSubOpen}
              >
                <div className="flex items-center rounded-lg">
                  <DropdownMenuItem
                    onClick={handleForceWebSearch}
                    className={cn(
                      "flex-1 rounded-r-none pr-1",
                      isWebSearchActive && "text-blue-600 dark:text-blue-400",
                    )}
                  >
                    <Globe02
                      size={16}
                      className={cn(isWebSearchActive && "text-blue-500")}
                    />
                    <span className="flex-1">Web search</span>
                    {isWebSearchActive && (
                      <span className="text-xs text-blue-500 font-medium">
                        On
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuPrimitive.SubTrigger
                    className={cn(
                      "flex items-center justify-center rounded-r-lg rounded-l-none px-1.5 py-1.5 text-muted-foreground outline-hidden select-none",
                      "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                      "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
                    )}
                  >
                    <ChevronDown size={14} />
                  </DropdownMenuPrimitive.SubTrigger>
                </div>
                <DropdownMenuSubContent className="w-80 max-h-72 overflow-y-auto p-1.5">
                  {isModelsLoading ? (
                    <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                      <Loading01 size={14} className="animate-spin" />
                      Loading models…
                    </div>
                  ) : (
                    deepResearchModels.map((model) => {
                      const isSelected =
                        deepResearchModel?.modelId === model.modelId;
                      const logo = getProviderLogo(model);
                      const displayName = model.title.includes(": ")
                        ? model.title.split(": ").slice(1).join(": ")
                        : model.title;
                      return (
                        <DropdownMenuItem
                          key={model.modelId}
                          onClick={() => handleSearchModelSelect(model)}
                          className="flex items-center gap-2"
                        >
                          <img
                            src={logo}
                            alt=""
                            className="size-4 shrink-0 rounded-sm dark:bg-white dark:p-px"
                          />
                          <span className="flex-1 text-sm truncate">
                            {displayName}
                          </span>
                          {isSelected && (
                            <Check
                              size={14}
                              className="text-blue-500 shrink-0"
                            />
                          )}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          )}

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
