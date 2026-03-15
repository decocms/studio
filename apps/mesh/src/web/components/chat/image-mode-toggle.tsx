import { cn } from "@deco/ui/lib/utils.ts";
import { Image01 } from "@untitledui/icons";
import { useAiProviderModels } from "../../hooks/collections/use-llm";
import { useChat } from "./context";

const ASPECT_RATIOS = [
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

export function ImageModeToggle({ disabled = false }: { disabled?: boolean }) {
  const {
    imageMode,
    imageAspectRatio,
    setImageMode,
    setImageAspectRatio,
    credentialId,
  } = useChat();
  const { models } = useAiProviderModels(credentialId ?? undefined);
  const imageModels = models.filter((m) =>
    m.capabilities?.includes("image-generation"),
  );

  return (
    <div className="flex items-center gap-0.5">
      {imageMode && (
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
      )}
      <button
        type="button"
        disabled={disabled || (!imageMode && imageModels.length === 0)}
        onClick={() => setImageMode(!imageMode, imageModels)}
        className={cn(
          "flex items-center gap-1.5 h-8 px-2 rounded-lg text-sm transition-colors shrink-0",
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:bg-accent",
          imageMode
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "text-muted-foreground",
        )}
      >
        <Image01 size={16} />
        <span>Image</span>
      </button>
    </div>
  );
}
