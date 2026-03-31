import { Suspense } from "react";
import { CpuChip01 } from "@untitledui/icons";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { ProviderCardGrid } from "@/web/views/settings/org-ai-providers";

interface NoAiProviderEmptyStateProps {
  title?: string;
  description?: string;
}

export function NoAiProviderEmptyState({
  title = "Connect an AI provider",
  description = "Keys are stored encrypted in the vault.",
}: NoAiProviderEmptyStateProps = {}) {
  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-2xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex items-center justify-center size-14 rounded-2xl bg-muted border border-border/60">
          <CpuChip01 size={24} className="text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <p className="text-lg font-semibold text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <Suspense
        fallback={
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        }
      >
        <ProviderCardGrid />
      </Suspense>
    </div>
  );
}
