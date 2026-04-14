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
import { cn } from "@deco/ui/lib/utils.ts";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { useCurrentEditor } from "@tiptap/react";
import {
  BookOpen01,
  Check,
  Image01,
  Link01,
  Loading01,
  Settings04,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import {
  PromptArgsDialog,
  type PromptArgumentValues,
} from "./dialog-prompt-arguments.tsx";
import { insertMention } from "./tiptap/mention";
import { KEYS } from "@/web/lib/query-keys";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
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
  isAgentContext?: boolean;
}

export function ToolsPopover({
  disabled,
  onOpenConnections,
  virtualMcpId,
  isAgentContext = false,
}: ToolsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = usePreferences();
  const isPlanMode = preferences.toolApprovalLevel === "plan";
  const playSwitchSound = useSound(switch005Sound);
  const { org } = useProjectContext();
  const { editor } = useCurrentEditor();
  const client = useMCPClient({
    connectionId: virtualMcpId,
    orgId: org.id,
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

  // Image model state from chat prefs
  const { credentialId, imageModel, setImageModel } = useChatPrefs();

  // Fetch models for the image submenu (only when submenu is hovered/open)
  const [imageSubOpen, setImageSubOpen] = useState(false);
  const { models: allModels, isLoading: isModelsLoading } = useAiProviderModels(
    imageSubOpen ? (credentialId ?? undefined) : undefined,
  );
  const imageModels = allModels.filter((m) =>
    m.capabilities?.includes("image"),
  );

  const handleTogglePlanMode = () => {
    playSwitchSound();
    setPreferences({
      ...preferences,
      toolApprovalLevel: isPlanMode ? "auto" : "plan",
    });
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
    if (prompt.arguments && prompt.arguments.length > 0) {
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
    // Toggle off if same model is selected
    if (imageModel?.modelId === model.modelId) {
      setImageModel(null);
    } else {
      setImageModel(model);
    }
    setOpen(false);
  };

  const isImageActive = !!imageModel;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
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

          <DropdownMenuSub open={imageSubOpen} onOpenChange={setImageSubOpen}>
            <DropdownMenuSubTrigger
              className={cn(
                "gap-2",
                isImageActive && "text-pink-600 dark:text-pink-400",
              )}
            >
              <Image01
                size={16}
                className={cn(isImageActive && "text-pink-500")}
              />
              <span className="flex-1">Create Image</span>
              {isImageActive && (
                <span className="text-xs text-pink-500 font-medium">On</span>
              )}
            </DropdownMenuSubTrigger>
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
                  // Strip "Provider: " prefix from title (same as model selector)
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

          {!isAgentContext && (
            <DropdownMenuItem onClick={handleConnections}>
              <Link01 size={16} />
              <span className="flex-1">Connections</span>
              <Suspense>
                <ConnectionIcons />
              </Suspense>
            </DropdownMenuItem>
          )}
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
