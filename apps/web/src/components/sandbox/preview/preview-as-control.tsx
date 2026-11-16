import { Clock } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import {
  DATE_INPUT_SCHEME,
  isoToLocalInput,
  localInputToIso,
} from "@/components/sections-editor/named-rule-picker";
import type { HostedBlocksLoad } from "@/cms/hosted-content";
import {
  hasPreviewOptions,
  type PreviewOptions,
} from "@/components/sections-editor/preview-link";
import { useT } from "@/i18n/use-t.ts";

/**
 * "Preview as" on a Blocks (v8) site: the moment the preview shows (so
 * campaigns run as they will then) and, per A/B test, on or off. Both go into
 * the preview link only (preview-link.ts): the published site and its
 * visitors never change. Clicking a test's active side again lets the visit
 * decide once more.
 *
 * On a hosted draft the editor holds only the index's stub of the
 * `experiments` block until a view loads it, so the control asks for it when
 * it opens (`onOpen`) and lists the tests only once it is loaded (`load`), as
 * the rule picker does: never "No A/B tests yet" for a site that has some.
 */
export function PreviewAsControl({
  tests,
  load,
  onOpen,
  options,
  onChange,
  available,
}: {
  /** The site's A/B tests, by name. */
  tests: string[];
  /** The load of the `experiments` block; absent when it is always there. */
  load?: HostedBlocksLoad;
  /** The popover opened: load what it lists. */
  onOpen?: () => void;
  options: PreviewOptions;
  onChange: (next: PreviewOptions) => void;
  /** Whether the preview can carry them now (a draft or a release to show). */
  available: boolean;
}) {
  const t = useT();
  const active = hasPreviewOptions(options);
  const forced = options.tests ?? {};

  const setAt = (local: string) => {
    const at = local ? localInputToIso(local) : null;
    const { at: _previous, ...rest } = options;
    onChange(at ? { ...rest, at } : rest);
  };
  const setTest = (name: string, value: string) => {
    const next = { ...forced };
    if (value === "on") next[name] = true;
    else if (value === "off") next[name] = false;
    else delete next[name];
    const { tests: _previous, ...rest } = options;
    onChange(Object.keys(next).length > 0 ? { ...rest, tests: next } : rest);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ToolbarIconButton
              aria-label={t("sandbox.previewAs.label")}
              active={active}
              data-testid="preview-as-trigger"
            >
              <Clock size={16} />
            </ToolbarIconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("sandbox.previewAs.label")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="flex w-80 flex-col gap-4 p-4"
        align="center"
        sideOffset={8}
        data-testid="preview-as"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            {t("sandbox.previewAs.label")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {available
              ? t("sandbox.previewAs.intro")
              : t("sandbox.previewAs.unavailable")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="preview-as-moment">
            {t("sandbox.previewAs.momentLabel")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="preview-as-moment"
              type="datetime-local"
              className={DATE_INPUT_SCHEME}
              value={isoToLocalInput(options.at)}
              onChange={(e) => setAt(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={options.at === undefined}
              onClick={() => setAt("")}
            >
              {t("sandbox.previewAs.now")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("sandbox.previewAs.momentHint")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            {t("sandbox.previewAs.testsLabel")}
          </span>
          {load && !load.ready ? (
            load.failed ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.previewAs.testsLoadFailed")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={load.retry}
                >
                  {t("sandbox.previewAs.tryAgain")}
                </Button>
              </div>
            ) : (
              <div
                className="flex justify-center py-2"
                data-testid="preview-as-tests-loading"
              >
                <Spinner className="size-4 text-muted-foreground" />
              </div>
            )
          ) : tests.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("sandbox.previewAs.noTests")}
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {tests.map((name) => (
                  <li
                    key={name}
                    className="flex items-center justify-between gap-2"
                    data-testid="preview-as-test"
                  >
                    <span className="min-w-0 truncate text-sm">{name}</span>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      value={
                        forced[name] === undefined
                          ? ""
                          : forced[name]
                            ? "on"
                            : "off"
                      }
                      onValueChange={(value) => setTest(name, value)}
                      aria-label={name}
                    >
                      <ToggleGroupItem value="off">
                        {t("sandbox.previewAs.off")}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="on">
                        {t("sandbox.previewAs.on")}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.previewAs.testsHint")}
              </p>
            </>
          )}
        </div>
        {active && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange({})}
          >
            {t("sandbox.previewAs.reset")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
