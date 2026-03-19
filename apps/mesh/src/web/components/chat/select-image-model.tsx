import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Image01, XClose } from "@untitledui/icons";
import { useState } from "react";
import {
  type AiProviderModel,
  useAiProviderModels,
} from "../../hooks/collections/use-llm";
import { useChat } from "./context";
import { getProviderLogo } from "@/web/utils/ai-providers-logos";

const ASPECT_RATIOS = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export function ImageModelSelector({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const {
    imageModel,
    imageAspectRatio,
    setImageModel,
    setImageAspectRatio,
    credentialId,
  } = useChat();
  const [open, setOpen] = useState(false);
  const { models } = useAiProviderModels(credentialId ?? undefined);
  const imageModels = models.filter((m) =>
    m.capabilities?.includes("image-generation"),
  );

  if (imageModels.length === 0) return null;

  const handleSelect = (model: AiProviderModel) => {
    setImageModel(model);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageModel(null);
  };

  // When an image model is selected: show model name + aspect ratios + clear button
  if (imageModel) {
    const providerLogo = getProviderLogo(imageModel);
    return (
      <div className="flex items-center gap-0.5">
        <div className="flex items-center gap-0.5 mr-0.5">
          {ASPECT_RATIOS.map((ratio) => (
            <button
              key={ratio.value}
              type="button"
              disabled={disabled}
              onClick={() => setImageAspectRatio(ratio.value)}
              className={cn(
                "px-1.5 py-0.5 text-[11px] rounded transition-colors",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                imageAspectRatio === ratio.value
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground/60 hover:text-muted-foreground",
              )}
            >
              {ratio.label}
            </button>
          ))}
        </div>
        <div
          className={cn(
            "flex items-center gap-1 h-8 px-2 rounded-lg text-sm bg-primary text-primary-foreground",
            disabled ? "opacity-50" : "",
          )}
        >
          <img
            src={providerLogo}
            className="w-3.5 h-3.5 shrink-0 rounded-sm"
            alt=""
          />
          <span className="truncate max-w-[80px] hidden sm:inline">
            {imageModel.title?.replace(/\s*\(.*\)\s*$/, "").trim() ??
              imageModel.modelId}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={handleClear}
            className={cn(
              "flex items-center justify-center rounded-full transition-colors ml-0.5",
              disabled
                ? "cursor-not-allowed"
                : "cursor-pointer hover:bg-primary-foreground/20",
            )}
          >
            <XClose size={14} />
          </button>
        </div>
      </div>
    );
  }

  // When no image model selected: show icon button that opens popover
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "flex items-center justify-center size-8 rounded-lg text-muted-foreground transition-colors shrink-0",
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:bg-accent hover:text-foreground",
              )}
            >
              <Image01 size={16} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!open && <TooltipContent side="top">Image generation</TooltipContent>}
      </Tooltip>
      <PopoverContent
        className="w-[240px] p-1"
        align="start"
        side="top"
        sideOffset={8}
      >
        <div className="flex flex-col">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Image models
          </div>
          {imageModels.map((model) => {
            const logo = getProviderLogo(model);
            const name =
              model.title?.replace(/\s*\(.*\)\s*$/, "").trim() ?? model.modelId;
            return (
              <button
                key={model.modelId}
                type="button"
                onClick={() => handleSelect(model)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-accent transition-colors cursor-pointer"
              >
                <img
                  src={logo}
                  className="w-4 h-4 shrink-0 rounded-sm"
                  alt=""
                />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
