import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ChevronDown } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { publishToBaseLabel } from "./publish-label.ts";
import { TOUR_ANCHORS } from "@/components/cms-tour/anchors";

interface Props {
  /** PR base branch (e.g. main) — controls publish button copy. */
  baseBranch: string;
  disabled: boolean;
  loading?: boolean;
  onPublish: () => void | Promise<void>;
  onReview?: () => void;
}

/**
 * Split-style merge action: Publish squash-merges via GitHub MCP; Review still
 * uses the chat agent for a read-only review pass.
 */
export function MergeSplitButton({
  baseBranch,
  disabled,
  loading = false,
  onPublish,
  onReview,
}: Props) {
  const t = useT();
  const publishLabel = publishToBaseLabel(baseBranch, t);
  return (
    <div className="inline-flex items-stretch rounded-md">
      <Button
        size="sm"
        variant="brand"
        className="rounded-r-none border-r border-brand-foreground/20"
        disabled={disabled}
        data-tour={TOUR_ANCHORS.publish}
        onClick={() => void onPublish()}
      >
        {loading ? <Spinner size="xs" variant="default" /> : null}
        {publishLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="brand"
            className="rounded-l-none px-2"
            disabled={disabled}
            aria-label={t("thread.mergeSplitButton.moreActionsAriaLabel")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onReview ? (
            <DropdownMenuItem onClick={onReview}>
              {t("thread.mergeSplitButton.review")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
