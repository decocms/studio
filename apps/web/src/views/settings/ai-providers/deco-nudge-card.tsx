import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useDecoConnect } from "./use-deco-connect";

export function DecoNudgeCard() {
  const t = useT();
  const { mutate: connect, isPending } = useDecoConnect();

  return (
    <div className="relative rounded-xl border border-border overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: [
            "radial-gradient(ellipse 50% 150% at -15% 50%, rgba(165,149,255,0.14) 0%, transparent 60%)",
            "radial-gradient(ellipse 50% 150% at 115% 50%, rgba(208,236,26,0.11) 0%, transparent 60%)",
          ].join(", "),
        }}
      />
      <div className="relative flex items-center gap-5 px-6 py-5">
        <img
          src="/logos/deco%20logo.svg"
          alt={t("settings.decoNudgeCard.decoAiGateway")}
          className="size-12 shrink-0 rounded-xl object-contain dark:bg-white dark:p-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-base font-semibold">
              {t("settings.decoNudgeCard.decoAiGateway")}
            </p>
            <span className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("settings.decoNudgeCard.recommended")}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("settings.decoNudgeCard.description")}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={isPending}
          onClick={() => connect()}
        >
          {isPending
            ? t("settings.decoNudgeCard.connecting")
            : t("settings.decoNudgeCard.connectDeco")}
        </Button>
      </div>
    </div>
  );
}
