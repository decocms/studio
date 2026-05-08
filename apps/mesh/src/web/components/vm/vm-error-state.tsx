import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, Copy01, RefreshCw01 } from "@untitledui/icons";
import { toast } from "sonner";

interface VmErrorStateProps {
  errorMsg: string;
  onRetry: () => void;
}

export function VmErrorState({ errorMsg, onRetry }: VmErrorStateProps) {
  return (
    <div className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none">
      {/* Floating status pill */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full border border-destructive/30 bg-background/80 px-3.5 py-1.5 shadow-[0_4px_20px_-4px_rgb(0_0_0_/_0.12)] backdrop-blur-md">
        <AlertCircle size={13} className="text-destructive/80" />
        <span className="text-[13px] font-medium text-destructive/90">
          Failed to start
        </span>
      </div>

      {/* Stacked browser mockup — same layout, but dimmed */}
      <div className="relative w-[min(78%,560px)] aspect-[4/3] mt-6 opacity-60">
        <div className="absolute left-[8%] right-[8%] -top-5 h-full rounded-xl border border-foreground/[0.05] bg-foreground/[0.015]" />
        <div className="absolute left-[4%] right-[4%] -top-2.5 h-full rounded-xl border border-foreground/[0.07] bg-foreground/[0.025]" />

        <div className="relative w-full h-full rounded-xl border border-foreground/10 bg-background shadow-[0_20px_60px_-20px_rgb(0_0_0_/_0.35)] overflow-hidden">
          <div className="h-7 border-b border-foreground/[0.08] bg-foreground/[0.015] flex items-center gap-1.5 px-3">
            <div className="w-2.5 h-2.5 rounded-full bg-foreground/10" />
            <div className="w-2.5 h-2.5 rounded-full bg-foreground/10" />
            <div className="w-2.5 h-2.5 rounded-full bg-foreground/10" />
            <div className="ml-3 h-3.5 flex-1 max-w-[240px] rounded-sm bg-foreground/[0.04]" />
          </div>

          {/* Error card centered in the mockup */}
          <div className="flex items-center justify-center p-6 h-[calc(100%-1.75rem)]">
            <div className="w-full max-w-sm rounded-lg border border-destructive/20 bg-destructive/[0.03] p-4 space-y-3">
              <div className="flex items-start gap-2">
                <AlertCircle
                  size={14}
                  className="text-destructive/80 mt-0.5 shrink-0"
                />
                <p className="text-xs text-destructive/80 line-clamp-5 break-all leading-relaxed font-mono">
                  {errorMsg}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RefreshCw01 size={12} />
                  Retry
                </Button>
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard.writeText(errorMsg).then(() => {
                      toast.success("Error copied to clipboard");
                    })
                  }
                  className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-200"
                >
                  <Copy01 size={10} />
                  Copy error
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
