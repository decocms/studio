import {
  DropdownMenuContent,
  DropdownMenuItem,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Users03 } from "@untitledui/icons";
import { GitHubIcon } from "@/components/icons/github-icon";
import { useT } from "@/i18n/use-t.ts";

interface CreateAgentDropdownContentProps {
  onCreateFromScratch: () => void;
  onImportGitHub: () => void;
  onImportDeco: () => void;
  isCreating?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  showBetaBadge?: boolean;
}

export function CreateAgentDropdownContent({
  onCreateFromScratch,
  onImportGitHub,
  onImportDeco,
  isCreating,
  align = "end",
  side,
  showBetaBadge,
}: CreateAgentDropdownContentProps) {
  const t = useT();

  return (
    <DropdownMenuContent side={side} align={align} className="w-48">
      <DropdownMenuItem disabled={isCreating} onClick={onCreateFromScratch}>
        <Users03 size={14} />
        {t("common.createAgentDropdown.createFromScratch")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onImportGitHub}>
        <GitHubIcon className="size-3.5" />
        {t("common.createAgentDropdown.importFromGitHub")}
        {showBetaBadge && (
          <span className="ml-auto text-[10px] font-medium text-muted-foreground bg-muted rounded px-1 py-0.5">
            Beta
          </span>
        )}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onImportDeco}>
        <img src="/logos/deco%20logo.svg" alt="deco.cx" className="size-3.5" />
        {t("common.createAgentDropdown.importFromDeco")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
