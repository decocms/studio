import {
  Code01,
  Copy01,
  CreditCardSearch,
  DotsHorizontal,
  Edit01,
  Flag01,
  Trash01,
} from "@untitledui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useT } from "@/i18n/use-t.ts";

export function ItemActions({
  onDuplicate,
  onRename,
  onAddVariant,
  onEditSeo,
  onViewJson,
  onDelete,
}: {
  onDuplicate?: () => void;
  onRename?: () => void;
  onAddVariant?: () => void;
  onEditSeo?: () => void;
  onViewJson?: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("sandbox.itemActions.moreActions")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <DotsHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Edit01 size={14} />
            {t("sandbox.itemActions.rename")}
          </DropdownMenuItem>
        )}
        {onDuplicate && (
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy01 size={14} />
            {t("sandbox.itemActions.duplicate")}
          </DropdownMenuItem>
        )}
        {onAddVariant && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onAddVariant}
              className="cursor-pointer text-success focus:text-success"
            >
              <Flag01 size={14} />
              {t("sandbox.itemActions.addVariant")}
            </DropdownMenuItem>
          </>
        )}
        {(onEditSeo || onViewJson) && (
          <>
            <DropdownMenuSeparator />
            {onEditSeo && (
              <DropdownMenuItem onClick={onEditSeo}>
                <CreditCardSearch size={14} />
                {t("sandbox.itemActions.editSeo")}
              </DropdownMenuItem>
            )}
            {onViewJson && (
              <DropdownMenuItem onClick={onViewJson}>
                <Code01 size={14} />
                {t("sandbox.itemActions.viewJson")}
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash01 size={14} />
          {t("sandbox.itemActions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
