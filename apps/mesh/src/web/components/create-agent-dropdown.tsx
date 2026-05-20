import {
  DropdownMenuContent,
  DropdownMenuItem,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Globe02, Users03 } from "@untitledui/icons";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import { SHOPIFY_HYDROGEN_ICON } from "@/web/hooks/use-create-website-agent";
import { usePreferences } from "@/web/hooks/use-preferences.ts";

interface CreateAgentDropdownContentProps {
  onCreateFromScratch: () => void;
  onCreateWebsite: () => void;
  onCreateHydrogenStore: () => void;
  onImportGitHub: () => void;
  onImportDeco: () => void;
  isCreating?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  showBetaBadge?: boolean;
}

export function CreateAgentDropdownContent({
  onCreateFromScratch,
  onCreateWebsite,
  onCreateHydrogenStore,
  onImportGitHub,
  onImportDeco,
  isCreating,
  align = "end",
  side,
  showBetaBadge,
}: CreateAgentDropdownContentProps) {
  const [preferences] = usePreferences();

  return (
    <DropdownMenuContent side={side} align={align} className="w-48">
      <DropdownMenuItem disabled={isCreating} onClick={onCreateFromScratch}>
        <Users03 size={14} />
        Create from scratch
      </DropdownMenuItem>
      <DropdownMenuItem disabled={isCreating} onClick={onCreateWebsite}>
        <Globe02 size={14} />
        Create Website
      </DropdownMenuItem>
      <DropdownMenuItem disabled={isCreating} onClick={onCreateHydrogenStore}>
        <img
          src={SHOPIFY_HYDROGEN_ICON}
          alt=""
          className="size-3.5 object-contain"
        />
        Create Shopify Headless Store
      </DropdownMenuItem>
      {preferences.experimental_vibecode && (
        <DropdownMenuItem onClick={onImportGitHub}>
          <GitHubIcon className="size-3.5" />
          Import from GitHub
          {showBetaBadge && (
            <span className="ml-auto text-[10px] font-medium text-muted-foreground bg-muted rounded px-1 py-0.5">
              Beta
            </span>
          )}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onImportDeco}>
        <img src="/logos/deco%20logo.svg" alt="deco.cx" className="size-3.5" />
        Import from deco.cx
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
