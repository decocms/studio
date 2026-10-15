import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ChevronDown, Globe01, LinkExternal01 } from "@untitledui/icons";
import { usePreviewProbe } from "@/hooks/use-preview-probe";
import { useT } from "@/i18n/use-t.ts";
import { previewRouteUrl } from "./preview-routes";

/**
 * The "Open preview" button, enabled only once the preview URL actually answers.
 *
 * A preview deploy is regularly still building — or already torn down — while
 * the PR still advertises its URL, so the plain link sent people to a 404. The
 * status can only be read server-side (CORS makes a cross-origin response
 * opaque to the browser), so this blocks on `usePreviewProbe` and offers the
 * link only on a < 400.
 */
export function PreviewButton({
  url,
  routes,
}: {
  url: string;
  routes: string[];
}) {
  const t = useT();
  const { data, isPending, isError } = usePreviewProbe(url);
  const available = data?.available ?? false;

  if (isPending) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled
      >
        <Spinner className="size-[14px]" />
        {t("taskBoard.taskDialog.previewLabel")}
      </Button>
    );
  }

  if (!available || isError) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled
        title={t("taskBoard.taskDialog.previewUnavailableTitle")}
      >
        <Globe01 size={14} />
        {t("taskBoard.taskDialog.previewUnavailable")}
      </Button>
    );
  }

  const link = (
    <Button
      asChild
      type="button"
      variant="outline"
      size="sm"
      className={cn("gap-1.5", routes.length > 0 && "rounded-r-none")}
    >
      <a href={url} target="_blank" rel="noreferrer">
        <Globe01 size={14} />
        {t("taskBoard.taskDialog.previewLabel")}
        <LinkExternal01 size={12} />
      </a>
    </Button>
  );

  if (routes.length === 0) return link;

  // Button keeps opening the preview root; the caret offers the run's pages.
  return (
    <div className="flex items-center">
      {link}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-l-none border-l-0 px-1.5"
            aria-label={t("taskBoard.taskDialog.previewRoutesLabel")}
            title={t("taskBoard.taskDialog.previewRoutesLabel")}
          >
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {routes.map((route) => (
            <DropdownMenuItem key={route} asChild>
              <a
                href={previewRouteUrl(url, route)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs"
              >
                {route}
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
