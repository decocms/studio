import type { ReactNode } from "react";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { useNewBlocksEditor } from "@/hooks/use-new-blocks-editor";
import { useT } from "@/i18n/use-t.ts";
import { isSeoEnabled, isSeoLazyRender } from "./seo-lazy-render";

const ASYNC_RENDER_DOCS_URL =
  "https://deco.cx/docs/en/performance/edge-async-render";

interface SeoFormChromeProps {
  rawSeo: unknown;
  onEnableChange: (enabled: boolean) => void;
  /** Unset where async rendering doesn't exist (v8): no switch is offered. */
  onAsyncRenderChange?: (enabled: boolean) => void;
  /**
   * SEO can't be turned on (no SEO type, or the schema is still loading): the
   * switch is off. Turning SEO off stays possible.
   */
  enableUnavailable?: boolean;
  /** Says why SEO can't be turned on, under the switch. */
  enableUnavailableHint?: string;
  children?: ReactNode;
}

/** Page SEO chrome — Enable SEO plus the form it gates. Classic also carries
 *  the async-render switch here; compact moves async rendering onto the
 *  section row's menu, so SEO is only SEO. */
export function SeoFormChrome({
  rawSeo,
  onEnableChange,
  onAsyncRenderChange,
  enableUnavailable: cannotEnable = false,
  enableUnavailableHint,
  children,
}: SeoFormChromeProps) {
  const t = useT();
  const compact = useNewBlocksEditor();
  const enabled = isSeoEnabled(rawSeo);
  const asyncRender = isSeoLazyRender(rawSeo);
  const enableUnavailable = !enabled && cannotEnable;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="seo-enable" className="text-sm font-medium">
          {t("sectionsEditor.seoFormChrome.enableLabel")}
        </Label>
        <Switch
          id="seo-enable"
          checked={enabled}
          disabled={enableUnavailable}
          aria-describedby={
            enableUnavailable && enableUnavailableHint
              ? "seo-enable-hint"
              : undefined
          }
          onCheckedChange={onEnableChange}
        />
      </div>
      {enableUnavailable && enableUnavailableHint && (
        <p
          id="seo-enable-hint"
          className="text-xs leading-normal text-muted-foreground"
        >
          {enableUnavailableHint}
        </p>
      )}

      {enabled &&
        (compact || !onAsyncRenderChange ? (
          children
        ) : (
          <>
            {children}
            <div className="flex items-start justify-between gap-3 border-t pt-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  {t("sectionsEditor.seoFormChrome.asyncRenderLabel")}
                </p>
                <p className="text-xs leading-normal text-muted-foreground">
                  {/* TODO(i18n): rich text - link in middle of sentence */}
                  Render SEO asynchronously with edge caching. Learn more in our{" "}
                  <a
                    href={ASYNC_RENDER_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {t("sectionsEditor.seoFormChrome.documentationLinkText")}
                  </a>
                  .
                </p>
              </div>
              <Switch
                id="seo-async-render"
                checked={asyncRender}
                onCheckedChange={onAsyncRenderChange}
                className="shrink-0"
              />
            </div>
          </>
        ))}
    </div>
  );
}
