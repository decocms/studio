import type { ReactNode } from "react";
import { Label } from "@deco/ui/components/label.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { useT } from "@/web/i18n/use-t.ts";
import { isSeoEnabled, isSeoLazyRender } from "./seo-lazy-render";

const ASYNC_RENDER_DOCS_URL =
  "https://deco.cx/docs/en/performance/edge-async-render";

interface SeoFormChromeProps {
  rawSeo: unknown;
  onEnableChange: (enabled: boolean) => void;
  onAsyncRenderChange: (enabled: boolean) => void;
  children?: ReactNode;
}

/** Page SEO chrome — Enable SEO + optional form + Async render (admin parity). */
export function SeoFormChrome({
  rawSeo,
  onEnableChange,
  onAsyncRenderChange,
  children,
}: SeoFormChromeProps) {
  const t = useT();
  const enabled = isSeoEnabled(rawSeo);
  const asyncRender = isSeoLazyRender(rawSeo);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="seo-enable" className="text-sm font-medium">
          {t("sectionsEditor.seoFormChrome.enableLabel")}
        </Label>
        <Switch
          id="seo-enable"
          checked={enabled}
          onCheckedChange={onEnableChange}
        />
      </div>

      {enabled && (
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
      )}
    </div>
  );
}
