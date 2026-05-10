import { Button } from "@deco/ui/components/button.tsx";
import { useDecoConnect } from "./use-deco-connect";

export function DecoNudgeCard() {
  const { mutate: connect, isPending } = useDecoConnect();

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <img
          src="/logos/deco%20logo.svg"
          alt="Deco AI Gateway"
          className="size-8 shrink-0 rounded-md object-contain dark:bg-white dark:p-0.5"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Try Deco AI Gateway
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Recommended
            </span>
          </p>
          <p className="text-xs text-muted-foreground truncate">
            Access 100+ models with one connection — managed credits, no key
            juggling.
          </p>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() => connect()}
      >
        {isPending ? "Connecting…" : "Connect Deco"}
      </Button>
    </div>
  );
}
