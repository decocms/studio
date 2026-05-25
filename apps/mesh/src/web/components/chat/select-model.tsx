import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@deco/ui/components/drawer.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState, Suspense } from "react";
import { type AiProviderModel } from "./select-model/shared";
import { useChatPrefs } from "./context";
import { ModelSelectorContentFallback } from "./select-model/decopilot";
import { SelectedModelDisplay } from "./select-model/shared";
import type { HarnessId } from "@/harnesses";
import {
  ModelSelectorBody,
  ModelSelectorStandaloneBody,
} from "./select-model/index";

export {
  getAcceptedMimeTypesForModel,
  getSupportedFileTypesLabel,
  isFileTypeSupportedByModel,
  modelSupportsFiles,
} from "./select-model/shared";

// ============================================================================
// Public Components
// ============================================================================

export interface ModelSelectorProps {
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
  // Standalone mode (bypasses useChat)
  model?: AiProviderModel | null;
  isLoading?: boolean;
  credentialId?: string | null;
  onCredentialChange?: (id: string | null) => void;
  onModelChange?: (model: AiProviderModel) => void;
  filterModels?: (m: AiProviderModel) => boolean;
  agent?: HarnessId;
}

export function ModelSelector({
  variant = "borderless",
  className,
  placeholder = "Select model",
  model: modelProp,
  isLoading: isLoadingProp,
  credentialId: credentialIdProp,
  onCredentialChange,
  onModelChange,
  filterModels,
  agent,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const standalone = onModelChange !== undefined;
  const isMobile = useIsMobile();

  const triggerButton = (
    <Button
      variant={variant === "borderless" ? "ghost" : "outline"}
      size="sm"
      className={cn(
        "text-sm hover:bg-accent rounded-lg py-0.5 px-1 gap-1 shadow-none cursor-pointer border-0 group focus-visible:ring-0 focus-visible:ring-offset-0 min-w-0 shrink justify-start overflow-hidden",
        variant === "borderless" && "md:border-none",
        className,
      )}
    >
      {standalone ? (
        <SelectedModelDisplay
          model={modelProp ?? null}
          placeholder={placeholder}
          isLoading={isLoadingProp}
        />
      ) : (
        <ModelSelectorTriggerContent placeholder={placeholder} />
      )}
    </Button>
  );

  const selectorContent = (
    <Suspense fallback={<ModelSelectorContentFallback />}>
      {standalone ? (
        <ModelSelectorStandaloneBody
          onClose={() => setOpen(false)}
          agent={agent}
          credentialId={credentialIdProp ?? null}
          onCredentialChange={onCredentialChange ?? (() => {})}
          selectedModel={modelProp ?? null}
          onModelChange={onModelChange}
          filterModels={filterModels}
        />
      ) : (
        <ModelSelectorBody onClose={() => setOpen(false)} agent={agent} />
      )}
    </Suspense>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent className="p-0 flex flex-col max-h-[95vh]">
          <DrawerTitle className="sr-only">Select model</DrawerTitle>
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {selectorContent}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{triggerButton}</DialogTrigger>
      <DialogContent
        className="p-0 gap-0 sm:max-w-fit overflow-hidden h-[100dvh] sm:h-auto max-h-[100dvh] sm:max-h-[85vh] w-full max-w-full sm:max-w-fit rounded-none sm:rounded-xl border-0 sm:border"
        closeButtonClassName="top-3.5 right-3.5 z-20"
      >
        <DialogTitle className="sr-only">Select model</DialogTitle>
        {selectorContent}
      </DialogContent>
    </Dialog>
  );
}

function ModelSelectorTriggerContent({ placeholder }: { placeholder: string }) {
  const { selectedModel: model, isModelsLoading } = useChatPrefs();
  return (
    <SelectedModelDisplay
      model={model}
      placeholder={placeholder}
      isLoading={isModelsLoading}
    />
  );
}
