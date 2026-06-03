import { Button } from "@deco/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { ChevronDown } from "@untitledui/icons";
import { publishToBaseLabel } from "./publish-label.ts";

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
  const publishLabel = publishToBaseLabel(baseBranch);
  return (
    <div className="inline-flex items-stretch rounded-md">
      <Button
        size="sm"
        variant="success"
        className="rounded-r-none border-r border-success-foreground/20"
        disabled={disabled}
        onClick={() => void onPublish()}
      >
        {loading ? <Spinner size="xs" variant="default" /> : null}
        {publishLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="success"
            className="rounded-l-none px-2"
            disabled={disabled}
            aria-label="More actions"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onReview ? (
            <DropdownMenuItem onClick={onReview}>Review</DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
