import {
  BarChart10,
  CheckCircle,
  GitBranch01,
  MessageChatCircle,
  Minus,
  Plus,
  ShoppingCart01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { useHomeEdit } from "./home-edit-context";
import { NATIVE_TILES, nativeCandidateId } from "./native-tiles";
import { SectionHeader } from "./section-header";
import { useT } from "@/web/i18n/use-t.ts";

const NATIVE_TILE_ICON: Record<string, typeof MessageChatCircle> = {
  tasks: CheckCircle,
  coding: GitBranch01,
  analytics: BarChart10,
  sales: ShoppingCart01,
  "recent-conversations": MessageChatCircle,
};

/**
 * Built-in (native) tiles — views like recent conversations that aren't
 * agents. Normal built-ins ride the board's `hidden` set; `defaultHidden`
 * ones (off the board by default) ride the `shown` set. Toggling here stages
 * into the same edit draft the rest of the board uses.
 */
export function NativeTilesSection() {
  const t = useT();
  const { layout, commitLayout } = useHomeEdit();
  const hidden = new Set(layout.hidden);
  const shown = new Set(layout.shown ?? []);

  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeader title={t("home.nativeTilesSection.builtInTiles")} />
      {NATIVE_TILES.map((tile) => {
        const candidateId = nativeCandidateId(tile.id);
        const onHome = tile.defaultHidden
          ? shown.has(candidateId) && !hidden.has(candidateId)
          : !hidden.has(candidateId);
        const Icon = NATIVE_TILE_ICON[tile.id] ?? MessageChatCircle;

        const toggle = () => {
          if (tile.defaultHidden) {
            // Off-by-default tile: membership is the `shown` set. Adding also
            // clears any lingering `hidden` entry; removing drops it from shown.
            commitLayout({
              ...layout,
              hidden: layout.hidden.filter((id) => id !== candidateId),
              shown: onHome
                ? (layout.shown ?? []).filter((id) => id !== candidateId)
                : [...(layout.shown ?? []), candidateId],
            });
            return;
          }
          commitLayout({
            ...layout,
            hidden: onHome
              ? [...layout.hidden, candidateId]
              : layout.hidden.filter((id) => id !== candidateId),
          });
        };

        return (
          <div
            key={tile.id}
            className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {t(tile.titleKey)}
            </span>
            <Button
              type="button"
              size="sm"
              variant={onHome ? "outline" : "special"}
              className="h-8 gap-1.5"
              onClick={toggle}
            >
              {onHome ? <Minus size={14} /> : <Plus size={14} />}
              {onHome
                ? t("home.nativeTilesSection.remove")
                : t("home.nativeTilesSection.add")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
