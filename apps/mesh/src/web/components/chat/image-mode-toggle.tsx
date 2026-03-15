import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Image01 } from "@untitledui/icons";
import { useChat } from "./context";

const ASPECT_RATIOS = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export function ImageModeToggle({ disabled = false }: { disabled?: boolean }) {
  const { imageMode, imageAspectRatio, setImageMode, setImageAspectRatio } =
    useChat();

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setImageMode(!imageMode)}
            className={cn(
              "flex items-center justify-center size-8 rounded-md transition-colors shrink-0",
              disabled
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:text-muted-foreground",
              imageMode
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "text-muted-foreground/75",
            )}
          >
            <Image01 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {imageMode ? "Switch to text mode" : "Switch to image generation"}
        </TooltipContent>
      </Tooltip>
      {imageMode && (
        <div className="flex items-center gap-0.5 ml-0.5">
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
      )}
    </div>
  );
}
